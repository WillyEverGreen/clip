import type { Context } from 'hono'
import type { Env } from '../lib/types'
import { checkRateLimit, getClientIp } from '../lib/rateLimit'
import { presign, s3Fetch, type S3Config } from '../lib/s3sign'
import {
  BIG_TOTAL_CAP_BYTES, parseStartRequest, planUpload, makeSlug, makeManageToken, hashToken, makeObjectKey, isExpired,
  publicView, attachmentDisposition, parseParts, completeMultipartXml, parseUploadId, UPLOAD_GRACE_MS,
  type BigRecord,
} from '../lib/big'

type Ctx = Context<{ Bindings: Env }>

const PREFIX = 'big:'
const SLUG_RE = /^[a-z2-9]{10}$/
/** Signed upload links are good for this long: enough for a slow connection to send a big file. */
const UPLOAD_LINK_SECONDS = 6 * 3600
const DOWNLOAD_LINK_SECONDS = 300

function s3Config(env: Env): S3Config | null {
  if (!env.B2_KEY_ID || !env.B2_APP_KEY || !env.B2_BUCKET || !env.B2_S3_ENDPOINT || !env.B2_REGION) return null
  return { endpoint: env.B2_S3_ENDPOINT, region: env.B2_REGION, bucket: env.B2_BUCKET, keyId: env.B2_KEY_ID, secret: env.B2_APP_KEY }
}

async function getRecord(env: Env, slug: string): Promise<BigRecord | null> {
  return env.PASTE_KV.get<BigRecord>(PREFIX + slug, 'json')
}

async function putRecord(env: Env, rec: BigRecord): Promise<void> {
  // The list metadata lets the sweep and the storage cap read sizes and expiry without fetching every record
  const lifeMs = rec.status === 'ready' && rec.expiresAt ? rec.expiresAt - Date.now() : UPLOAD_GRACE_MS
  await env.PASTE_KV.put(PREFIX + rec.slug, JSON.stringify(rec), {
    expirationTtl: Math.max(60, Math.ceil(lifeMs / 1000) + 24 * 3600),
    metadata: { size: rec.size, status: rec.status, exp: rec.expiresAt, created: rec.createdAt },
  })
}

async function readXml(res: Response): Promise<string> {
  return res.text().catch(() => '')
}

/**
 * Size and version of what is stored under a key, read from a version listing. A listing is not a download, so it works
 * even when the account's daily download allowance is used up, and it behaves the same on every runtime (a signed HEAD
 * gets a 403 on the deployed Workers runtime). Storage can answer a moment late right after an upload, so a few tries are made.
 */
async function storedObject(cfg: S3Config, key: string): Promise<{ size: number; versionId: string | null } | { retry: number }> {
  let lastStatus = 0
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await s3Fetch(cfg, 'GET', '', { versions: '', prefix: key })
    lastStatus = res.status
    if (res.ok) {
      const xml = await res.text()
      for (const m of xml.matchAll(/<Version>([\s\S]*?)<\/Version>/g)) {
        if (m[1]!.match(/<Key>([^<]*)<\/Key>/)?.[1] !== key) continue
        const size = Number(m[1]!.match(/<Size>(\d+)<\/Size>/)?.[1])
        if (Number.isFinite(size)) return { size, versionId: m[1]!.match(/<VersionId>([^<]*)<\/VersionId>/)?.[1] ?? null }
      }
    }
    await new Promise((r) => setTimeout(r, 400 * attempt))
  }
  return { retry: lastStatus }
}

/**
 * Permanently remove every stored version of an object (and any delete markers). A plain delete on this storage only
 * hides a file and keeps the data, so this lists the versions and deletes each by id.
 */
async function purgeKey(cfg: S3Config, key: string): Promise<void> {
  const res = await s3Fetch(cfg, 'GET', '', { versions: '', prefix: key })
  if (!res.ok) throw new Error(`list ${res.status}`)
  const xml = await res.text()
  const found: string[] = []
  for (const m of xml.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)) {
    const k = m[2]!.match(/<Key>([^<]*)<\/Key>/)?.[1]
    const id = m[2]!.match(/<VersionId>([^<]*)<\/VersionId>/)?.[1]
    if (k === key && id) found.push(id)
  }
  for (const versionId of found) {
    const del = await s3Fetch(cfg, 'DELETE', key, { versionId })
    if (!del.ok && del.status !== 404) throw new Error(`delete ${del.status}`)
  }
}

