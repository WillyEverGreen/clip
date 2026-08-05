import type { Context } from 'hono'
import type { Env } from '../lib/types'
import { getEntry, putEntry, toPublic, getFileKV } from '../lib/kv'

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.\-]/g, '_').slice(0, 128)
}

// ── GET /api/entry/:slug/file ─────────────────────────────────────────────────

export async function handleReadFile(c: Context<{ Bindings: Env }>) {
  const slug  = c.req.param('slug') ?? ''
  const fileId = c.req.query('fileId') || c.req.query('id')
  if (!slug) return c.json({ error: 'not_found' }, 404)
  const entry = await getEntry(c.env.PASTE_KV, slug)

  if (!entry || !entry.hasFile) return c.json({ error: 'not_found' }, 404)
  if (Date.now() > entry.expiresAt) return c.json({ error: 'expired' }, 404)

  let fileName = entry.fileName ?? 'download'
  let fileMime = entry.fileMime ?? 'application/octet-stream'
  let fileSize = entry.fileSize ?? 0

  if (fileId && entry.files && entry.files.length > 0) {
    const item = entry.files.find(f => f.id === fileId)
    if (item) {
      fileName = item.fileName
      fileMime = item.fileMime
      fileSize = item.fileSize
    }
  }

  const fileData = await getFileKV(c.env.PASTE_KV, slug, fileId)
  if (!fileData) return c.json({ error: 'not_found' }, 404)

  const safeName = sanitizeFilename(fileName)

  return new Response(fileData, {
    headers: {
      'Content-Type':        fileMime,
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Length':      String(fileSize || fileData.byteLength),
      'Cache-Control':       'no-store',
    },
  })
}

// ── GET /raw/:slug ────────────────────────────────────────────────────────────

export async function handleReadRaw(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param('slug') ?? ''
  if (!slug) return c.text('Not found', 404)

  const entry = await getEntry(c.env.PASTE_KV, slug)
  if (!entry) return c.text('Not found', 404)
  if (Date.now() > entry.expiresAt) return c.text('Expired', 404)

  entry.views = (entry.views ?? 0) + 1
  await putEntry(c.env.PASTE_KV, entry)

  if (entry.type === 'file' || (!entry.content && entry.hasFile)) {
    return handleReadFile(c)
  }

  return new Response(entry.content ?? '', {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

// ── GET /api/entry/:slug ──────────────────────────────────────────────────────

export async function handleRead(c: Context<{ Bindings: Env }>) {
  const slug  = c.req.param('slug') ?? ''
  if (!slug) return c.json({ error: 'not_found' }, 404)
  const entry = await getEntry(c.env.PASTE_KV, slug)

  if (!entry) return c.json({ error: 'not_found' }, 404)

  const userAgent = c.req.header('user-agent')?.toLowerCase() || ''
  const accept = c.req.header('accept')?.toLowerCase() || ''
  const isCli = userAgent.includes('curl') || userAgent.includes('wget')

  if (isCli && !accept.includes('application/json')) {
    return handleReadRaw(c)
  }

  entry.views = (entry.views ?? 0) + 1
  await putEntry(c.env.PASTE_KV, entry)

  return c.json(toPublic(entry))
}

