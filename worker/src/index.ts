import { Hono } from 'hono'
import type { Env } from './lib/types'
import { securityHeaders } from './lib/headers'
import { strictCors } from './lib/cors'
import { handleCreate } from './handlers/create'
import { handleRead, handleReadFile, handleReadRaw } from './handlers/read'
import { handleVerify } from './handlers/verify'
import { handleUpdate } from './handlers/update'
import { handleRemove } from './handlers/remove'
import { generateLiveSlug, isReserved } from './lib/slug'
import { entryExists } from './lib/kv'

import { handleAdminList, handleAdminDelete, handleAdminPurgeAll } from './handlers/admin'
import { handleReadZip } from './handlers/zip'
import { putFileKV, getFileKV, deleteFileKV } from './lib/kv'
import { getMimeType } from './lib/mime'

// Re-export Durable Object so wrangler can register it
export { ClipRoom } from './durable/ClipRoom'

const app = new Hono<{ Bindings: Env }>()

// ── Global middleware ─────────────────────────────────────────────────────────

app.use('*', securityHeaders())
app.use('*', (c, next) => strictCors(c.env.FRONTEND_ORIGIN)(c, next))

// ── Global Error Handler ──────────────────────────────────────────────────────

app.onError((err, c) => {
  console.error('Worker global error:', err)
  return c.json({ error: 'internal_error', message: err.message }, 500)
})

// ── Routes ────────────────────────────────────────────────────────────────────

// Create
app.post('/api/entry',                handleCreate)

// Read (Short CLI routes)
app.get('/r/:slug',                 handleReadRaw)
app.get('/z/:slug',                 handleReadZip)
app.get('/f/:slug',                 handleReadFile)

// Read (Standard routes)
app.get('/raw/:slug',                 handleReadRaw)
app.get('/:slug/raw',                 handleReadRaw)
app.get('/zip/:slug',                 handleReadZip)
app.get('/api/entry/:slug/raw',       handleReadRaw)
app.get('/api/entry/:slug/zip',       handleReadZip)
app.get('/api/entry/:slug',           handleRead)
app.get('/api/entry/:slug/file',      handleReadFile)

// SSE — real-time update stream (proxied to ClipRoom Durable Object)
app.get('/api/entry/:slug/events', async (c) => {
  if (!c.env.CLIP_DO) return c.json({ error: 'sse_unavailable' }, 503)
  const slug = c.req.param('slug') ?? ''
  if (!slug) return c.json({ error: 'not_found' }, 404)
  const id  = c.env.CLIP_DO.idFromName(slug)
  const obj = c.env.CLIP_DO.get(id)
  // Forward the raw request; the DO manages the stream lifetime
  const res = await obj.fetch(
    new Request(`https://clip-do/room/${slug}/events`, {
      method:  'GET',
      headers: c.req.raw.headers,
    }),
  )
  const headers = new Headers(res.headers)
  const reqOrigin = c.req.header('Origin') || ''
  const allowedOrigin = (reqOrigin.includes('localhost') || reqOrigin.endsWith('.pages.dev') || reqOrigin.endsWith('.foo.ng'))
    ? reqOrigin
    : (c.env.FRONTEND_ORIGIN || '*')
  headers.set('Access-Control-Allow-Origin', allowedOrigin)
  headers.set('Cache-Control', 'no-cache, no-transform')
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
})

// Verify edit code
app.post('/api/entry/:slug/verify',   handleVerify)

// Update
app.patch('/api/entry/:slug',         handleUpdate)

// Delete
app.delete('/api/entry/:slug',        handleRemove)

// Admin
app.get('/api/admin/entries',         handleAdminList)
app.delete('/api/admin/entry/:slug',  handleAdminDelete)
app.delete('/api/admin/purge',        handleAdminPurgeAll)

// ── Live Pad Real-Time Routes ──────────────────────────────────────────────────

// Generate a guaranteed-unique, cryptographically secure slug for a new Live Pad room.
// The slug is atomically reserved in KV so it can never be handed out twice.
app.get('/api/live/new-slug', async (c) => {
  const KV_TTL_30D = 86_400 * 30 // 30 days — covers any reasonable session lifetime
  const MAX_ATTEMPTS = 8

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const candidate = generateLiveSlug()

    // 1. Never collide with reserved route segments
    if (isReserved(candidate)) continue

    // 2. Never collide with an existing paste in KV
    if (await entryExists(c.env.PASTE_KV, candidate)) continue

    // 3. Never collide with a previously claimed Live Pad room
    const liveKey = `live:reserved:${candidate}`
    const existing = await c.env.PASTE_KV.get(liveKey)
    if (existing !== null) continue

    // 4. Atomically claim the slug — subsequent random generation will skip it
    await c.env.PASTE_KV.put(liveKey, '1', { expirationTtl: KV_TTL_30D })

    return c.json({ slug: candidate }, 200, { 'Cache-Control': 'no-store' })
  }

  // Astronomically unlikely (10^15 combinations) — only reachable if KV is saturated
  return c.json({ error: 'slug_exhausted' }, 503)
})

