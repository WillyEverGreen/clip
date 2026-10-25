/**
 * Files that are too big for a normal share go straight from the browser to a private bucket, one object per file,
 * and are deleted on a timer. This module holds the pure rules (limits, naming, validation, XML), so they can be tested
 * without a network.
 */

export const MB = 1024 * 1024
/** Everything one upload (and one link) may hold. */
export const BIG_MAX_BYTES = 500 * MB
export const BIG_MAX_FILES = 500
/** All stored files together may not exceed this. */
export const BIG_TOTAL_CAP_BYTES = 8 * 1024 * MB
/** Up to this size one PUT is enough; above it the file is sent in parts. */
export const SINGLE_PUT_MAX = 100 * MB
export const PART_SIZE = 64 * MB
/** How long files live after they finish uploading. */
export const FILE_TTL_SECONDS = 2 * 3600
/** An upload that never finishes is forgotten after this long. */
export const UPLOAD_GRACE_MS = 3 * 3600 * 1000
/** How many files' upload links one request may ask for (keeps each request small). */
export const SIGN_BATCH = 50

export interface BigFile {
  n: number
  name: string
  size: number
  type: string
  key: string
  /** Open multipart upload, until it is completed */
  uploadId: string | null
  partCount: number
}

export interface BigRecord {
  slug: string
  status: 'uploading' | 'ready'
  files: BigFile[]
  size: number
  createdAt: number
  /** Set once the upload finishes: when the files will be deleted. */
  expiresAt: number | null
  /** SHA-256 of the token the uploader holds (to finish, attach or delete). */
  tokenHash: string
  /** The clip these files belong to, once attached. */
  entrySlug?: string | null
}

export interface StartFile {
  name: string
  size: number
  type: string
}

export type StartError = 'invalid_request' | 'too_large' | 'too_many' | 'empty'

/** Strip anything that could be a path or a control character; keep it readable and short. */
export function cleanFileName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : ''
  // eslint-disable-next-line no-control-regex
  const base = s.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop()!.trim()
  const trimmed = base.replace(/^\.+/, '').slice(0, 150)
  return trimmed || 'file'
}

function cleanType(raw: unknown): string {
  return typeof raw === 'string' && raw.length <= 100 && /^[\w.+\-/]*$/.test(raw) ? raw : ''
}

/** Accepts `{ files: [{ name, size, type }] }`, or a single `{ name, size, type }` from older pages. */
export function parseStartRequest(body: unknown): { ok: true; files: StartFile[] } | { ok: false; error: StartError } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'invalid_request' }
  const b = body as Record<string, unknown>
  const list = Array.isArray(b.files) ? b.files : 'size' in b ? [b] : null
  if (!list) return { ok: false, error: 'invalid_request' }
  if (list.length === 0) return { ok: false, error: 'empty' }
  if (list.length > BIG_MAX_FILES) return { ok: false, error: 'too_many' }
  const files: StartFile[] = []
  let total = 0
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid_request' }
    const f = raw as Record<string, unknown>
    if (typeof f.size !== 'number' || !Number.isInteger(f.size) || f.size <= 0) return { ok: false, error: 'invalid_request' }
    total += f.size
    files.push({ name: cleanFileName(f.name), size: f.size, type: cleanType(f.type) })
  }
  if (total > BIG_MAX_BYTES) return { ok: false, error: 'too_large' }
  return { ok: true, files }
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

/** Where one file of an upload lives: every file of an upload shares the `big/<id>/` folder. */
export function makeObjectKey(id: string, n: number, name: string): string {
  const tail = name.normalize('NFKD').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').replace(/\.{2,}/g, '.').slice(-80) || 'file'
  return `big/${id}/${n}-${tail}`
}

export function folderOf(id: string): string {
  return `big/${id}/`
}

