const LIVE_WORKER_URL = 'https://clip-worker.saibalkawade10.workers.dev'
const isLocal = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
export const BASE = import.meta.env.VITE_API_URL || (isLocal ? '' : LIVE_WORKER_URL)

// Public-facing origin used for CLI commands shown to users.
// Uses the browser's current domain (clip.foo.ng in prod, localhost in dev)
// so commands always show the clean public URL, not the internal worker URL.
const PUBLIC_ORIGIN = typeof window !== 'undefined' ? window.location.origin : 'https://clip.foo.ng'

export interface FileItem {
  id: string
  fileName: string
  fileMime: string
  fileSize: number
}

export interface PublicEntry {
  slug: string
  type: 'text' | 'file'
  content?: string
  fileName?: string
  fileMime?: string
  fileSize?: number
  hasFile?: boolean
  files?: FileItem[]
  createdAt: number
  updatedAt?: number
  expiresAt: number
  fileExpiresAt?: number
  views?: number
  isPermanent?: boolean
}

export interface CreateResponse { slug: string; expiresAt: number }
export interface ApiError       { error: string; retryAfter?: number }


// ── Create ────────────────────────────────────────────────────────────────────
export async function createEntry(data: FormData): Promise<CreateResponse> {
  const res = await fetch(`${BASE}/api/entry`, { method: 'POST', body: data })
  const json = await res.json()
  if (!res.ok) throw json as ApiError
  return json as CreateResponse
}

/**
 * Like createEntry but reports upload progress via onProgress(0..100).
 * Falls back to plain fetch if XHR is unavailable.
 */
export function createEntryWithProgress(
  data: FormData,
  onProgress: (pct: number) => void,
): Promise<CreateResponse> {
  return xhrUpload<CreateResponse>(`${BASE}/api/entry`, 'POST', data, onProgress)
}

/**
 * Like updateEntry but reports upload progress via onProgress(0..100).
 */
export function updateEntryWithProgress(
  slug: string,
  data: FormData,
  onProgress: (pct: number) => void,
): Promise<void> {
  return xhrUpload<void>(`${BASE}/api/entry/${slug}`, 'PATCH', data, onProgress)
}

/** Generic XHR wrapper with upload progress */
function xhrUpload<T>(url: string, method: string, data: FormData, onProgress: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(method, url)

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    })

    xhr.addEventListener('load', () => {
      onProgress(100)
      let json: T | ApiError
      try { 
        json = JSON.parse(xhr.responseText) as T | ApiError
      } catch { 
        json = { error: 'parse_error' } as ApiError
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(json as T)
      } else {
        reject(json as ApiError)
      }
    })

    xhr.addEventListener('error', () => reject({ error: 'network_error' } as ApiError))
    xhr.addEventListener('timeout', () => reject({ error: 'timeout' } as ApiError))

    xhr.send(data)
  })
}

// ── Read ──────────────────────────────────────────────────────────────────────
export async function getEntry(slug: string, cacheBust?: string, isPoll?: boolean): Promise<PublicEntry | null> {
  let url = `${BASE}/api/entry/${slug}`
  const params = new URLSearchParams()
  if (cacheBust) params.append('_t', cacheBust)
  if (isPoll) params.append('poll', 'true')
  
  const queryString = params.toString()
  if (queryString) {
    url += `?${queryString}`
  }

  const res = await fetch(url, {
    // Bypass browser HTTP cache to always get the freshest data
    cache: 'no-store',
  })
  if (res.status === 404) return null
  // 304 Not Modified — no body to parse; caller should keep existing data
  if (res.status === 304) return null
  if (!res.ok) throw await res.json()
  return res.json()
}

// ── Public-facing CLI URL helpers (use the user's domain, not the internal worker URL) ───────
export function fileUrl(slug: string, fileId?: string): string {
  return fileId
    ? `${PUBLIC_ORIGIN}/f/${slug}?id=${encodeURIComponent(fileId)}`
    : `${PUBLIC_ORIGIN}/f/${slug}`
}

export function rawUrl(slug: string): string {
  return `${PUBLIC_ORIGIN}/r/${slug}`
}

export function zipUrl(slug: string): string {
  return `${PUBLIC_ORIGIN}/z/${slug}.zip`
}

// ── Live Pad API Helpers ───────────────────────────────────────────────────────
export function liveFileDownloadUrl(slug: string, fileId: string, mime?: string, name?: string): string {
  const q = new URLSearchParams()
  if (mime) q.set('mime', mime)
  if (name) q.set('name', name)
  const query = q.toString() ? `?${q.toString()}` : ''
  return `${BASE}/api/live/${slug}/file/${fileId}${query}`
}

export async function uploadLiveFile(
  slug: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<FileItem> {
  const form = new FormData()
  form.append('file', file, file.name)

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE}/api/live/${slug}/upload`)

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    })

    xhr.addEventListener('load', () => {
      if (onProgress) onProgress(100)
      interface UploadResponse {
        ok: boolean
        file: FileItem
      }
      let json: UploadResponse | ApiError
      try { 
        json = JSON.parse(xhr.responseText) as UploadResponse | ApiError
      } catch { 
        json = { error: 'parse_error' } as ApiError
      }
      if (xhr.status >= 200 && xhr.status < 300 && 'file' in json) {
        resolve(json.file)
      } else {
        reject(json as ApiError)
      }
    })

    xhr.addEventListener('error', () => reject({ error: 'network_error' } as ApiError))
    xhr.addEventListener('timeout', () => reject({ error: 'timeout' } as ApiError))

    xhr.send(form)
  })
}

export interface LiveStateResponse {
  text: string
  files: FileItem[]
  peers: number
  isProtected?: boolean
  salt?: string
  error?: string
}

export function liveZipDownloadUrl(slug: string): string {
  return `${BASE}/api/live/${slug}/zip`
}

export async function deleteLiveFile(slug: string, fileId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/live/${slug}/file/${fileId}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    const json = await res.json().catch(() => ({}))
    throw json
  }
}

export async function batchDeleteLiveFiles(slug: string, fileIds: string[]): Promise<void> {
  const res = await fetch(`${BASE}/api/live/${slug}/files/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds }),
  })
  if (!res.ok) {
    const json = await res.json().catch(() => ({}))
    throw json
  }
}

