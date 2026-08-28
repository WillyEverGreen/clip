import type { Context } from 'hono'
import type { Env } from '../lib/types'
import { getEntry, getFileKV } from '../lib/kv'
import { isEncrypted, decryptContent } from '../lib/crypto'
import { zipSync, strToU8 } from 'fflate'

// ── ETag helper ───────────────────────────────────────────────────────────────
function makeETag(slug: string, updatedAt: number, extra?: number): string {
  return `"${slug}-${updatedAt}-${extra ?? 0}"`
}
function isNotModified(req: Request, etag: string): boolean {
  const ifNoneMatch = req.headers.get('If-None-Match')
  return ifNoneMatch === etag || ifNoneMatch === '*'
}


export async function handleReadZip(c: Context<{ Bindings: Env }>) {
  const raw  = c.req.param('slug') ?? ''
  // Allow /zip/ahamed.zip — strip extension so curl -LO saves with correct filename
  const slug = raw.replace(/\.zip$/i, '')
  if (!slug) return c.text('Not found', 404)

  const entry = await getEntry(c.env.PASTE_KV, slug)
  if (!entry) return c.text('Not found', 404)
  if (!entry.isPermanent && Date.now() > entry.expiresAt) return c.text('Expired', 410)

  // ── ETag / 304 — skip ZIP build if client already has this version ─────────
  const etag = makeETag(slug, entry.updatedAt ?? entry.createdAt, entry.fileSize ?? 0)
  if (isNotModified(c.req.raw, etag)) {
    return new Response(null, {
      status: 304,
      headers: { 'ETag': etag, 'Cache-Control': 'public, max-age=10, stale-while-revalidate=60' },
    })
  }


  // 1. Add text content as <slug>.txt
  const zipFiles: Record<string, Uint8Array> = {}
  if (entry.content) {
    let contentToZip = entry.content
    if (isEncrypted(entry.content)) {
      const password = c.req.header('x-password') || c.req.header('x-pass') || c.req.query('password') || c.req.query('pass') || c.req.query('p')
      if (password) {
        const decrypted = await decryptContent(entry.content, password)
        if (decrypted !== null) {
          contentToZip = decrypted
        } else {
          return c.text(`Error: Incorrect password for encrypted paste /${slug}.\nUsage: curl -fLO "https://clip.foo.ng/z/${slug}.zip?pass=<password>"\n`, 401)
        }
      }
    }
    zipFiles[`${slug}.txt`] = strToU8(contentToZip)
  }

  // 2. Add each attached file
  const filesExpired = entry.fileExpiresAt && Date.now() > entry.fileExpiresAt
  const missingFiles: string[] = []
  const MAX_ZIP_SIZE_MB = 25 // Maximum 25MB for ZIP generation
  let totalFileSize = 0
  
  if (entry.hasFile && !filesExpired) {
    // Check aggregate size before attempting to load files
    if (entry.fileSize && entry.fileSize > MAX_ZIP_SIZE_MB * 1024 * 1024) {
      return c.json({ 
        error: 'zip_too_large', 
        message: `Entry exceeds ${MAX_ZIP_SIZE_MB}MB limit for ZIP generation`,
        size: entry.fileSize,
        limit: MAX_ZIP_SIZE_MB * 1024 * 1024
      }, 413)
    }

    if (entry.files && entry.files.length > 0) {
      for (const file of entry.files) {
        const data = await getFileKV(c.env.PASTE_KV, slug, file.id)
        if (data) {
          // Check size as we load files
          totalFileSize += data.byteLength
          if (totalFileSize > MAX_ZIP_SIZE_MB * 1024 * 1024) {
            return c.json({ 
              error: 'zip_too_large', 
              message: `Total file size exceeds ${MAX_ZIP_SIZE_MB}MB limit`,
              totalSize: totalFileSize,
              limit: MAX_ZIP_SIZE_MB * 1024 * 1024
            }, 413)
          }

          // Deduplicate filenames with human-readable suffixes like (2), (3)
          let name = file.fileName
          if (zipFiles[name]) {
            const originalName = file.fileName
            const parts = originalName.split('.')
            const ext = parts.length > 1 ? `.${parts.pop()}` : ''
            const baseName = parts.join('.')
            let counter = 2
            while (zipFiles[name]) {
              name = `${baseName} (${counter})${ext}`
              counter++
            }
          }
          zipFiles[name] = new Uint8Array(data)
        } else {
          // File blob missing from KV (TTL expired or propagation lag)
          missingFiles.push(file.fileName)
          console.error(`ZIP: Missing file blob for ${slug}:${file.id} (${file.fileName})`)
        }
      }
    } else {
      // Legacy single-file entry
      const data = await getFileKV(c.env.PASTE_KV, slug)
      if (data && entry.fileName) {
        totalFileSize = data.byteLength
        if (totalFileSize > MAX_ZIP_SIZE_MB * 1024 * 1024) {
          return c.json({ 
            error: 'zip_too_large', 
            message: `File size exceeds ${MAX_ZIP_SIZE_MB}MB limit`,
            totalSize: totalFileSize,
            limit: MAX_ZIP_SIZE_MB * 1024 * 1024
          }, 413)
        }
        zipFiles[entry.fileName] = new Uint8Array(data)
      } else if (entry.fileName) {
        missingFiles.push(entry.fileName)
        console.error(`ZIP: Missing legacy file blob for ${slug} (${entry.fileName})`)
      }
    }
  }

  // If some files are missing, include a MISSING_FILES.txt manifest
  if (missingFiles.length > 0) {
    const manifest = [
      '⚠️  WARNING: Some files could not be included in this archive',
      '',
      'The following files are missing (likely expired or not yet propagated):',
      '',
      ...missingFiles.map(name => `  - ${name}`),
      '',
      `Total missing: ${missingFiles.length} file(s)`,
      '',
      'Note: Files auto-delete after 48 hours regardless of entry expiration.',
    ].join('\n')
    zipFiles['MISSING_FILES.txt'] = strToU8(manifest)
  }

  if (Object.keys(zipFiles).length === 0) {
    return c.text('No content to zip', 404)
  }

  const zipped = zipSync(zipFiles)

  return new Response(zipped, {
    headers: {
      'Content-Type':        'application/zip',
      'Content-Disposition': `attachment; filename="${slug}.zip"`,
      'Content-Length':      String(zipped.byteLength),
      'ETag':                etag,
      'Cache-Control':       'public, max-age=10, stale-while-revalidate=60',
    },
  })
}
