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
import { entryExists, getEntry, putFileKV, getFileKV, deleteFileKV } from './lib/kv'

import { handleAdminList, handleAdminDelete, handleAdminPurgeAll, handleAdminLiveRooms, handleAdminDeleteLiveRoom } from './handlers/admin'
import { handleReadZip } from './handlers/zip'
import { getMimeType, validateMime } from './lib/mime'
import { zipSync, strToU8 } from 'fflate'
import { isEncryptedFileBuffer, decryptFileArrayBuffer, isEncrypted, decryptContent } from './lib/crypto'
import { BEAM_PIN_RE, generateBeamPin } from './lib/beam'
import { checkRateLimit, getClientIp } from './lib/rateLimit'

// Re-export Durable Object so wrangler can register it
export { ClipRoom } from './durable/ClipRoom'
export { BeamRoom } from './durable/BeamRoom'

const app = new Hono<{ Bindings: Env }>()

// ── Global middleware ─────────────────────────────────────────────────────────

app.use('*', securityHeaders())
app.use('*', (c, next) => strictCors(c.env.FRONTEND_ORIGIN)(c, next))

// ── Global Error Handler ──────────────────────────────────────────────────────

app.onError((err, c) => {
  console.error('Worker global error:', err)
  console.error('internal error:', err)
  return c.json({ error: 'internal_error', message: 'Something went wrong on the server. Please try again.' }, 500)
})

// ── Routes ────────────────────────────────────────────────────────────────────