/** Total bytes of large files currently held (uploading or ready). */
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

/** Remove the stored object permanently (a specific version, so nothing lingers), then the record. */
async function destroy(env: Env, cfg: S3Config, rec: BigRecord): Promise<void> {
  if (rec.status === 'uploading' && rec.uploadId) {
    await s3Fetch(cfg, 'DELETE', rec.key, { uploadId: rec.uploadId }).catch(() => undefined)
  }
  // Ready files must go for sure; for an unfinished upload this also clears an object that was assembled but never confirmed
  if (rec.status === 'ready') await purgeKey(cfg, rec.key)
  else await purgeKey(cfg, rec.key).catch(() => undefined)
  await env.PASTE_KV.delete(PREFIX + rec.slug)
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
  const { name, size, type, ttl } = parsed.value

  if ((await storedBytes(c.env)) + size > BIG_TOTAL_CAP_BYTES) {
    return c.json({ error: 'storage_full', message: 'Large-file storage is full right now. Try again in a little while.' }, 507)
  }

  const slug = makeSlug()
  const key = makeObjectKey(slug, name)
  const plan = planUpload(size)
  const token = makeManageToken()

  let uploadId: string | null = null
  if (plan.mode === 'multipart') {
    const res = await s3Fetch(cfg, 'POST', key, { uploads: '' })
    uploadId = parseUploadId(await readXml(res))
    if (!res.ok || !uploadId) return c.json({ error: 'storage_error' }, 502)
  }

  const urls: string[] = []
  for (let n = 1; n <= plan.partCount; n++) {
    urls.push(plan.mode === 'single'
      ? await presign(cfg, 'PUT', key, {}, UPLOAD_LINK_SECONDS)
      : await presign(cfg, 'PUT', key, { partNumber: String(n), uploadId: uploadId! }, UPLOAD_LINK_SECONDS))
  }

  await putRecord(c.env, {
    slug, key, name, size, type, status: 'uploading', ttl, createdAt: Date.now(), expiresAt: null,
    uploadId, versionId: null, tokenHash: await hashToken(token),
  })
  return c.json({ slug, token, mode: plan.mode, partSize: plan.partSize, urls, ttl }, 201)
}

// ── POST /api/big/:slug/complete ──────────────────────────────────────────────

export async function handleBigComplete(c: Ctx) {
  const cfg = s3Config(c.env)
  if (!cfg) return c.json({ error: 'big_unavailable' }, 503)
  const slug = c.req.param('slug') ?? ''
  if (!SLUG_RE.test(slug)) return c.json({ error: 'not_found' }, 404)
  const rec = await getRecord(c.env, slug)
  if (!rec) return c.json({ error: 'not_found' }, 404)
  if ((await hashToken(c.req.header('x-manage-token') ?? '')) !== rec.tokenHash) return c.json({ error: 'forbidden' }, 403)
  if (rec.status === 'ready') return c.json(publicView(rec))
  if (isExpired(rec)) return c.json({ error: 'expired' }, 410)

  if (rec.uploadId) {
    let body: { parts?: unknown }
    try { body = await c.req.json() } catch { return c.json({ error: 'invalid_json' }, 400) }
    const expected = planUpload(rec.size).partCount
    const parts = parseParts(body.parts, expected)
    if (!parts) return c.json({ error: 'invalid_parts' }, 400)
    const res = await s3Fetch(cfg, 'POST', rec.key, { uploadId: rec.uploadId }, completeMultipartXml(parts))
    if (!res.ok) return c.json({ error: 'storage_error' }, 502)
    // The parts are assembled: remember that, so asking to finish again (after a busy answer below) does not repeat this step
    rec.uploadId = null
    await putRecord(c.env, rec)
  }

  // Check what actually landed against what was announced
  const found = await storedObject(cfg, rec.key)
  if ('retry' in found) {
    // Could not read the stored file yet: keep everything and let the browser ask again
    return c.json({ error: 'storage_busy', status: found.retry }, 503)
  }
  if (found.size !== rec.size) {
    await purgeKey(cfg, rec.key).catch(() => undefined)
    await c.env.PASTE_KV.delete(PREFIX + slug)
    return c.json({ error: 'size_mismatch', announced: rec.size, stored: found.size }, 400)
  }

  const ready: BigRecord = {
    ...rec, status: 'ready', uploadId: null, versionId: found.versionId, expiresAt: Date.now() + rec.ttl * 1000,
  }
  await putRecord(c.env, ready)
  return c.json(publicView(ready))
}

