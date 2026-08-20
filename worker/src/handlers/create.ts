import type { Context } from 'hono'
import type { Env } from '../lib/types'
import { generateSlug, validateSlug } from '../lib/slug'
import { generateSalt, hashCode } from '../lib/crypto'
import { entryExists, putEntry, putFileKV } from '../lib/kv'
import { checkRateLimit, getClientIp } from '../lib/rateLimit'
import { validateMime } from '../lib/mime'
import { log } from '../lib/logger'
import { notifyRoom } from '../lib/notify'
import type { Entry, FileItem } from '../lib/types'


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
    let ttlSeconds: number | null = null
    if (ttlStr && ttlStr !== 'permanent') {
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
    const rawFiles  = form.getAll('files')
    const rawSingle = form.getAll('file')
    const fileList: File[] = []

    for (const item of [...rawFiles, ...rawSingle]) {
      if (item && typeof item === 'object' && typeof (item as any).arrayBuffer === 'function' && (item as any).size > 0) {
        const f = item as File
        if (!fileList.some((ex) => ex.name === f.name && ex.size === f.size)) {
          fileList.push(f)
        }
      }
    }

    const isFile    = type === 'file' || fileList.length > 0
    const FILE_TTL_SECONDS = 172_800 // 2 Days (48 Hours) auto-delete for file uploads
    const PERMANENT_MS    = 3_153_600_000_000 // 100 Years (Permanent for text)

    let expiresAt: number
    let fileExpiresAt: number | undefined = undefined

    if (ttlSeconds !== null) {
      expiresAt = now + (ttlSeconds * 1000)
      if (isFile) {
        fileExpiresAt = Math.min(expiresAt, now + (FILE_TTL_SECONDS * 1000))
      }
    } else {
      // Default: permanent for text, 2 days for files
      const content = form.get('content') as string | null
      const hasContent = content !== null && content.trim().length > 0
      
      if (isFile && !hasContent) {
        expiresAt = now + (FILE_TTL_SECONDS * 1000)
        fileExpiresAt = expiresAt
      } else {
        expiresAt = now + PERMANENT_MS
        if (isFile) {
          fileExpiresAt = now + (FILE_TTL_SECONDS * 1000)
        }
      }
    }

    const salt      = generateSalt()
    const pepper    = c.env.APP_PEPPER || 'clip_default_pepper'
    const editCodeHash = await hashCode(editCode, salt, pepper)

    const entry: Entry = {
      slug,
      type: isFile ? 'file' : 'text',
      editCodeHash,
      editCodeSalt: salt,
      createdAt: now,
      expiresAt,
      fileExpiresAt,
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

      c.executionCtx?.waitUntil(notifyRoom(c.env, slug))
      await log('entry.created', { slug, type: 'text' }, c.env)
      return c.json({ slug, expiresAt }, 201)
    }

    // ── Handle FILE entry ─────────────────────────────────────────────────────
    if (fileList.length === 0) return c.json({ error: 'no_content' }, 400)


    let totalSize = 0
    for (const f of fileList) {
      if (f.size > MAX_FILE_BYTES) return c.json({ error: 'file_too_large' }, 400)
      if (!(await validateMime(f))) return c.json({ error: 'mime_mismatch' }, 400)
      totalSize += f.size
    }

    if (totalSize > 50 * 1024 * 1024) {
      return c.json({ error: 'file_too_large' }, 400)
    }

    const processedFiles: FileItem[] = []
    const fileTtl = entry.fileExpiresAt ? Math.max(60, Math.ceil((entry.fileExpiresAt - now) / 1000)) : FILE_TTL_SECONDS

    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i]
      const fileId = `f_${i + 1}`
      const fileBuffer = await f.arrayBuffer()

      // Primary file stored at file:{slug} for backwards compatibility
      if (i === 0) {
        await putFileKV(c.env.PASTE_KV, slug, fileBuffer, fileTtl)
      }
      await putFileKV(c.env.PASTE_KV, slug, fileBuffer, fileTtl, fileId)

      processedFiles.push({
        id: fileId,
        fileName: f.name,
        fileMime: f.type || 'application/octet-stream',
        fileSize: f.size,
      })
    }

    entry.hasFile  = true
    entry.fileName = processedFiles[0].fileName
    entry.fileMime = processedFiles[0].fileMime
    entry.fileSize = totalSize
    entry.files    = processedFiles

    await putEntry(c.env.PASTE_KV, entry)

    c.executionCtx?.waitUntil(notifyRoom(c.env, slug))
    await log('entry.created', { slug, type: 'file', fileCount: processedFiles.length }, c.env)
    return c.json({ slug, expiresAt }, 201)

  } catch (err: any) {
    console.error('handleCreate error:', err)
    return c.json({ error: 'internal_error', details: String(err?.message || err) }, 500)
  }
}
