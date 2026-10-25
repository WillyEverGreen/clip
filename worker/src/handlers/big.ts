import type { Context } from 'hono'
import type { Env } from '../lib/types'
import { checkRateLimit, getClientIp } from '../lib/rateLimit'
import { presign, s3Fetch, drain, type S3Config } from '../lib/s3sign'
import { md5Base64 } from '../lib/md5'
import {
  BIG_TOTAL_CAP_BYTES, FILE_TTL_SECONDS, SIGN_BATCH, UPLOAD_GRACE_MS, parseStartRequest, planUpload, makeSlug, makeManageToken,
  hashToken, makeObjectKey, folderOf, normalizeRecord, isExpired, publicView, attachmentDisposition, parseCompleteRequest,
  completeMultipartXml, parseUploadId, parseVersions, deleteObjectsXml, type BigRecord, type BigFile, type StoredVersion,
} from '../lib/big'

type Ctx = Context<{ Bindings: Env }>

const PREFIX = 'big:'
const SLUG_RE = /^[a-z2-9]{10}$/
/** Signed upload links are good for this long: enough for a slow connection to send a big file. */
const UPLOAD_LINK_SECONDS = 6 * 3600
const DOWNLOAD_LINK_SECONDS = 300
/** The sweep deletes at most this many uploads per run, so one run stays within the worker's request budget. */
const SWEEP_MAX_DELETES = 12

export function s3Config(env: Env): S3Config | null {
  if (!env.B2_KEY_ID || !env.B2_APP_KEY || !env.B2_BUCKET || !env.B2_S3_ENDPOINT || !env.B2_REGION) return null
  return { endpoint: env.B2_S3_ENDPOINT, region: env.B2_REGION, bucket: env.B2_BUCKET, keyId: env.B2_KEY_ID, secret: env.B2_APP_KEY }
}

function store(env: Env, id: string) {
  return env.BIG_DO.get(env.BIG_DO.idFromName(id))
}

/** The record lives in a Durable Object (always the latest write); uploads started before that move are read from KV. */
async function getRecord(env: Env, id: string): Promise<BigRecord | null> {
  const fresh = normalizeRecord(await store(env, id).getRec())
  if (fresh) return fresh
  return normalizeRecord(await env.PASTE_KV.get(PREFIX + id, 'json'))
}

async function putRecord(env: Env, rec: BigRecord): Promise<void> {
  await store(env, rec.slug).putRec(rec)
  // KV keeps an index for listing: the sweep and the storage cap read sizes and expiry from its metadata
  const lifeMs = rec.status === 'ready' && rec.expiresAt ? rec.expiresAt - Date.now() : UPLOAD_GRACE_MS
  await env.PASTE_KV.put(PREFIX + rec.slug, '1', {
    expirationTtl: Math.max(60, Math.ceil(lifeMs / 1000) + 24 * 3600),
    metadata: { size: rec.size, status: rec.status, exp: rec.expiresAt, created: rec.createdAt },
  })
}

async function forgetRecord(env: Env, id: string): Promise<void> {
  await store(env, id).deleteRec()
  await env.PASTE_KV.delete(PREFIX + id)
}

async function tokenMatches(rec: BigRecord, token: string | undefined | null): Promise<boolean> {
  return !!token && (await hashToken(token)) === rec.tokenHash
}

