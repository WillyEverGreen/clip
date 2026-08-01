import type { Context } from 'hono'
import type { Env } from '../lib/types'
import { generateSlug, validateSlug } from '../lib/slug'
import { generateSalt, hashCode } from '../lib/crypto'
import { entryExists, putEntry, putFileKV } from '../lib/kv'
import { checkRateLimit, getClientIp } from '../lib/rateLimit'
import { validateMime } from '../lib/mime'
import { log } from '../lib/logger'
import type { Entry } from '../lib/types'

const MAX_TEXT_BYTES = 2 * 1024 * 1024  // 2 MB
const MAX_FILE_BYTES = 25 * 1024 * 1024 // 25 MB (KV max limit)
const DEFAULT_TTL_SECONDS = 21_600      // 6 hours

export async function handleCreate(c: Context<{ Bindings: Env }>) {
  try {
    const ip = getClientIp(c.req.raw)

    // ── Rate limit ───────────────────────────────────────────────────────────
    const rl = await checkRateLimit(c.env.PASTE_KV, 'create', ip)
    if (rl.limited) {
      await log('rate.limited', { endpoint: 'create', ip }, c.env)
      return c.json({ error: 'rate_limited', retryAfter: rl.retryAfter }, 429)
    }

    // ── Parse multipart form ─────────────────────────────────────────────────
    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      return c.json({ error: 'invalid_form' }, 400)
    }

    const type     = form.get('type') as string | null
    const editCode = form.get('editCode') as string | null
    const rawSlug  = (form.get('slug') as string | null)?.trim().toLowerCase() || ''
    const ttlStr   = form.get('ttl') as string | null

    // Parse custom TTL (seconds)
    let ttlSeconds = DEFAULT_TTL_SECONDS
    if (ttlStr) {
      const parsed = parseInt(ttlStr, 10)
      if (!isNaN(parsed) && parsed >= 60 && parsed <= 2_592_000) {
        ttlSeconds = parsed
      }
    }

    // ── Validate edit code ───────────────────────────────────────────────────
    if (!editCode || editCode.length < 4 || editCode.length > 128) {
      return c.json({ error: 'missing_edit_code' }, 400)
    }

    // ── Resolve slug ─────────────────────────────────────────────────────────
    let slug = rawSlug || generateSlug()

    if (rawSlug) {
      const validation = validateSlug(rawSlug)
      if (!validation.valid) {
        const errorMap = {
          too_short:     'slug_invalid',
          too_long:      'slug_invalid',
          invalid_chars: 'slug_invalid',
          reserved:      'slug_reserved',
        }
        return c.json({ error: errorMap[validation.reason] }, 400)
      }
    }

    // ── Uniqueness check ─────────────────────────────────────────────────────
    if (await entryExists(c.env.PASTE_KV, slug)) {
      return c.json({ error: 'slug_taken' }, 409)
    }

    // ── Build entry ──────────────────────────────────────────────────────────
    const now       = Date.now()
    const expiresAt = now + (ttlSeconds * 1000)
    const salt      = generateSalt()
    const pepper    = c.env.APP_PEPPER || 'clip_default_pepper'
    const editCodeHash = await hashCode(editCode, salt, pepper)

    const entry: Entry = {
      slug,
      type: type === 'file' ? 'file' : 'text',
      editCodeHash,
      editCodeSalt: salt,
      createdAt: now,
      expiresAt,
      views: 0,
    }

    // ── Handle TEXT entry ─────────────────────────────────────────────────────
    if (entry.type === 'text') {
      const content = form.get('content') as string | null
      if (!content?.trim()) return c.json({ error: 'no_content' }, 400)

      const byteLength = new TextEncoder().encode(content).length
      if (byteLength > MAX_TEXT_BYTES) return c.json({ error: 'text_too_large' }, 400)

      entry.content = content
      await putEntry(c.env.PASTE_KV, entry)

      await log('entry.created', { slug, type: 'text' }, c.env)
      return c.json({ slug, expiresAt }, 201)
    }

    // ── Handle FILE entry ─────────────────────────────────────────────────────
    const file = form.get('file') as File | null
    if (!file || file.size === 0) return c.json({ error: 'no_content' }, 400)

    // Server-side size enforcement
    if (file.size > MAX_FILE_BYTES) return c.json({ error: 'file_too_large' }, 400)

    // MIME magic byte check
    if (!(await validateMime(file))) return c.json({ error: 'mime_mismatch' }, 400)

    const fileBuffer = await file.arrayBuffer()
    await putFileKV(c.env.PASTE_KV, slug, fileBuffer, ttlSeconds)

    entry.fileName = file.name
    entry.fileMime = file.type || 'application/octet-stream'
    entry.fileSize = file.size
    entry.hasFile  = true

    await putEntry(c.env.PASTE_KV, entry)

    await log('entry.created', { slug, type: 'file' }, c.env)
    return c.json({ slug, expiresAt }, 201)
  } catch (err: any) {
    console.error('handleCreate error:', err)
    return c.json({ error: 'internal_error', details: String(err?.message || err) }, 500)
  }
}
