import { BASE } from './api'

/** Files above this go through the large-file path (they would not fit a normal share). */
export const BIG_MIN_BYTES = 25 * 1024 * 1024
export const BIG_MAX_BYTES = 500 * 1024 * 1024
/** How long a large file is kept, in seconds. */
export const BIG_TTL_CHOICES = [
  { value: 3600, label: '1 Hour' },
  { value: 21600, label: '6 Hours (Default)' },
  { value: 86400, label: '1 Day' },
] as const

export interface BigFileInfo {
  slug: string
  name: string
  size: number
  type: string
  status: 'uploading' | 'ready'
  expiresAt: number | null
}

interface StartResponse {
  slug: string
  token: string
  mode: 'single' | 'multipart'
  partSize: number
  urls: string[]
}

export class BigUploadError extends Error {
  code: string
  constructor(code: string, message?: string) {
    super(message ?? code)
    this.code = code
  }
}

const PARALLEL_PARTS = 3
const ATTEMPTS = 4

export function isBigFile(file: { size: number }): boolean {
  return file.size > BIG_MIN_BYTES
}

async function postJson<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  } catch {
    throw new BigUploadError('network_error')
  }
  const json = await res.json().catch(() => ({})) as { error?: string }
  if (!res.ok) throw new BigUploadError(json.error ?? 'internal_error')
  return json as T
}

/** PUT one piece straight to the bucket, reporting bytes sent. Resolves with the ETag the bucket returned. */
function putPart(url: string, blob: Blob, onBytes: (sent: number) => void, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onBytes(e.loaded) }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader('ETag') ?? '')
      else reject(new BigUploadError('storage_error', `storage answered ${xhr.status}`))
    }
    xhr.onerror = () => reject(new BigUploadError('network_error'))
    xhr.ontimeout = () => reject(new BigUploadError('timeout'))
    xhr.onabort = () => reject(new BigUploadError('aborted'))
    signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(blob)
  })
}

async function putPartWithRetry(url: string, blob: Blob, onBytes: (sent: number) => void, signal?: AbortSignal): Promise<string> {
  let last: unknown
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await putPart(url, blob, onBytes, signal)
    } catch (err) {
      last = err
      onBytes(0)
      if (signal?.aborted || (err instanceof BigUploadError && err.code === 'aborted')) throw err
      await new Promise((r) => setTimeout(r, 800 * attempt))
    }
  }
  throw last
}

/**
 * Sends a large file straight to storage and returns its link id and the token that lets the sender delete it early.
 * `onProgress` receives 0..100. Parts go up a few at a time and each is retried, so one bad moment does not cost the whole file.
 */
export async function uploadBig(
  file: File,
  ttl: number,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<{ slug: string; token: string }> {
  const start = await postJson<StartResponse>('/api/big/start', { name: file.name, size: file.size, type: file.type, ttl })
  const sent = new Array<number>(start.urls.length).fill(0)
  const report = () => onProgress(Math.min(99, (sent.reduce((a, b) => a + b, 0) / file.size) * 100))
  const etags: string[] = new Array(start.urls.length).fill('')
  let next = 0

  const worker = async () => {
    while (next < start.urls.length) {
      const i = next++
      const from = i * start.partSize
      const blob = file.slice(from, Math.min(file.size, from + start.partSize))
      etags[i] = await putPartWithRetry(start.urls[i]!, blob, (n) => { sent[i] = n; report() }, signal)
      sent[i] = blob.size
      report()
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, start.urls.length) }, worker))
  } catch (err) {
    // Tell the server to forget the half-finished upload
    fetch(`${BASE}/api/big/${start.slug}`, { method: 'DELETE', headers: { 'x-manage-token': start.token } }).catch(() => undefined)
    throw err
  }

  // Storage can be a moment behind right after an upload: finishing is safe to repeat, so ask a few times
  for (let attempt = 1; ; attempt++) {
    try {
      await postJson(`/api/big/${start.slug}/complete`, start.mode === 'multipart' ? { parts: etags.map((etag, i) => ({ n: i + 1, etag })) } : {}, { 'x-manage-token': start.token })
      break
    } catch (err) {
      const retryable = err instanceof BigUploadError && (err.code === 'storage_busy' || err.code === 'network_error')
      if (!retryable || attempt >= 5) {
        fetch(`${BASE}/api/big/${start.slug}`, { method: 'DELETE', headers: { 'x-manage-token': start.token } }).catch(() => undefined)
        throw err
      }
      await new Promise((r) => setTimeout(r, 1500 * attempt))
    }
  }
  onProgress(100)
  return { slug: start.slug, token: start.token }
}

export async function getBigInfo(slug: string): Promise<{ info: BigFileInfo | null; state: 'ok' | 'gone' | 'error' }> {
  try {
    const res = await fetch(`${BASE}/api/big/${encodeURIComponent(slug)}`)
    if (res.status === 404 || res.status === 410) return { info: null, state: 'gone' }
    if (!res.ok) return { info: null, state: 'error' }
    return { info: await res.json() as BigFileInfo, state: 'ok' }
  } catch {
    return { info: null, state: 'error' }
  }
}

/** Asks for the download link first, so a problem on the storage side can be explained instead of shown as an error page. */
export async function requestBigDownload(slug: string): Promise<{ url: string } | { error: 'download_limit' | 'rate_limited' | 'gone' | 'failed' }> {
  try {
    const res = await fetch(`${BASE}/api/big/${encodeURIComponent(slug)}/download?json=1`)
    if (res.status === 404 || res.status === 410) return { error: 'gone' }
    const json = await res.json().catch(() => ({})) as { url?: string; error?: string }
    if (res.ok && json.url) return { url: json.url }
    if (json.error === 'download_limit') return { error: 'download_limit' }
    if (res.status === 429) return { error: 'rate_limited' }
    return { error: 'failed' }
  } catch {
    return { error: 'failed' }
  }
}

export function bigDownloadUrl(slug: string): string {
  return `${BASE}/api/big/${encodeURIComponent(slug)}/download`
}

export async function deleteBig(slug: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/big/${encodeURIComponent(slug)}`, { method: 'DELETE', headers: { 'x-manage-token': token } })
    return res.ok
  } catch {
    return false
  }
}

const TOKEN_KEY = (slug: string) => `clip_big_${slug}`
export function rememberBigToken(slug: string, token: string): void {
  try { localStorage.setItem(TOKEN_KEY(slug), token) } catch { /* storage unavailable */ }
}
export function recallBigToken(slug: string): string | null {
  try { return localStorage.getItem(TOKEN_KEY(slug)) } catch { return null }
}
export function forgetBigToken(slug: string): void {
  try { localStorage.removeItem(TOKEN_KEY(slug)) } catch { /* storage unavailable */ }
}