// WebSocket upgrade connection for real-time live typing & file events
app.get('/api/live/:slug/ws', async (c) => {
  if (!c.env.CLIP_DO) return c.json({ error: 'live_unavailable' }, 503)
  const slug = c.req.param('slug') ?? ''
  if (!slug) return c.json({ error: 'not_found' }, 404)
  const id  = c.env.CLIP_DO.idFromName(slug)
  const obj = c.env.CLIP_DO.get(id)
  return obj.fetch(c.req.raw)
})

// Fetch initial state for Live Pad
app.get('/api/live/:slug', async (c) => {
  if (!c.env.CLIP_DO) return c.json({ error: 'live_unavailable' }, 503)
  const slug = c.req.param('slug') ?? ''
  if (!slug) return c.json({ error: 'not_found' }, 404)
  const id  = c.env.CLIP_DO.idFromName(slug)
  const obj = c.env.CLIP_DO.get(id)
  const res = await obj.fetch(`https://clip-do/room/${slug}/live-state`)
  const data = await res.json()
  return c.json(data, 200, {
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  })
})

// Upload a live file/image
app.post('/api/live/:slug/upload', async (c) => {
  if (!c.env.CLIP_DO) return c.json({ error: 'live_unavailable' }, 503)
  const slug = c.req.param('slug') ?? ''
  if (!slug) return c.json({ error: 'not_found' }, 404)

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ error: 'invalid_form' }, 400)
  }

  const rawFile = form.get('file') as File | null
  if (!rawFile || typeof rawFile.arrayBuffer !== 'function') {
    return c.json({ error: 'missing_file' }, 400)
  }

  if (rawFile.size > 25 * 1024 * 1024) {
    return c.json({ error: 'file_too_large' }, 400)
  }

  const fileId = `live_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  const fileBuffer = await rawFile.arrayBuffer()
  const TTL_24H = 86_400

  await putFileKV(c.env.PASTE_KV, slug, fileBuffer, TTL_24H, fileId)

  const inferredMime = (!rawFile.type || rawFile.type === 'application/octet-stream')
    ? getMimeType(rawFile.name)
    : rawFile.type

  const fileItem = {
    id: fileId,
    fileName: rawFile.name || 'file',
    fileMime: inferredMime || 'application/octet-stream',
    fileSize: rawFile.size,
  }

  const id = c.env.CLIP_DO.idFromName(slug)
  const obj = c.env.CLIP_DO.get(id)
  await obj.fetch(`https://clip-do/room/${slug}/live-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: fileItem }),
  })

  return c.json({ ok: true, file: fileItem }, 200, {
    'Cache-Control': 'no-store',
  })
})

// Delete a live file
app.delete('/api/live/:slug/file/:fileId', async (c) => {
  if (!c.env.CLIP_DO) return c.json({ error: 'live_unavailable' }, 503)
  const slug   = c.req.param('slug') ?? ''
  const fileId = c.req.param('fileId') ?? ''
  if (!slug || !fileId) return c.json({ error: 'not_found' }, 404)

  await deleteFileKV(c.env.PASTE_KV, slug, fileId)

  const id = c.env.CLIP_DO.idFromName(slug)
  const obj = c.env.CLIP_DO.get(id)
  await obj.fetch(`https://clip-do/room/${slug}/live-file/${fileId}`, {
    method: 'DELETE',
  })

  return c.json({ ok: true })
})

// Stream/View live file binary
app.get('/api/live/:slug/file/:fileId', async (c) => {
  const slug   = c.req.param('slug') ?? ''
  const fileId = c.req.param('fileId') ?? ''
  if (!slug || !fileId) return c.json({ error: 'not_found' }, 404)

  const fileData = await getFileKV(c.env.PASTE_KV, slug, fileId)
  if (!fileData) return c.json({ error: 'not_found' }, 404)

  const requestedName = c.req.query('name') || fileId
  // Isolate basename to prevent Windows filename errors when relative paths are present
  const baseName = requestedName.split(/[/\\]/).pop() || requestedName
  const sanitizedBase = baseName.replace(/["\r\n]/g, '_')
  const requestedMime = c.req.query('mime') || getMimeType(requestedName) || 'application/octet-stream'

  return new Response(fileData, {
    headers: {
      'Content-Type':        requestedMime,
      'Content-Disposition': `inline; filename="${sanitizedBase}"; filename*=UTF-8''${encodeURIComponent(requestedName)}`,
      'Cache-Control':       'no-cache, must-revalidate',
      'Pragma':              'no-cache',
    },
  })
})

// Health check
app.get('/api/health', (c) => c.json({ ok: true }))

export default app