/** Records written before uploads could hold several files had one file's fields at the top level. */
export function normalizeRecord(raw: unknown): BigRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown> & Partial<BigRecord>
  if (Array.isArray(r.files)) return r as BigRecord
  if (typeof r.key !== 'string') return null
  const size = Number(r.size) || 0
  return {
    slug: String(r.slug), status: r.status === 'ready' ? 'ready' : 'uploading', size, createdAt: Number(r.createdAt) || 0,
    expiresAt: typeof r.expiresAt === 'number' ? r.expiresAt : null, tokenHash: String(r.tokenHash ?? ''), entrySlug: null,
    files: [{ n: 1, name: String(r.name ?? 'file'), size, type: String(r.type ?? ''), key: r.key as string, uploadId: (r.uploadId as string | null) ?? null, partCount: planUpload(size).partCount }],
  }
}

export function isExpired(rec: Pick<BigRecord, 'status' | 'expiresAt' | 'createdAt'>, now = Date.now()): boolean {
  if (rec.status === 'ready') return rec.expiresAt !== null && now >= rec.expiresAt
  return now - rec.createdAt >= UPLOAD_GRACE_MS
}

/** What a visitor may learn: names, sizes and expiry, never storage keys, upload ids or the token hash. */
export function publicView(rec: BigRecord) {
  const first = rec.files[0]
  return {
    slug: rec.slug,
    status: rec.status,
    expiresAt: rec.expiresAt,
    size: rec.size,
    files: rec.files.map((f) => ({ n: f.n, name: f.name, size: f.size, type: f.type })),
    // Older single-file pages read these
    name: rec.files.length === 1 && first ? first.name : `${rec.files.length} files`,
    type: rec.files.length === 1 && first ? first.type : '',
  }
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

/** For each file still being sent in parts, the ETags the bucket returned, keyed by file number. */
export function parseCompleteRequest(body: unknown, rec: BigRecord): Map<number, CompletedPart[]> | null {
  const open = rec.files.filter((f) => f.uploadId)
  const out = new Map<number, CompletedPart[]>()
  if (open.length === 0) return out
  const list = (body && typeof body === 'object' && Array.isArray((body as { files?: unknown }).files)) ? (body as { files: unknown[] }).files : null
  if (!list) return null
  for (const f of open) {
    const entry = list.find((x) => (x as { n?: unknown })?.n === f.n) as { parts?: unknown } | undefined
    const parts = entry ? parseParts(entry.parts, f.partCount) : null
    if (!parts) return null
    out.set(f.n, parts)
  }
  return out
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function xmlUnescape(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

export function completeMultipartXml(parts: CompletedPart[]): string {
  const body = parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`).join('')
  return `<CompleteMultipartUpload>${body}</CompleteMultipartUpload>`
}

export function parseUploadId(xml: string): string | null {
  const m = xml.match(/<UploadId>([^<]+)<\/UploadId>/)
  return m ? m[1]! : null
}

export interface StoredVersion {
  key: string
  versionId: string
  size: number
  isLatest: boolean
  deleteMarker: boolean
}

/** Every version and delete marker in a ListObjectVersions response. */
export function parseVersions(xml: string): { versions: StoredVersion[]; truncated: boolean; nextKey: string | null; nextVersion: string | null } {
  const versions: StoredVersion[] = []
  for (const m of xml.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)) {
    const body = m[2]!
    const key = body.match(/<Key>([^<]*)<\/Key>/)?.[1]
    const versionId = body.match(/<VersionId>([^<]*)<\/VersionId>/)?.[1]
    if (key === undefined || !versionId) continue
    versions.push({
      key: xmlUnescape(key), versionId, size: Number(body.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0),
      isLatest: /<IsLatest>true<\/IsLatest>/.test(body), deleteMarker: m[1] === 'DeleteMarker',
    })
  }
  return {
    versions,
    truncated: /<IsTruncated>true<\/IsTruncated>/.test(xml),
    nextKey: xml.match(/<NextKeyMarker>([^<]*)<\/NextKeyMarker>/)?.[1] ?? null,
    nextVersion: xml.match(/<NextVersionIdMarker>([^<]*)<\/NextVersionIdMarker>/)?.[1] ?? null,
  }
}

/** One request that deletes many object versions at once (up to 1000). */
export function deleteObjectsXml(items: { key: string; versionId: string }[]): string {
  const body = items.map((i) => `<Object><Key>${xmlEscape(i.key)}</Key><VersionId>${xmlEscape(i.versionId)}</VersionId></Object>`).join('')
  return `<Delete><Quiet>true</Quiet>${body}</Delete>`
}
