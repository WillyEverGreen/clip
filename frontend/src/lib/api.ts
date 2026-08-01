const LIVE_WORKER_URL = 'https://clip-worker.saibalkawade10.workers.dev'
const isLocal = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
const BASE = import.meta.env.VITE_API_URL || (isLocal ? '' : LIVE_WORKER_URL)

export interface PublicEntry {
  slug: string
  type: 'text' | 'file'
  content?: string
  fileName?: string
  fileMime?: string
  fileSize?: number
  hasFile?: boolean
  createdAt: number
  updatedAt?: number
  expiresAt: number
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

// ── File download URL ─────────────────────────────────────────────────────────
export function fileUrl(slug: string): string {
  return `${BASE}/api/entry/${slug}/file`
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
