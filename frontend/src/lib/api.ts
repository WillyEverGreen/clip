const LIVE_WORKER_URL = 'https://clip-worker.saibalkawade10.workers.dev'
const isLocal = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
const BASE = import.meta.env.VITE_API_URL || (isLocal ? '' : LIVE_WORKER_URL)

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

// ── Read ──────────────────────────────────────────────────────────────────────
export async function getEntry(slug: string): Promise<PublicEntry | null> {
  const res = await fetch(`${BASE}/api/entry/${slug}`)
  if (res.status === 404) return null
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