/** Total bytes currently held (uploading or ready). */
async function storedBytes(env: Env): Promise<number> {
  let total = 0
  let cursor: string | undefined
  do {
    const page = await env.PASTE_KV.list<{ size?: number }>({ prefix: PREFIX, cursor })
    for (const k of page.keys) total += k.metadata?.size ?? 0
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return total
}

/** Every stored version (and delete marker) under a prefix. A listing is not a download, so it works whatever the daily download allowance. */
async function listVersions(cfg: S3Config, prefix: string): Promise<StoredVersion[] | null> {
  const out: StoredVersion[] = []
  let keyMarker: string | null = null
  let versionMarker: string | null = null
  for (let page = 0; page < 5; page++) {
    const q: Record<string, string> = { versions: '', prefix }
    if (keyMarker) q['key-marker'] = keyMarker
    if (versionMarker) q['version-id-marker'] = versionMarker
    let res: Response
    try { res = await s3Fetch(cfg, 'GET', '', q) } catch { return null }
    if (!res.ok) { await drain(res); return null }
    const parsed = parseVersions(await res.text())
    out.push(...parsed.versions)
    if (!parsed.truncated) return out
    keyMarker = parsed.nextKey
    versionMarker = parsed.nextVersion
  }
  return out
}

/** Permanently delete these versions, a thousand per request. (A plain delete would only hide a file and keep the data.) */
async function deleteVersions(cfg: S3Config, items: { key: string; versionId: string }[]): Promise<void> {
  for (let i = 0; i < items.length; i += 1000) {
    const xml = deleteObjectsXml(items.slice(i, i + 1000))
    const res = await s3Fetch(cfg, 'POST', '', { delete: '' }, xml, new Date(), { 'Content-MD5': md5Base64(xml) })
    if (!res.ok) throw new Error(`delete ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
    await drain(res)
  }
}

/** Remove everything stored for an upload (all files, all versions), and give up any multipart upload still open. */
async function purgeUpload(cfg: S3Config, rec: BigRecord): Promise<void> {
  for (const f of rec.files) {
    if (f.uploadId) await s3Fetch(cfg, 'DELETE', f.key, { uploadId: f.uploadId }).then(drain).catch(() => undefined)
  }
  const versions = await listVersions(cfg, folderOf(rec.slug))
  if (!versions) throw new Error('list failed')
  if (versions.length) await deleteVersions(cfg, versions.map((v) => ({ key: v.key, versionId: v.versionId })))
}

async function destroy(env: Env, cfg: S3Config, rec: BigRecord): Promise<void> {
  await purgeUpload(cfg, rec)
  await forgetRecord(env, rec.slug)
}

// ── Used by clips (create / edit / delete) ────────────────────────────────────

export type ClaimError = 'bundle_not_found' | 'bundle_forbidden' | 'bundle_not_ready' | 'bundle_taken' | 'big_unavailable'

/**
 * Attach a finished upload to a clip. The uploader proves it is theirs with the token; from then on the clip owns it
 * and the files are deleted at `expiresAt`.
 */
export async function claimUpload(env: Env, id: string, token: string | null, entrySlug: string, expiresAt: number): Promise<BigRecord | { error: ClaimError }> {
  if (!s3Config(env)) return { error: 'big_unavailable' }
  if (!SLUG_RE.test(id)) return { error: 'bundle_not_found' }
  const rec = await getRecord(env, id)
  if (!rec || isExpired(rec)) return { error: 'bundle_not_found' }
  if (!(await tokenMatches(rec, token))) return { error: 'bundle_forbidden' }
  if (rec.status !== 'ready') return { error: 'bundle_not_ready' }
  if (rec.entrySlug && rec.entrySlug !== entrySlug) return { error: 'bundle_taken' }
  const claimed: BigRecord = { ...rec, entrySlug, expiresAt }
  await putRecord(env, claimed)
  return claimed
}

/** Delete an upload completely (the clip was deleted, or its files replaced). Never throws: the sweep and the bucket rule catch leftovers. */
export async function releaseUpload(env: Env, id: string): Promise<void> {
  const cfg = s3Config(env)
  if (!cfg || !SLUG_RE.test(id)) return
  // Delete by folder even if the record cannot be read: the files belong to this id whatever the record says
  const rec = (await getRecord(env, id).catch(() => null)) ?? { slug: id, status: 'ready', files: [], size: 0, createdAt: 0, expiresAt: null, tokenHash: '' } satisfies BigRecord
  await destroy(env, cfg, rec).catch((err) => console.error('release upload failed', id, err))
}

/** Delete some files of an upload (the clip's owner removed them), keeping the rest. */
export async function removeUploadFiles(env: Env, id: string, numbers: number[]): Promise<BigRecord | null> {
  const cfg = s3Config(env)
  if (!cfg || !SLUG_RE.test(id)) return null
  const rec = await getRecord(env, id)
  if (!rec) return null
  const drop = new Set(numbers)
  const keys = new Set(rec.files.filter((f) => drop.has(f.n)).map((f) => f.key))
  const versions = await listVersions(cfg, folderOf(rec.slug))
  if (!versions) throw new Error('list failed')
  const doomed = versions.filter((v) => keys.has(v.key))
  if (doomed.length) await deleteVersions(cfg, doomed.map((v) => ({ key: v.key, versionId: v.versionId })))
  const files = rec.files.filter((f) => !drop.has(f.n))
  if (files.length === 0) {
    await forgetRecord(env, rec.slug)
    return { ...rec, files: [], size: 0 }
  }
  const kept: BigRecord = { ...rec, files, size: files.reduce((a, f) => a + f.size, 0) }
  await putRecord(env, kept)
  return kept
}

// ── POST /api/big/start ───────────────────────────────────────────────────────

export async function handleBigStart(c: Ctx) {
  const cfg = s3Config(c.env)
  if (!cfg) return c.json({ error: 'big_unavailable' }, 503)
  const ip = getClientIp(c.req.raw)
  const rl = await checkRateLimit(c.env.PASTE_KV, 'big:start', ip)
  if (rl.limited) return c.json({ error: 'rate_limited', retryAfter: rl.retryAfter }, 429, { 'Retry-After': String(rl.retryAfter ?? 120) })

  let body: unknown
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid_json' }, 400) }
  const parsed = parseStartRequest(body)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)
  const total = parsed.files.reduce((a, f) => a + f.size, 0)

  if ((await storedBytes(c.env)) + total > BIG_TOTAL_CAP_BYTES) {
    return c.json({ error: 'storage_full', message: 'File storage is full right now. Try again in a little while.' }, 507)
  }

  const id = makeSlug()
  const token = makeManageToken()
  const files: BigFile[] = []
  for (let i = 0; i < parsed.files.length; i++) {
    const f = parsed.files[i]!
    const n = i + 1
    const key = makeObjectKey(id, n, f.name)
    const plan = planUpload(f.size)
    let uploadId: string | null = null
    if (plan.mode === 'multipart') {
      const res = await s3Fetch(cfg, 'POST', key, { uploads: '' }).catch(() => null)
      uploadId = res ? parseUploadId(await res.text().catch(() => '')) : null
      if (!res?.ok || !uploadId) {
        // Give back whatever was already opened
        await purgeUpload(cfg, { slug: id, status: 'uploading', files, size: 0, createdAt: Date.now(), expiresAt: null, tokenHash: '' }).catch(() => undefined)
        return c.json({ error: 'storage_error' }, 502)
      }
    }
    files.push({ n, name: f.name, size: f.size, type: f.type, key, uploadId, partCount: plan.partCount })
  }

  await putRecord(c.env, { slug: id, status: 'uploading', files, size: total, createdAt: Date.now(), expiresAt: null, tokenHash: await hashToken(token) })
  return c.json({
    slug: id,
    token,
    files: files.map((f) => ({ n: f.n, mode: f.uploadId ? 'multipart' : 'single', partSize: planUpload(f.size).partSize, partCount: f.partCount })),
    signBatch: SIGN_BATCH,
  }, 201)
}

// ── POST /api/big/:id/sign  — upload links for some files ────────────────────

export async function handleBigSign(c: Ctx) {
  const cfg = s3Config(c.env)
  if (!cfg) return c.json({ error: 'big_unavailable' }, 503)
  const id = c.req.param('slug') ?? ''
  if (!SLUG_RE.test(id)) return c.json({ error: 'not_found' }, 404)
  const rec = await getRecord(c.env, id)
  if (!rec) return c.json({ error: 'not_found' }, 404)
  if (!(await tokenMatches(rec, c.req.header('x-manage-token')))) return c.json({ error: 'forbidden' }, 403)
  if (rec.status !== 'uploading' || isExpired(rec)) return c.json({ error: 'not_uploading' }, 409)
  let body: { files?: unknown }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid_json' }, 400) }
  const wanted = Array.isArray(body.files) ? body.files : []
  if (wanted.length === 0 || wanted.length > SIGN_BATCH) return c.json({ error: 'invalid_request' }, 400)
  const urls: Record<string, string[]> = {}
  for (const n of wanted) {
    const f = rec.files.find((x) => x.n === n)
    if (!f) return c.json({ error: 'invalid_request' }, 400)
    const list: string[] = []
    for (let p = 1; p <= f.partCount; p++) {
      list.push(f.uploadId
        ? await presign(cfg, 'PUT', f.key, { partNumber: String(p), uploadId: f.uploadId }, UPLOAD_LINK_SECONDS)
        : await presign(cfg, 'PUT', f.key, {}, UPLOAD_LINK_SECONDS))
    }
    urls[String(f.n)] = list
  }
  return c.json({ urls })
}

// ── POST /api/big/:id/complete ────────────────────────────────────────────────

export async function handleBigComplete(c: Ctx) {
  const cfg = s3Config(c.env)
  if (!cfg) return c.json({ error: 'big_unavailable' }, 503)
  const id = c.req.param('slug') ?? ''
  if (!SLUG_RE.test(id)) return c.json({ error: 'not_found' }, 404)
  const rec = await getRecord(c.env, id)
  if (!rec) return c.json({ error: 'not_found' }, 404)
  if (!(await tokenMatches(rec, c.req.header('x-manage-token')))) return c.json({ error: 'forbidden' }, 403)
  if (rec.status === 'ready') return c.json(publicView(rec))
  if (isExpired(rec)) return c.json({ error: 'expired' }, 410)

  let body: unknown = {}
  try { body = await c.req.json() } catch { /* single-piece files need no body */ }
  const parts = parseCompleteRequest(body, rec)
  if (!parts) return c.json({ error: 'invalid_parts' }, 400)

  for (const f of rec.files) {
    const list = parts.get(f.n)
    if (!f.uploadId || !list) continue
    let res: Response
    try { res = await s3Fetch(cfg, 'POST', f.key, { uploadId: f.uploadId }, completeMultipartXml(list)) } catch { return c.json({ error: 'storage_busy' }, 503) }
    // B2 can answer 200 with an error inside the body, so read it
    const answer = await res.text().catch(() => '')
    // A repeat after a dropped connection finds the upload already assembled: that is fine, the size check below decides
    const alreadyDone = /NoSuchUpload/.test(answer)
    if (!alreadyDone && (!res.ok || /<Error>/.test(answer))) return c.json({ error: 'storage_error', n: f.n }, 502)
    // Assembled: remember it, so asking to finish again (after a busy answer below) does not repeat this step
    f.uploadId = null
    await putRecord(c.env, rec)
  }

  // Check what actually landed against what was announced, for every file. Storage can lag a moment after an upload.
  let stored: Map<string, number> | null = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    const versions = await listVersions(cfg, folderOf(rec.slug))
    if (versions) {
      stored = new Map(versions.filter((v) => v.isLatest && !v.deleteMarker).map((v) => [v.key, v.size]))
      if (rec.files.every((f) => stored!.has(f.key))) break
    }
    await new Promise((r) => setTimeout(r, 400 * attempt))
  }
  const missing = rec.files.filter((f) => !stored?.has(f.key))
  if (missing.length) return c.json({ error: 'storage_busy', missing: missing.map((f) => f.n) }, 503)
  const wrong = rec.files.find((f) => stored!.get(f.key) !== f.size)
  if (wrong) {
    await destroy(c.env, cfg, rec).catch(() => undefined)
    return c.json({ error: 'size_mismatch', n: wrong.n, announced: wrong.size, stored: stored!.get(wrong.key) }, 400)
  }

  const ready: BigRecord = { ...rec, status: 'ready', expiresAt: Date.now() + FILE_TTL_SECONDS * 1000 }
  await putRecord(c.env, ready)
  return c.json(publicView(ready))
}

// ── GET /api/big/:id ──────────────────────────────────────────────────────────

export async function handleBigInfo(c: Ctx) {
  const id = c.req.param('slug') ?? ''
  if (!SLUG_RE.test(id)) return c.json({ error: 'not_found' }, 404)
  const rec = await getRecord(c.env, id)
  if (!rec || rec.status !== 'ready') return c.json({ error: 'not_found' }, 404)
  if (isExpired(rec)) return c.json({ error: 'expired' }, 410)
  c.header('Cache-Control', 'no-store')
  return c.json(publicView(rec))
}

// ── GET /api/big/:id/download?n=1 ─────────────────────────────────────────────

export async function handleBigDownload(c: Ctx) {
  const cfg = s3Config(c.env)
  if (!cfg) return c.json({ error: 'big_unavailable' }, 503)
  const id = c.req.param('slug') ?? ''
  if (!SLUG_RE.test(id)) return c.json({ error: 'not_found' }, 404)
  const rec = await getRecord(c.env, id)
  if (!rec || rec.status !== 'ready') return c.json({ error: 'not_found' }, 404)
  if (isExpired(rec)) return c.json({ error: 'expired' }, 410)
  const n = Number(c.req.query('n') ?? '1')
  const file = rec.files.find((f) => f.n === n)
  if (!file) return c.json({ error: 'not_found' }, 404)
  const rl = await checkRateLimit(c.env.PASTE_KV, 'big:dl', getClientIp(c.req.raw))
  if (rl.limited) return c.json({ error: 'rate_limited', retryAfter: rl.retryAfter }, 429, { 'Retry-After': String(rl.retryAfter ?? 120) })
  // `inline=1` is for the page's own "Download all", which reads the bytes itself; otherwise always saved as a file
  const query: Record<string, string> = c.req.query('inline') === '1' ? {} : {
    'response-content-disposition': attachmentDisposition(file.name),
    'response-content-type': 'application/octet-stream',
  }
  const url = await presign(cfg, 'GET', file.key, query, DOWNLOAD_LINK_SECONDS)
  c.header('Cache-Control', 'no-store')
  if (c.req.query('json') === '1') {
    // The page asks first, so a used-up daily download allowance becomes a clear message instead of a storage error page
    const probe = await s3Fetch(cfg, 'GET', file.key, {}, undefined, new Date(), { Range: 'bytes=0-0' }).catch(() => null)
    if (!probe) return c.json({ url, name: file.name, size: file.size }) // could not check: let the browser try
    const text = probe.ok ? '' : await probe.text().catch(() => '')
    if (probe.ok) await drain(probe)
    if (probe.status === 403 && /download_cap_exceeded|cap exceeded/i.test(text)) return c.json({ error: 'download_limit' }, 503)
    return c.json({ url, name: file.name, size: file.size })
  }
  return c.redirect(url, 302)
}

// ── DELETE /api/big/:id ───────────────────────────────────────────────────────

export async function handleBigDelete(c: Ctx) {
  const cfg = s3Config(c.env)
  if (!cfg) return c.json({ error: 'big_unavailable' }, 503)
  const id = c.req.param('slug') ?? ''
  if (!SLUG_RE.test(id)) return c.json({ error: 'not_found' }, 404)
  const rec = await getRecord(c.env, id)
  if (!rec) return c.json({ error: 'not_found' }, 404)
  if (!(await tokenMatches(rec, c.req.header('x-manage-token')))) return c.json({ error: 'forbidden' }, 403)
  // Once attached to a clip, the clip's edit code decides (delete the clip or remove its files instead)
  if (rec.entrySlug) return c.json({ error: 'attached' }, 409)
  try {
    await destroy(c.env, cfg, rec)
  } catch {
    return c.json({ error: 'storage_error' }, 502)
  }
  return c.json({ ok: true })
}

// ── Scheduled sweep: delete what has expired ──────────────────────────────────

export async function sweepBigFiles(env: Env, now = Date.now()): Promise<{ checked: number; deleted: number; failed: number }> {
  const cfg = s3Config(env)
  const out = { checked: 0, deleted: 0, failed: 0 }
  if (!cfg) return out
  let cursor: string | undefined
  do {
    const page = await env.PASTE_KV.list<{ status?: string; exp?: number | null; created?: number }>({ prefix: PREFIX, cursor })
    for (const k of page.keys) {
      out.checked++
      if (out.deleted + out.failed >= SWEEP_MAX_DELETES) return out // the next run carries on
      const m = k.metadata
      // Skip fetching records the listing already shows are alive
      if (m && m.status && !isExpired({ status: m.status === 'ready' ? 'ready' : 'uploading', expiresAt: m.exp ?? null, createdAt: m.created ?? now }, now)) continue
      const rec = await getRecord(env, k.name.slice(PREFIX.length))
      if (!rec || !isExpired(rec, now)) continue
      try {
        await destroy(env, cfg, rec)
        out.deleted++
      } catch {
        out.failed++ // try again next run; the bucket's own rule removes it within days regardless
      }
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return out
}
