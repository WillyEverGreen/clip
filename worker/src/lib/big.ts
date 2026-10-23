/**
 * Large files: anything over the 25 MB share limit goes straight from the browser to a private
 * bucket, in parts, and is deleted on a timer. This module holds the pure rules (limits, naming,
 * validation, XML), so they can be tested without a network.
 */

export const MB = 1024 * 1024
/** Files above this use the large-file path; at or below it the normal share flow handles them. */
export const BIG_MIN_BYTES = 25 * MB
export const BIG_MAX_BYTES = 500 * MB
/** All large files together may not exceed this while they are stored. */
export const BIG_TOTAL_CAP_BYTES = 8 * 1024 * MB
/** Up to this size one PUT is enough; above it the file is sent in parts. */
export const SINGLE_PUT_MAX = 100 * MB
export const PART_SIZE = 64 * MB
/** How long a file lives after it finishes uploading. */
export const TTL_CHOICES = [3600, 6 * 3600, 24 * 3600] as const
export const DEFAULT_TTL = 6 * 3600
/** An upload that never finishes is forgotten after this long. */
export const UPLOAD_GRACE_MS = 3 * 3600 * 1000

export interface BigRecord {
  slug: string
  key: string
  name: string
  size: number
  type: string
  status: 'uploading' | 'ready'
  ttl: number
  createdAt: number
  /** Set once the upload finishes: when the file will be deleted. */
  expiresAt: number | null
  uploadId: string | null
  versionId: string | null
  /** SHA-256 of the manage token the uploader holds (so they can delete early). */
  tokenHash: string
}

export interface StartRequest {
  name: string
  size: number
  type: string
  ttl: number
}

export type StartError = 'invalid_request' | 'too_small' | 'too_large' | 'bad_ttl'

/** Strip anything that could be a path or a control character; keep it readable and short. */
export function cleanFileName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : ''
  // eslint-disable-next-line no-control-regex
  const base = s.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop()!.trim()
  const trimmed = base.replace(/^\.+/, '').slice(0, 150)
  return trimmed || 'file'
}

export function parseStartRequest(body: unknown): { ok: true; value: StartRequest } | { ok: false; error: StartError } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'invalid_request' }
  const b = body as Record<string, unknown>
  const size = b.size
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return { ok: false, error: 'invalid_request' }
  if (size <= BIG_MIN_BYTES) return { ok: false, error: 'too_small' }
  if (size > BIG_MAX_BYTES) return { ok: false, error: 'too_large' }
  const ttl = b.ttl === undefined ? DEFAULT_TTL : b.ttl
  if (typeof ttl !== 'number' || !(TTL_CHOICES as readonly number[]).includes(ttl)) return { ok: false, error: 'bad_ttl' }
  const type = typeof b.type === 'string' && b.type.length <= 100 ? b.type : ''
  return { ok: true, value: { name: cleanFileName(b.name), size, type, ttl } }
}

export interface UploadPlan {
  mode: 'single' | 'multipart'
  partSize: number
  partCount: number
}

export function planUpload(size: number): UploadPlan {
  if (size <= SINGLE_PUT_MAX) return { mode: 'single', partSize: size, partCount: 1 }
  return { mode: 'multipart', partSize: PART_SIZE, partCount: Math.ceil(size / PART_SIZE) }
}

const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

function randomChars(n: number, alphabet: string): string {
  const buf = new Uint8Array(n)
  crypto.getRandomValues(buf)
  let out = ''
  for (const b of buf) out += alphabet[b % alphabet.length]
  return out
}

export function makeSlug(): string {
  return randomChars(10, SLUG_ALPHABET)
}

export function makeManageToken(): string {
  return randomChars(32, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
}

export async function hashToken(token: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The object key in the bucket: random per upload, with a tidy readable tail. */
export function makeObjectKey(slug: string, name: string): string {
  const tail = name.normalize('NFKD').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').replace(/\.{2,}/g, '.').slice(-80) || 'file'
  return `big/${slug}/${randomChars(8, SLUG_ALPHABET)}-${tail}`
}

export function isExpired(rec: Pick<BigRecord, 'status' | 'expiresAt' | 'createdAt'>, now = Date.now()): boolean {
  if (rec.status === 'ready') return rec.expiresAt !== null && now >= rec.expiresAt
  return now - rec.createdAt >= UPLOAD_GRACE_MS
}

/** What a visitor may learn about a file: never the storage key or the upload id. */
export function publicView(rec: BigRecord) {
  return { slug: rec.slug, name: rec.name, size: rec.size, type: rec.type, status: rec.status, expiresAt: rec.expiresAt }
}

/** Content-Disposition that forces a download, with a safe ASCII fallback name. */
export function attachmentDisposition(name: string): string {
  const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\;]/g, '_').trim() || 'file'
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`
}

export interface CompletedPart {
  n: number
  etag: string
}

export function parseParts(raw: unknown, expectedCount: number): CompletedPart[] | null {
  if (!Array.isArray(raw) || raw.length !== expectedCount) return null
  const parts: CompletedPart[] = []
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i] as { n?: unknown; etag?: unknown }
    if (p?.n !== i + 1 || typeof p.etag !== 'string' || p.etag.length === 0 || p.etag.length > 200) return null
    parts.push({ n: p.n, etag: p.etag })
  }
  return parts
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function completeMultipartXml(parts: CompletedPart[]): string {
  const body = parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`).join('')
  return `<CompleteMultipartUpload>${body}</CompleteMultipartUpload>`
}

export function parseUploadId(xml: string): string | null {
  const m = xml.match(/<UploadId>([^<]+)<\/UploadId>/)
  return m ? m[1]! : null
}