export async function setLiveSecurity(
  slug: string,
  isProtected: boolean,
  authHash?: string,
  salt?: string,
): Promise<{ ok: boolean; isProtected: boolean }> {
  const res = await fetch(`${BASE}/api/live/${slug}/security`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isProtected, authHash, salt }),
  })
  if (!res.ok) throw await res.json().catch(() => ({ error: 'security_failed' }))
  return res.json()
}

export async function seedLiveRoom(
  slug: string,
  text?: string,
  files?: FileItem[],
  security?: { isProtected: boolean; authHash?: string; salt?: string },
): Promise<void> {
  const res = await fetch(`${BASE}/api/live/${slug}/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, files, security }),
  })
  if (!res.ok) throw await res.json().catch(() => ({ error: 'seed_failed' }))
}

export async function getLiveState(slug: string): Promise<LiveStateResponse> {
  const res = await fetch(`${BASE}/api/live/${slug}?_t=${Date.now()}`, {
    cache: 'no-store',
  })
  if (!res.ok) throw await res.json()
  return res.json()
}

/**
 * Requests a guaranteed-unique, production-grade slug from the worker.
 * The server checks KV paste collisions, RESERVED words, and previously issued
 * Live Pad slugs before atomically claiming the slug for 30 days.
 *
 * Falls back to a cryptographically-secure client-side slug (10 chars, base-36)
 * when the network is unavailable, so the UI never blocks.
 */
export async function getUniqueLiveSlug(): Promise<string> {
  try {
    const res = await fetch(`${BASE}/api/live/new-slug`, { cache: 'no-store' })
    if (res.ok) {
      const json = await res.json() as { slug?: string }
      if (json.slug && typeof json.slug === 'string') return json.slug
    }
  } catch {
    // Network unavailable — fall through to local fallback
  }
  // Cryptographically secure offline fallback (never Math.random)
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes).map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 10)
}




// ── Verify edit code ──────────────────────────────────────────────────────────
export async function verifyEditCode(slug: string, editCode: string): Promise<boolean> {
  const res = await fetch(`${BASE}/api/entry/${slug}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ editCode }),
  })
  const json = await res.json()
  return json.valid === true
}

// ── Update ────────────────────────────────────────────────────────────────────
export async function updateEntry(slug: string, data: FormData): Promise<void> {
  const res = await fetch(`${BASE}/api/entry/${slug}`, { method: 'PATCH', body: data })
  const json = await res.json()
  if (!res.ok) throw json as ApiError
}

// ── Delete ────────────────────────────────────────────────────────────────────
export async function deleteEntry(slug: string, editCode: string): Promise<void> {
  const res = await fetch(`${BASE}/api/entry/${slug}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ editCode }),
  })
  if (!res.ok) throw await res.json()
}

// ── Admin ─────────────────────────────────────────────────────────────────────
export interface AdminStats {
  totalViews: number
  textCount: number
  fileCount: number
  totalBytes: number
}

export interface AdminListResponse {
  total: number
  stats: AdminStats
  entries: PublicEntry[]
}

export async function fetchAdminEntries(adminKey: string): Promise<AdminListResponse> {
  const res = await fetch(`${BASE}/api/admin/entries?key=${encodeURIComponent(adminKey)}`, {
    headers: { 'Authorization': `Bearer ${adminKey}` },
  })
  const json = await res.json()
  if (!res.ok) throw json as ApiError
  return json as AdminListResponse
}

export async function adminDeleteEntry(slug: string, adminKey: string): Promise<void> {
  const res = await fetch(`${BASE}/api/admin/entry/${slug}?key=${encodeURIComponent(adminKey)}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${adminKey}` },
  })
  const json = await res.json()
  if (!res.ok) throw json as ApiError
}

export async function adminPurgeAllEntries(adminKey: string): Promise<number> {
  const res = await fetch(`${BASE}/api/admin/purge`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${adminKey}` },
  })
  const json = await res.json()
  if (!res.ok) throw json as ApiError
  return json.deletedCount || 0
}

// ── Helpers ───────────────────────────────────────────────────────────────────
export function formatBytes(bytes: number): string {
  if (bytes < 1024)        return `${bytes} B`
  if (bytes < 1024 ** 2)   return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3)   return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export function formatLocalDate(timestamp: number): string {
  const d = new Date(timestamp)
  const day = d.getDate().toString().padStart(2, '0')
  const month = d.toLocaleString('en-US', { month: 'short' })
  const year = d.getFullYear()
  const hours = d.getHours().toString().padStart(2, '0')
  const minutes = d.getMinutes().toString().padStart(2, '0')

  const offsetMinutes = -d.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absOffset = Math.abs(offsetMinutes)
  const tzHours = Math.floor(absOffset / 60).toString().padStart(2, '0')
  const tzMins = (absOffset % 60).toString().padStart(2, '0')
  const tzStr = `GMT${sign}${parseInt(tzHours, 10)}${tzMins !== '00' ? `:${tzMins}` : ''}`

  return `${day} ${month} ${year} ${hours}:${minutes} ${tzStr}`
}
