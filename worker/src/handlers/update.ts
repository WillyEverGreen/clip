import type { Context } from 'hono'
import type { Env, Entry, FileItem } from '../lib/types'
import { getEntry, putEntry, putFileKV, deleteFileKV } from '../lib/kv'
import { verifyCode } from '../lib/crypto'
import { checkRateLimit, getClientIp } from '../lib/rateLimit'
import { validateMime } from '../lib/mime'
import { log } from '../lib/logger'
import { notifyRoom } from '../lib/notify'
import { normalizeNewlines } from '../lib/text'
import { BIG_MAX_BYTES, BIG_MAX_FILES, FILE_TTL_SECONDS } from '../lib/big'
import { claimUpload, releaseUpload, removeUploadFiles } from './big'
import { bundleFromRecord, bundleTotals, pruneExpiredBundles } from '../lib/bundles'

const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_FILE_BYTES = 25 * 1024 * 1024

export async function handleUpdate(c: Context<{ Bindings: Env }>) {
  try {
    const slug = c.req.param('slug') ?? ''
    if (!slug) return c.json({ error: 'not_found' }, 404)
    const ip   = getClientIp(c.req.raw)

    // ── Rate limit ────────────────────────────────────────────────────────────
    // Check both global and per-slug rate limits
    const rlGlobal = await checkRateLimit(c.env.PASTE_KV, 'patch', ip)
    if (rlGlobal.limited) {
      await log('rate.limited', { endpoint: 'patch', ip, scope: 'global' }, c.env)
      return c.json({ error: 'rate_limited', retryAfter: rlGlobal.retryAfter }, 429, {
        'Retry-After': String(rlGlobal.retryAfter ?? 120)
      })
    }
    
    const rlSlug = await checkRateLimit(c.env.PASTE_KV, 'patch:slug', ip, slug)
    if (rlSlug.limited) {
      await log('rate.limited', { endpoint: 'patch', ip, slug, scope: 'per-slug' }, c.env)
      return c.json({ error: 'rate_limited', retryAfter: rlSlug.retryAfter }, 429, {
        'Retry-After': String(rlSlug.retryAfter ?? 120)
      })
    }

    // ── Load existing entry ───────────────────────────────────────────────────
    const entry = await getEntry(c.env.PASTE_KV, slug)
    if (!entry) return c.json({ error: 'not_found' }, 404)
    if (!entry.isPermanent && Date.now() > entry.expiresAt) return c.json({ error: 'expired' }, 404)

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

    const pepper = c.env.APP_PEPPER
    if (!pepper) return c.json({ error: 'server_misconfigured' }, 500)
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
      const content = normalizeNewlines(form.get('content') as string | null)
      if (content !== null) {
        const byteLength = new TextEncoder().encode(content).length
        if (byteLength > MAX_TEXT_BYTES) return c.json({ error: 'text_too_large' }, 400)
        updated.content = content
      }
    }

    // 2a. Files in the file bucket: drop expired ones, remove some or all, or add a new upload
    for (const id of pruneExpiredBundles(updated)) c.executionCtx?.waitUntil(releaseUpload(c.env, id))
    if (form.get('removeFile') === 'true' && updated.bundles?.length) {
      for (const b of updated.bundles) await releaseUpload(c.env, b.id)
      updated.bundles = undefined
    }
    const removeRaw = form.get('removeBundleFiles') as string | null
    if (removeRaw && updated.bundles?.length) {
      let wanted: { id?: unknown; n?: unknown }[] = []
      try { wanted = JSON.parse(removeRaw) } catch { return c.json({ error: 'invalid_request' }, 400) }
      if (!Array.isArray(wanted)) return c.json({ error: 'invalid_request' }, 400)
      const next = []
      for (const b of updated.bundles) {
        const ns = wanted.filter((w) => w?.id === b.id && typeof w.n === 'number').map((w) => w.n as number)
        if (ns.length === 0) { next.push(b); continue }
        const left = await removeUploadFiles(c.env, b.id, ns)
        const files = b.files.filter((f) => !ns.includes(f.n))
        if (left && files.length) next.push({ ...b, files })
      }
      updated.bundles = next.length ? next : undefined
    }
    const newBundleId = ((form.get('bundleId') as string | null) ?? '').trim()
    if (newBundleId) {
      if (form.getAll('files').length || form.getAll('file').length) return c.json({ error: 'invalid_request' }, 400)
      const until = Math.min(updated.isPermanent ? Number.MAX_SAFE_INTEGER : updated.expiresAt, Date.now() + FILE_TTL_SECONDS * 1000)
      const claimed = await claimUpload(c.env, newBundleId, form.get('bundleToken') as string | null, slug, until)
      if ('error' in claimed) return c.json({ error: claimed.error }, claimed.error === 'bundle_forbidden' ? 403 : 400)
      const bundles = [...(updated.bundles ?? []), bundleFromRecord(claimed, until)]
      const totals = bundleTotals(bundles)
      if (totals.files > BIG_MAX_FILES || totals.bytes > BIG_MAX_BYTES || bundles.length > 10) {
        await releaseUpload(c.env, claimed.slug)
        return c.json({ error: 'too_large' }, 400)
      }
      updated.bundles = bundles
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

    const nowMs = Date.now()
    if (retainedFiles.length > 0 && entry.fileExpiresAt && entry.fileExpiresAt <= nowMs) {
      for (const f of retainedFiles) {
        await deleteFileKV(c.env.PASTE_KV, slug, f.id)
      }
      await deleteFileKV(c.env.PASTE_KV, slug)
      retainedFiles = []
    }
    const existingFileExpiry =
      retainedFiles.length > 0 && entry.fileExpiresAt && entry.fileExpiresAt > nowMs
        ? entry.fileExpiresAt
        : undefined
    const sharedFileExpiresAt = Math.min(
      updated.expiresAt,
      existingFileExpiry ?? nowMs + (FILE_TTL_SECONDS * 1000),
    )

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

      const fileTtl = Math.max(60, Math.ceil((sharedFileExpiresAt - Date.now()) / 1000))

      for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i]
        const fileId = `f_${retainedFiles.length + i + 1}_${Date.now()}`
        const fileBuffer = await f.arrayBuffer()

        if (retainedFiles.length === 0 && i === 0) {
          await putFileKV(c.env.PASTE_KV, slug, fileBuffer, fileTtl)
        }
        await putFileKV(c.env.PASTE_KV, slug, fileBuffer, fileTtl, fileId)

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
      
      updated.fileExpiresAt = sharedFileExpiresAt

      if (!updated.content) {
        // A files-only clip lasts as long as its last file
        updated.expiresAt = Math.max(sharedFileExpiresAt, ...(updated.bundles ?? []).map((b) => b.expiresAt))
      }
    } else {
      updated.hasFile  = false
      updated.fileName = undefined
      updated.fileMime = undefined
      updated.fileSize = undefined
      updated.files    = undefined
      updated.fileExpiresAt = undefined
    }

    // 4. Update entry type dynamically
    updated.type = updated.hasFile || updated.bundles?.length ? 'file' : 'text'


    await putEntry(c.env.PASTE_KV, updated)

    c.executionCtx?.waitUntil(notifyRoom(c.env, slug, updated.updatedAt))
    await log('entry.updated', { slug }, c.env)
    return c.json({ slug })
  } catch (err: any) {
    console.error('handleUpdate error:', err)
    return c.json({ error: 'internal_error', details: String(err?.message || err) }, 500)
  }
}

