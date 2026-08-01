import type { Context } from 'hono'
import type { Env, Entry, FileItem } from '../lib/types'
import { getEntry, putEntry, putFileKV, deleteFileKV } from '../lib/kv'
import { verifyCode } from '../lib/crypto'
import { checkRateLimit, getClientIp } from '../lib/rateLimit'
import { validateMime } from '../lib/mime'
import { log } from '../lib/logger'

const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_FILE_BYTES = 25 * 1024 * 1024
const FILE_TTL_SECONDS = 172_800 // 48 Hours

export async function handleUpdate(c: Context<{ Bindings: Env }>) {
  try {
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

    const pepper = c.env.APP_PEPPER || 'clip_default_pepper'
    const valid  = await verifyCode(
      editCode,
      entry.editCodeSalt,
      pepper,
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

    // 2. Existing File Handling (Retention or Removal)
    let retainedFiles: FileItem[] = []
    const rawKeep = form.getAll('keepFileIds') as string[]
    const removeAll = form.get('removeFile') === 'true'

    if (entry.hasFile && entry.files && entry.files.length > 0) {
      if (removeAll) {
        // Delete all existing files from KV
        await deleteFileKV(c.env.PASTE_KV, slug)
        for (const f of entry.files) {
          await deleteFileKV(c.env.PASTE_KV, slug, f.id)
        }
      } else if (rawKeep.length > 0) {
        // Delete only unkept files
        for (const f of entry.files) {
          if (rawKeep.includes(f.id)) {
            retainedFiles.push(f)
          } else {
            await deleteFileKV(c.env.PASTE_KV, slug, f.id)
          }
        }
      } else {
        // Preserve all existing files by default
        retainedFiles = [...entry.files]
      }
    } else if (entry.hasFile && !removeAll) {
      if (entry.fileName && entry.fileSize && entry.fileMime) {
        retainedFiles.push({
          id: 'f_1',
          fileName: entry.fileName,
          fileMime: entry.fileMime,
          fileSize: entry.fileSize,
        })
      }
    }

    // 3. New File Uploads
    const rawFiles = form.getAll('files')
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

    const newlyProcessedFiles: FileItem[] = []
    if (fileList.length > 0) {
      let newFilesSize = 0
      for (const f of fileList) {
        if (f.size > MAX_FILE_BYTES) return c.json({ error: 'file_too_large' }, 400)
        if (!(await validateMime(f))) return c.json({ error: 'mime_mismatch' }, 400)
        newFilesSize += f.size
      }

      const existingTotalSize = retainedFiles.reduce((acc, f) => acc + f.fileSize, 0)
      if (existingTotalSize + newFilesSize > 50 * 1024 * 1024) {
        return c.json({ error: 'file_too_large' }, 400)
      }

      for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i]
        const fileId = `f_${retainedFiles.length + i + 1}_${Date.now()}`
        const fileBuffer = await f.arrayBuffer()

        if (retainedFiles.length === 0 && i === 0) {
          await putFileKV(c.env.PASTE_KV, slug, fileBuffer, FILE_TTL_SECONDS)
        }
        await putFileKV(c.env.PASTE_KV, slug, fileBuffer, FILE_TTL_SECONDS, fileId)

        newlyProcessedFiles.push({
          id: fileId,
          fileName: f.name,
          fileMime: f.type || 'application/octet-stream',
          fileSize: f.size,
        })
      }
    }

    const combinedFiles = [...retainedFiles, ...newlyProcessedFiles]

    if (combinedFiles.length > 0) {
      updated.hasFile   = true
      updated.fileName  = combinedFiles[0].fileName
      updated.fileMime  = combinedFiles[0].fileMime
      updated.fileSize  = combinedFiles.reduce((acc, f) => acc + f.fileSize, 0)
      updated.files     = combinedFiles
      updated.expiresAt = Date.now() + (FILE_TTL_SECONDS * 1000) // Reset 48h TTL on file update
    } else {
      updated.hasFile  = false
      updated.fileName = undefined
      updated.fileMime = undefined
      updated.fileSize = undefined
      updated.files    = undefined
    }

    // 4. Update entry type dynamically
    if (updated.hasFile && updated.content) {
      updated.type = 'file'
    } else if (updated.hasFile) {
      updated.type = 'file'
    } else {
      updated.type = 'text'
    }


    await putEntry(c.env.PASTE_KV, updated)

    await log('entry.updated', { slug }, c.env)
    return c.json({ slug })
  } catch (err: any) {
    console.error('handleUpdate error:', err)
    return c.json({ error: 'internal_error', details: String(err?.message || err) }, 500)
  }
}