// Quote proxy: the upstream Quotes API only allows an origin allowlist for browsers,
// so we fetch server-side (no Origin header) and hand the browser a tiny JSON payload.
const QUOTES_API = 'https://quotes-api-ruddy.vercel.app/quotes/random'
app.get('/api/quote', async (c) => {
  try {
    const res = await fetch(QUOTES_API, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return c.json({ error: 'quote_unavailable' }, 502)
    const json = await res.json() as { data?: { text?: unknown; author?: unknown } }
    const text = typeof json?.data?.text === 'string' ? json.data.text : ''
    if (!text) return c.json({ error: 'quote_unavailable' }, 502)
    const author = typeof json.data?.author === 'string' && json.data.author ? json.data.author : 'Unknown'
    c.header('Cache-Control', 'no-store')
    return c.json({ text, author })
  } catch {
    return c.json({ error: 'quote_unavailable' }, 502)
  }
})

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
app.get('/api/admin/live-rooms',      handleAdminLiveRooms)
app.delete('/api/admin/live/:slug',   handleAdminDeleteLiveRoom)

// ── Live Pad Authentication Helper ───────────────────────────────────────────
async function verifyLiveRoomAuth(c: any, slug: string): Promise<{ authorized: boolean; state?: any }> {
  if (!c.env.CLIP_DO) return { authorized: true }
  const id = c.env.CLIP_DO.idFromName(slug)
  const obj = c.env.CLIP_DO.get(id)
  const res = await obj.fetch(`https://clip-do/room/${slug}/live-state`)
  if (!res.ok) return { authorized: true }
  const data = await res.json() as { isProtected?: boolean; salt?: string; totalFileSize?: number; fileCount?: number }
  if (!data?.isProtected) return { authorized: true, state: data }

  const authHeader = c.req.header('x-auth-hash')
  const pass = c.req.header('x-password') || c.req.header('x-pass') || c.req.query('password') || c.req.query('pass') || c.req.query('p')
  
  if (authHeader) {
    const authRes = await obj.fetch(`https://clip-do/room/${slug}/live-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash: authHeader }),
    })
    const authedData = authRes.ok ? await authRes.json().catch(() => data) : data
    return { authorized: authRes.ok, state: authedData }
  }

  if (pass && data.salt) {
    const enc = new TextEncoder()
    // Standard frontend computeAuthHash: SHA-256(`${pass}:${data.salt}`)
    const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(`${pass}:${data.salt}`))
    const hash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('')
    const authRes = await obj.fetch(`https://clip-do/room/${slug}/live-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash }),
    })
    if (authRes.ok) {
      const authedData = await authRes.json().catch(() => data)
      return { authorized: true, state: authedData }
    }

    // Fallback: legacy salt+pass without delimiter
    const legBuf = await crypto.subtle.digest('SHA-256', enc.encode(data.salt + pass))
    const legHash = Array.from(new Uint8Array(legBuf)).map(b => b.toString(16).padStart(2, '0')).join('')
    const legRes = await obj.fetch(`https://clip-do/room/${slug}/live-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash: legHash }),
    })
    const authedData = legRes.ok ? await legRes.json().catch(() => data) : data
    return { authorized: legRes.ok, state: authedData }
  }

  return { authorized: false, state: data }
}

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

    // 4. Atomically claim the slug and register initial live room record
    const now = Date.now()
    const expiresAt = now + 86_400 * 1000
    const meta = {
      slug: candidate,
      createdAt: now,
      updatedAt: now,
      expiresAt,
      isProtected: false,
      fileCount: 0,
      totalFileSize: 0,
      textLength: 0,
      peers: 0,
    }
    await c.env.PASTE_KV.put(liveKey, '1', { expirationTtl: KV_TTL_30D })
    await c.env.PASTE_KV.put(`live_room:${candidate}`, JSON.stringify(meta), {
      expirationTtl: 86_400,
      metadata: meta,
    })

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

// Fetch initial state for Live Pad (auto-seeds from KV if fresh)
app.get('/api/live/:slug', async (c) => {
  if (!c.env.CLIP_DO) return c.json({ error: 'live_unavailable' }, 503)
  const slug = c.req.param('slug') ?? ''
  if (!slug) return c.json({ error: 'not_found' }, 404)
  const id  = c.env.CLIP_DO.idFromName(slug)
  const obj = c.env.CLIP_DO.get(id)
  const res = await obj.fetch(`https://clip-do/room/${slug}/live-state`)
  let data = await res.json() as { text: string; files: any[]; peers: number; isProtected?: boolean; salt?: string }

  // Auto-seed from PASTE_KV if room is brand new & unseeded
  if (!data.isProtected && (!data.text || data.text === '') && (!data.files || data.files.length === 0)) {
    const entry = await getEntry(c.env.PASTE_KV, slug)
    if (entry && ((!entry.isPermanent && Date.now() <= entry.expiresAt) || entry.isPermanent)) {
      const seedRes = await obj.fetch(`https://clip-do/room/${slug}/seed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: entry.content || '',
          files: entry.files || [],
        }),
      })
      if (seedRes.ok) {
        const refreshed = await obj.fetch(`https://clip-do/room/${slug}/live-state`)
        data = await refreshed.json()
      }
    }
  }

  return c.json(data, 200, {
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  })
})

// Authenticated state fetch for password-protected Live Pad
app.post('/api/live/:slug/auth', async (c) => {
  if (!c.env.CLIP_DO) return c.json({ error: 'live_unavailable' }, 503)
  const slug = c.req.param('slug') ?? ''
  if (!slug) return c.json({ error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const id  = c.env.CLIP_DO.idFromName(slug)
  const obj = c.env.CLIP_DO.get(id)
  const res = await obj.fetch(`https://clip-do/room/${slug}/live-state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  return c.json(data, res.status as any, {
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  })
})

// Update room password protection / security
app.post('/api/live/:slug/security', async (c) => {
  if (!c.env.CLIP_DO) return c.json({ error: 'live_unavailable' }, 503)
  const slug = c.req.param('slug') ?? ''
  if (!slug) return c.json({ error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const id  = c.env.CLIP_DO.idFromName(slug)
  const obj = c.env.CLIP_DO.get(id)

  // If caller provided currentPassword, automatically compute currentHash
  if (body && !body.currentHash && (body.currentPassword || c.req.header('x-password'))) {
    const curPass = body.currentPassword || c.req.header('x-password')
    try {
      const stateRes = await obj.fetch(`https://clip-do/room/${slug}/live-state`)
      if (stateRes.ok) {
        const stateData = await stateRes.json() as { salt?: string }
        if (stateData?.salt) {
          const enc = new TextEncoder()
          const buf = await crypto.subtle.digest('SHA-256', enc.encode(`${curPass}:${stateData.salt}`))
          body.currentHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
        }
      }
    } catch {}
  }

  if (body && !body.authHash && body.newHash) {
    body.authHash = body.newHash
  }

  const res = await obj.fetch(`https://clip-do/room/${slug}/security`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  return c.json(data, res.status as any)
})

// Explicit seed endpoint from frontend
app.post('/api/live/:slug/seed', async (c) => {
  if (!c.env.CLIP_DO) return c.json({ error: 'live_unavailable' }, 503)
  const slug = c.req.param('slug') ?? ''
  if (!slug) return c.json({ error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const id  = c.env.CLIP_DO.idFromName(slug)
  const obj = c.env.CLIP_DO.get(id)
  const res = await obj.fetch(`https://clip-do/room/${slug}/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  return c.json(data, res.status as any)
})

// Upload a live file/image
app.post('/api/live/:slug/upload', async (c) => {
  if (!c.env.CLIP_DO) return c.json({ error: 'live_unavailable' }, 503)
  const slug = c.req.param('slug') ?? ''
  if (!slug) return c.json({ error: 'not_found' }, 404)

  const authCheck = await verifyLiveRoomAuth(c, slug)
  if (!authCheck.authorized) {
    return c.json({ error: 'unauthorized', message: 'Password required to upload files to this private room.' }, 401)
  }

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

  // Enforce room-level cumulative storage ceiling (100 MB or 30 files)
  const currentTotal = authCheck.state?.totalFileSize || 0
  const currentCount = authCheck.state?.fileCount || 0
  if (currentCount >= 30 || currentTotal + rawFile.size > 100 * 1024 * 1024) {
    return c.json({ error: 'room_storage_limit_exceeded', message: 'Room has reached maximum storage limit (100 MB or 30 files).' }, 400)
  }

  // Validate MIME magic bytes (skip if client-side encrypted container)
  let isEncrypted = false
  try {
    const slice = await rawFile.slice(0, 4).arrayBuffer()
    const bytes = new Uint8Array(slice)
    isEncrypted = bytes[0] === 0x45 && bytes[1] === 0x4E && bytes[2] === 0x43 && bytes[3] === 0x31
  } catch {}

  if (!isEncrypted && !(await validateMime(rawFile))) {
    return c.json({ error: 'mime_mismatch', message: 'File contents do not match declared MIME type.' }, 400)
  }

  const cleanBase = (rawFile.name || 'file').split(/[/\\]/).pop() || 'file'
  const safeName = cleanBase.replace(/["\r\n]/g, '_').slice(0, 128)

  const fileId = `live_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  const fileBuffer = await rawFile.arrayBuffer()
  const TTL_24H = 86_400

  await putFileKV(c.env.PASTE_KV, slug, fileBuffer, TTL_24H, fileId)

  const inferredMime = (!rawFile.type || rawFile.type === 'application/octet-stream')
    ? getMimeType(safeName)
    : rawFile.type

  const fileItem = {
    id: fileId,
    fileName: safeName,
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

// Delete a single live file
app.delete('/api/live/:slug/file/:fileId', async (c) => {
  if (!c.env.CLIP_DO) return c.json({ error: 'live_unavailable' }, 503)
  const slug   = c.req.param('slug') ?? ''
  const fileId = c.req.param('fileId') ?? ''
  if (!slug || !fileId) return c.json({ error: 'not_found' }, 404)

  const authCheck = await verifyLiveRoomAuth(c, slug)
  if (!authCheck.authorized) {
    return c.json({ error: 'unauthorized', message: 'Password required to delete files from this private room.' }, 401)
  }

  await deleteFileKV(c.env.PASTE_KV, slug, fileId)

  const id = c.env.CLIP_DO.idFromName(slug)
  const obj = c.env.CLIP_DO.get(id)
  await obj.fetch(`https://clip-do/room/${slug}/live-file/${fileId}`, {
    method: 'DELETE',
  })

  return c.json({ ok: true })
})

// Batch delete files from Live Pad
app.post('/api/live/:slug/files/delete', async (c) => {
  if (!c.env.CLIP_DO) return c.json({ error: 'live_unavailable' }, 503)
  const slug = c.req.param('slug') ?? ''
  if (!slug) return c.json({ error: 'not_found' }, 404)

  const authCheck = await verifyLiveRoomAuth(c, slug)
  if (!authCheck.authorized) {
    return c.json({ error: 'unauthorized', message: 'Password required to delete files from this private room.' }, 401)
  }

  const body = await c.req.json().catch(() => ({})) as { fileIds?: string[] }
  const fileIds = body?.fileIds
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return c.json({ error: 'missing_file_ids' }, 400)
  }

  // Delete all binaries from KV
  for (const fileId of fileIds) {
    await deleteFileKV(c.env.PASTE_KV, slug, fileId)
  }

  // Notify DO
  const id = c.env.CLIP_DO.idFromName(slug)
  const obj = c.env.CLIP_DO.get(id)
  await obj.fetch(`https://clip-do/room/${slug}/live-files-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds }),
  })

  return c.json({ ok: true, deletedCount: fileIds.length })
})

// Stream/View live file binary
app.get('/api/live/:slug/file/:fileId', async (c) => {
  const slug   = c.req.param('slug') ?? ''
  const fileId = c.req.param('fileId') ?? ''
  if (!slug || !fileId) return c.json({ error: 'not_found' }, 404)

  const authCheck = await verifyLiveRoomAuth(c, slug)
  if (!authCheck.authorized) {
    return c.text('Error: This file belongs to a protected Live Pad. Please authenticate or provide ?pass=<password>.\n', 401)
  }

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

// Live Pad ZIP archive download
app.get('/api/live/:slug/zip', async (c) => {
  if (!c.env.CLIP_DO) return c.json({ error: 'live_unavailable' }, 503)
  const slug = c.req.param('slug') ?? ''
  if (!slug) return c.json({ error: 'not_found' }, 404)

  const authCheck = await verifyLiveRoomAuth(c, slug)
  if (!authCheck.authorized) {
    return c.text('Error: This Live Pad is password protected. Please provide ?pass=<password> or authenticate via web interface.\n', 401)
  }

  const data = authCheck.state || {}
  const password = c.req.header('x-password') || c.req.header('x-pass') || c.req.query('password') || c.req.query('pass') || c.req.query('p')
  const zipFiles: Record<string, Uint8Array> = {}

  if (data.text) {
    let textToZip = data.text
    if (password && isEncrypted(data.text)) {
      const decText = await decryptContent(data.text, password)
      if (decText !== null) textToZip = decText
    }
    zipFiles[`${slug}.txt`] = strToU8(textToZip)
  }

  const MAX_ZIP_SIZE_MB = 25
  let totalFileSize = 0

  if (Array.isArray(data.files)) {
    for (const file of data.files) {
      const buf = await getFileKV(c.env.PASTE_KV, slug, file.id)
      if (buf) {
        totalFileSize += buf.byteLength
        if (totalFileSize > MAX_ZIP_SIZE_MB * 1024 * 1024) {
          return c.json({ error: 'zip_too_large' }, 413)
        }

        let fileBytes: ArrayBuffer | Uint8Array = buf
        let name = file.fileName || file.id

        if (password && isEncryptedFileBuffer(buf)) {
          const dec = await decryptFileArrayBuffer(buf, password)
          if (dec) {
            fileBytes = dec.buffer
            name = dec.fileName
          }
        }

        const cleanBase = (name || file.id).split(/[/\\]/).pop() || file.id
        name = cleanBase.replace(/[^a-zA-Z0-9_.-]/g, '_')
        if (zipFiles[name]) {
          const parts = name.split('.')
          const ext = parts.length > 1 ? `.${parts.pop()}` : ''
          const base = parts.join('.')
          let cNum = 2
          while (zipFiles[name]) {
            name = `${base} (${cNum})${ext}`
            cNum++
          }
        }
        zipFiles[name] = fileBytes instanceof Uint8Array ? fileBytes : new Uint8Array(fileBytes)
      }
    }
  }

  if (Object.keys(zipFiles).length === 0) {
    zipFiles[`${slug}.txt`] = strToU8('')
  }

  const zipped = zipSync(zipFiles)
  return new Response(zipped, {
    headers: {
      'Content-Type':        'application/zip',
      'Content-Disposition': `attachment; filename="${slug}-live.zip"`,
      'Cache-Control':       'no-cache, must-revalidate',
      'Pragma':              'no-cache',
    },
  })
})

// ── Clip Beam signalling ─────────────────────────────────────────────────────
// WebSocket to a BeamRoom DO that relays WebRTC SDP/ICE between two browsers. File bytes never
// come here. No `pin` = a sender opening a room (the worker picks a free PIN); `?pin=` = a receiver.
app.get('/api/beam/ws', async (c) => {
  if (!c.env.BEAM_DO) return c.json({ error: 'beam_unavailable' }, 503)
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'expected_websocket' }, 426)
  }
  const roomRequest = (pin: string, role: 'sender' | 'receiver') =>
    c.env.BEAM_DO.get(c.env.BEAM_DO.idFromName(pin)).fetch(
      new Request(`https://beam-do/ws?role=${role}&pin=${pin}`, { headers: c.req.raw.headers }),
    )

  const pin = c.req.query('pin')
  if (pin !== undefined) {
    if (!BEAM_PIN_RE.test(pin)) return c.json({ error: 'invalid_pin' }, 400)
    const limit = await checkRateLimit(c.env.PASTE_KV, 'beam:join', getClientIp(c.req.raw))
    if (limit.limited) return c.json({ error: 'rate_limited', retryAfter: limit.retryAfter }, 429)
    return roomRequest(pin, 'receiver')
  }

  for (let i = 0; i < 8; i++) {
    const res = await roomRequest(generateBeamPin(), 'sender')
    if (res.status !== 409) return res
  }
  return c.json({ error: 'pin_exhausted' }, 503)
})

// Health check
app.get('/api/health', (c) => c.json({ ok: true }))

export default app
