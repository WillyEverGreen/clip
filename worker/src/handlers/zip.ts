import type { Context } from 'hono'
import type { Env } from '../lib/types'
import { getEntry, getFileKV } from '../lib/kv'
import { isEncrypted, decryptContent } from '../lib/crypto'
import { zipSync, strToU8 } from 'fflate'

// ── GET /zip/:slug ────────────────────────────────────────────────────────────
// Returns a ZIP archive containing:
//   - <slug>.txt   (text content, if present)
//   - all attached files (by their original filenames)

export async function handleReadZip(c: Context<{ Bindings: Env }>) {
  const raw  = c.req.param('slug') ?? ''
  // Allow /zip/ahamed.zip — strip extension so curl -LO saves with correct filename
  const slug = raw.replace(/\.zip$/i, '')
  if (!slug) return c.text('Not found', 404)

  const entry = await getEntry(c.env.PASTE_KV, slug)
  if (!entry) return c.text('Not found', 404)
  if (Date.now() > entry.expiresAt) return c.text('Expired', 410)

  const zipFiles: Record<string, Uint8Array> = {}

  // 1. Add text content as <slug>.txt
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
  if (entry.hasFile && !filesExpired) {
    if (entry.files && entry.files.length > 0) {
      for (const file of entry.files) {
        const data = await getFileKV(c.env.PASTE_KV, slug, file.id)
        if (data) {
          // Deduplicate filenames if multiple files share the same name
          let name = file.fileName
          if (zipFiles[name]) {
            const parts = name.split('.')
            const ext = parts.length > 1 ? `.${parts.pop()}` : ''
            name = `${parts.join('.')}_${file.id}${ext}`
          }
          zipFiles[name] = new Uint8Array(data)
        }
      }
    } else {
      // Legacy single-file entry
      const data = await getFileKV(c.env.PASTE_KV, slug)
      if (data && entry.fileName) {
        zipFiles[entry.fileName] = new Uint8Array(data)
      }
    }
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
      'Cache-Control':       'no-store',
    },
  })
}
