import type { Context } from 'hono'
import type { Env } from '../lib/types'
import { getEntry, putEntry, toPublic, getFileKV } from '../lib/kv'

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.\-]/g, '_').slice(0, 128)
}

// ── GET /api/entry/:slug ──────────────────────────────────────────────────────

export async function handleRead(c: Context<{ Bindings: Env }>) {
  const slug  = c.req.param('slug') ?? ''
  if (!slug) return c.json({ error: 'not_found' }, 404)
  const entry = await getEntry(c.env.PASTE_KV, slug)

  if (!entry) return c.json({ error: 'not_found' }, 404)

  entry.views = (entry.views ?? 0) + 1
  await putEntry(c.env.PASTE_KV, entry)

  return c.json(toPublic(entry))
}

// ── GET /api/entry/:slug/file ─────────────────────────────────────────────────

export async function handleReadFile(c: Context<{ Bindings: Env }>) {
  const slug  = c.req.param('slug') ?? ''
  if (!slug) return c.json({ error: 'not_found' }, 404)
  const entry = await getEntry(c.env.PASTE_KV, slug)

  if (!entry || !entry.hasFile) return c.json({ error: 'not_found' }, 404)
  if (Date.now() > entry.expiresAt) return c.json({ error: 'expired' }, 404)

  const fileData = await getFileKV(c.env.PASTE_KV, slug)
  if (!fileData) return c.json({ error: 'not_found' }, 404)

  const safeName = sanitizeFilename(entry.fileName ?? 'download')

  return new Response(fileData, {
    headers: {
      'Content-Type':        entry.fileMime ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Length':      String(entry.fileSize ?? 0),
      'Cache-Control':       'no-store',
    },
  })
}
