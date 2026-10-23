import { BASE } from './api'

/** What a clip can hold in KV: up to 25 MB a file and 50 MB in total. Bigger sets go to the file bucket. */
export const KV_FILE_MAX = 25 * 1024 * 1024
export const KV_TOTAL_MAX = 50 * 1024 * 1024
/** What one upload (and one clip) can hold in the file bucket. */
export const MAX_TOTAL_BYTES = 500 * 1024 * 1024
export const MAX_FILES = 500
/** Files are deleted this long after they are uploaded. */
export const FILE_LIFETIME_HOURS = 2

export interface BigFileInfo {
  slug: string
  name: string
  size: number
  type: string
  status: 'uploading' | 'ready'
  expiresAt: number | null
  files?: { n: number; name: string; size: number; type: string }[]
}

interface StartResponse {
  slug: string
  token: string
  files: { n: number; mode: 'single' | 'multipart'; partSize: number; partCount: number }[]
  signBatch: number
}

export class BigUploadError extends Error {
  code: string
  constructor(code: string, message?: string) {
    super(message ?? code)
    this.code = code
  }
}

/** Several pieces go up at once: a few files in parallel, or a few parts of one big file. */
const PARALLEL_PUTS = 4
const ATTEMPTS = 4

/** True when these files are more than a clip keeps in KV, so they go to the file bucket instead. */
export function needsFileBucket(files: { size: number }[]): boolean {
  const total = files.reduce((a, f) => a + f.size, 0)
  return files.some((f) => f.size > KV_FILE_MAX) || total > KV_TOTAL_MAX
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
function putPiece(url: string, blob: Blob, onBytes: (sent: number) => void, signal?: AbortSignal): Promise<string> {
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

async function putPieceWithRetry(url: string, blob: Blob, onBytes: (sent: number) => void, signal?: AbortSignal): Promise<string> {
  let last: unknown
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await putPiece(url, blob, onBytes, signal)
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
 * Sends files straight to the file bucket, each as its own object (nothing is wrapped or zipped), and returns the
 * upload id and the token that lets this browser attach it to a clip. `onProgress` receives 0..100.
 */
export async function uploadToFileBucket(files: File[], onProgress: (pct: number) => void, signal?: AbortSignal): Promise<{ slug: string; token: string }> {
  const total = files.reduce((a, f) => a + f.size, 0)
  const start = await postJson<StartResponse>('/api/big/start', { files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })) })
  const headers = { 'x-manage-token': start.token }

  try {
    // Every piece of every file, in order; links are fetched a batch of files at a time as the queue reaches them
    const tasks: { n: number; part: number; blob: Blob }[] = []
    start.files.forEach((plan, i) => {
      const file = files[i]!
      for (let p = 0; p < plan.partCount; p++) {
        const from = p * plan.partSize
        tasks.push({ n: plan.n, part: p + 1, blob: file.slice(from, Math.min(file.size, from + plan.partSize)) })
      }
    })
    const urls = new Map<number, string[]>()
    const signing = new Map<number, Promise<void>>()
    const urlFor = async (n: number, part: number): Promise<string> => {
      if (!urls.has(n)) {
        if (!signing.has(n)) {
          const batch = start.files.map((f) => f.n).filter((x) => x >= n && !urls.has(x) && !signing.has(x)).slice(0, start.signBatch)
          const job = postJson<{ urls: Record<string, string[]> }>(`/api/big/${start.slug}/sign`, { files: batch }, headers)
            .then((r) => { for (const [k, v] of Object.entries(r.urls)) urls.set(Number(k), v) })
          for (const x of batch) signing.set(x, job)
        }
        await signing.get(n)
      }
      const list = urls.get(n)
      if (!list?.[part - 1]) throw new BigUploadError('storage_error', 'missing upload link')
      return list[part - 1]!
    }

    const sentBy = new Map<string, number>()
    const report = () => onProgress(Math.min(99, ([...sentBy.values()].reduce((a, b) => a + b, 0) / Math.max(1, total)) * 100))
    const etags = new Map<number, string[]>()
    let next = 0
    const worker = async () => {
      while (next < tasks.length) {
        const t = tasks[next++]!
        const id = `${t.n}:${t.part}`
        const url = await urlFor(t.n, t.part)
        const etag = await putPieceWithRetry(url, t.blob, (b) => { sentBy.set(id, b); report() }, signal)
        sentBy.set(id, t.blob.size)
        report()
        const list = etags.get(t.n) ?? []
        list[t.part - 1] = etag
        etags.set(t.n, list)
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL_PUTS, tasks.length) }, worker))

    const multipart = start.files.filter((f) => f.mode === 'multipart').map((f) => ({ n: f.n, parts: (etags.get(f.n) ?? []).map((etag, i) => ({ n: i + 1, etag })) }))
    // Storage can be a moment behind right after an upload: finishing is safe to repeat, so ask a few times
    for (let attempt = 1; ; attempt++) {
      try {
        await postJson(`/api/big/${start.slug}/complete`, { files: multipart }, headers)
        break
      } catch (err) {
        const retryable = err instanceof BigUploadError && (err.code === 'storage_busy' || err.code === 'network_error')
        if (!retryable || attempt >= 5) throw err
        await new Promise((r) => setTimeout(r, 1500 * attempt))
      }
    }
  } catch (err) {
    discardUpload(start.slug, start.token)
    throw err
  }
  onProgress(100)
  return { slug: start.slug, token: start.token }
}

/** Throw away an upload that was not attached to a clip (the clip could not be created, or the upload failed). */
export function discardUpload(slug: string, token: string): void {
  fetch(`${BASE}/api/big/${encodeURIComponent(slug)}`, { method: 'DELETE', headers: { 'x-manage-token': token } }).catch(() => undefined)
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

export type DownloadAnswer = { url: string } | { error: 'download_limit' | 'rate_limited' | 'gone' | 'failed' }

/** Asks for one file's download link first, so a problem on the storage side can be explained instead of shown as an error page. */
export async function requestBigDownload(slug: string, n = 1, inline = false): Promise<DownloadAnswer> {
  try {
    const res = await fetch(`${BASE}/api/big/${encodeURIComponent(slug)}/download?json=1&n=${n}${inline ? '&inline=1' : ''}`)
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

export function downloadProblem(error: Exclude<DownloadAnswer, { url: string }>['error']): string {
  return error === 'download_limit' ? 'Downloads of large files are paused for today because the daily download limit was reached. Please try again tomorrow.'
    : error === 'rate_limited' ? 'Too many download attempts. Please wait a couple of minutes and try again.'
    : error === 'gone' ? 'These files have been deleted.'
    : 'Could not start the download. Check your connection and try again.'
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