// ── GET /api/big/:slug ────────────────────────────────────────────────────────

export async function handleBigInfo(c: Ctx) {
  const slug = c.req.param('slug') ?? ''
  if (!SLUG_RE.test(slug)) return c.json({ error: 'not_found' }, 404)
  const rec = await getRecord(c.env, slug)
  if (!rec || rec.status !== 'ready') return c.json({ error: 'not_found' }, 404)
  if (isExpired(rec)) return c.json({ error: 'expired' }, 410)
  c.header('Cache-Control', 'no-store')
  return c.json(publicView(rec))
}

// ── GET /api/big/:slug/download ───────────────────────────────────────────────

export async function handleBigDownload(c: Ctx) {
  const cfg = s3Config(c.env)
  if (!cfg) return c.json({ error: 'big_unavailable' }, 503)
  const slug = c.req.param('slug') ?? ''
  if (!SLUG_RE.test(slug)) return c.json({ error: 'not_found' }, 404)
  const rec = await getRecord(c.env, slug)
  if (!rec || rec.status !== 'ready') return c.json({ error: 'not_found' }, 404)
  if (isExpired(rec)) return c.json({ error: 'expired' }, 410)
  const rl = await checkRateLimit(c.env.PASTE_KV, 'big:dl', getClientIp(c.req.raw))
  if (rl.limited) return c.json({ error: 'rate_limited', retryAfter: rl.retryAfter }, 429, { 'Retry-After': String(rl.retryAfter ?? 120) })
  // Always saved as a file, never rendered in the browser from the storage domain
  const url = await presign(cfg, 'GET', rec.key, {
    'response-content-disposition': attachmentDisposition(rec.name),
    'response-content-type': 'application/octet-stream',
  }, DOWNLOAD_LINK_SECONDS)
  c.header('Cache-Control', 'no-store')
  if (c.req.query('json') === '1') {
    // The page asks first, so a used-up daily download allowance becomes a clear message instead of a storage error page
    const probe = await s3Fetch(cfg, 'GET', rec.key, {}, undefined, new Date(), { Range: 'bytes=0-0' })
    const text = probe.ok ? '' : await probe.text().catch(() => '')
    if (probe.body && probe.ok) await probe.body.cancel().catch(() => undefined)
    if (probe.status === 403 && /download_cap_exceeded|cap exceeded/i.test(text)) return c.json({ error: 'download_limit' }, 503)
    return c.json({ url })
  }
  return c.redirect(url, 302)
}

// ── DELETE /api/big/:slug ─────────────────────────────────────────────────────

export async function handleBigDelete(c: Ctx) {
  const cfg = s3Config(c.env)
  if (!cfg) return c.json({ error: 'big_unavailable' }, 503)
  const slug = c.req.param('slug') ?? ''
  if (!SLUG_RE.test(slug)) return c.json({ error: 'not_found' }, 404)
  const rec = await getRecord(c.env, slug)
  if (!rec) return c.json({ error: 'not_found' }, 404)
  if ((await hashToken(c.req.header('x-manage-token') ?? '')) !== rec.tokenHash) return c.json({ error: 'forbidden' }, 403)
  try {
    await destroy(c.env, cfg, rec)
  } catch {
    return c.json({ error: 'storage_error' }, 502)
  }
  return c.json({ ok: true })
}

// ── Scheduled sweep: delete what has expired ──────────────────────────────────

export async function sweepBigFiles(env: Env): Promise<{ checked: number; deleted: number; failed: number }> {
  const cfg = s3Config(env)
  const out = { checked: 0, deleted: 0, failed: 0 }
  if (!cfg) return out
  let cursor: string | undefined
  do {
    const page = await env.PASTE_KV.list({ prefix: PREFIX, cursor })
    for (const k of page.keys) {
      out.checked++
      const rec = await env.PASTE_KV.get<BigRecord>(k.name, 'json')
      if (!rec) continue
      if (!isExpired(rec)) continue
      try {
        await destroy(env, cfg, rec)
        out.deleted++
      } catch {
        out.failed++ // try again on the next run; the bucket's own rule removes it within days regardless
      }
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return out
}
