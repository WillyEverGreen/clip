import type { Context } from 'hono'
import type { Env, Entry } from '../lib/types'
import { getEntry, putEntry, putFileKV, deleteFileKV } from '../lib/kv'
import { verifyCode } from '../lib/crypto'
import { checkRateLimit, getClientIp } from '../lib/rateLimit'
import { validateMime } from '../lib/mime'
import { log } from '../lib/logger'

const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_FILE_BYTES = 25 * 1024 * 1024

export async function handleUpdate(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param('slug') ?? ''
  if (!slug) return c.json({ error: 'not_found' }, 404)
  const ip   = getClientIp(c.req.raw)

  // ── Rate limit ────────────────────────────────────────────────────────────
  const rl = await checkRateLimit(c.env.PASTE_KV, 'patch', ip)
  if (rl.limited) {
    await log('rate.limited', { endpoint: 'patch', ip }, c.env)
    return c.json({ error: 'rate_limited', retryAfter: rl.retryAfter }, 429)
  }

  // ── Load existing entry ───────────────────────────────────────────────────
  const entry = await getEntry(c.env.PASTE_KV, slug)
  if (!entry) return c.json({ error: 'not_found' }, 404)

  // ── Parse form ───────────────────────────────────────────────────────────
  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ error: 'invalid_form' }, 400)
  }

  const editCode = form.get('editCode') as string | null

  // ── Verify edit code ──────────────────────────────────────────────────────
  if (!editCode) return c.json({ error: 'wrong_edit_code' }, 403)

  const valid = await verifyCode(
    editCode,
    entry.editCodeSalt,
    c.env.APP_PEPPER,
    entry.editCodeHash,
  )

  if (!valid) {
    await log('auth.failed', { slug, ip }, c.env)
    return c.json({ error: 'wrong_edit_code' }, 403)
  }

  // ── Apply updates — preserve existing data by default ──────────────────────
  const updated: Entry = { ...entry, updatedAt: Date.now() }

  // 1. Text Content update
  if (form.has('content')) {
    const content = form.get('content') as string | null
    if (content !== null) {
      const byteLength = new TextEncoder().encode(content).length
      if (byteLength > MAX_TEXT_BYTES) return c.json({ error: 'text_too_large' }, 400)
      updated.content = content
    }
  }

  // 2. Explicit File Removal
  if (form.get('removeFile') === 'true') {
    if (entry.hasFile) {
      await deleteFileKV(c.env.PASTE_KV, slug)
    }
    updated.hasFile  = false
    updated.fileName = undefined
    updated.fileMime = undefined
    updated.fileSize = undefined
  }

  // 3. New File Upload
  const file = form.get('file') as File | null
  if (file && file.size > 0) {
    if (file.size > MAX_FILE_BYTES)  return c.json({ error: 'file_too_large' }, 400)
    if (!(await validateMime(file))) return c.json({ error: 'mime_mismatch' }, 400)

    const fileBuffer = await file.arrayBuffer()
    await putFileKV(c.env.PASTE_KV, slug, fileBuffer)

    updated.hasFile  = true
    updated.fileName = file.name
    updated.fileMime = file.type || 'application/octet-stream'
    updated.fileSize = file.size
  }

  // 4. Update entry type dynamically
  if (updated.hasFile && updated.content) {
    updated.type = 'file' // has both
  } else if (updated.hasFile) {
    updated.type = 'file'
  } else {
    updated.type = 'text'
  }

  await putEntry(c.env.PASTE_KV, updated)

  await log('entry.updated', { slug }, c.env)
  return c.json({ slug })
}
