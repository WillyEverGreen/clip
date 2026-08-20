import type { Context } from 'hono'
import type { Env } from '../lib/types'
import { getEntry, putEntry, toPublic, getFileKV } from '../lib/kv'
import { isEncrypted, decryptContent } from '../lib/crypto'

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.\-]/g, '_').slice(0, 128)
}

// ── ETag helpers ──────────────────────────────────────────────────────────────

/**
 * Generates a stable ETag for an entry based on slug + last mutation time + file size.
 * Cheap to compute (no hashing) and safe for public cache validation.
 */
function makeETag(slug: string, updatedAt: number, extra?: number): string {
  return `"${slug}-${updatedAt}-${extra ?? 0}"`
}

/**
 * Returns true if the client already has a fresh copy (matching ETag).
 * Allows the handler to short-circuit with 304 Not Modified.
 */
function isNotModified(req: Request, etag: string): boolean {
  const ifNoneMatch = req.headers.get('If-None-Match')
  return ifNoneMatch === etag || ifNoneMatch === '*'
}

// ── GET /api/entry/:slug/file ─────────────────────────────────────────────────

export async function handleReadFile(c: Context<{ Bindings: Env }>) {
  const slug   = c.req.param('slug') ?? ''
  const fileId = c.req.query('fileId') || c.req.query('id')
  if (!slug) return c.json({ error: 'not_found' }, 404)
  const entry = await getEntry(c.env.PASTE_KV, slug)

  if (!entry || !entry.hasFile) return c.json({ error: 'not_found' }, 404)
  if (Date.now() > entry.expiresAt) return c.json({ error: 'expired' }, 404)
  if (entry.fileExpiresAt && Date.now() > entry.fileExpiresAt) return c.json({ error: 'expired' }, 404)

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

  // ── ETag / 304 for file downloads ─────────────────────────────────────────
  const etag = makeETag(slug, entry.updatedAt ?? entry.createdAt, fileSize)
  if (isNotModified(c.req.raw, etag)) {
    return new Response(null, {
      status: 304,
      headers: { 'ETag': etag, 'Cache-Control': 'public, max-age=10, stale-while-revalidate=60' },
    })
  }

  const fileData = await getFileKV(c.env.PASTE_KV, slug, fileId)
  if (!fileData) return c.json({ error: 'not_found' }, 404)

  const safeName = sanitizeFilename(fileName)

  return new Response(fileData, {
    headers: {
      'Content-Type':        fileMime,
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Length':      String(fileSize || fileData.byteLength),
      'ETag':                etag,
      'Cache-Control':       'public, max-age=10, stale-while-revalidate=60',
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

  // Self-heal: clear expired files (non-blocking — don't delay the response)
  if (entry.fileExpiresAt && Date.now() > entry.fileExpiresAt && entry.hasFile) {
    entry.hasFile = false
    entry.fileName = undefined
    entry.fileMime = undefined
    entry.fileSize = undefined
    entry.files = undefined
    entry.fileExpiresAt = undefined
    // Non-blocking: self-heal write does not block response
    c.executionCtx?.waitUntil(putEntry(c.env.PASTE_KV, entry))
  }

  // ── ETag / 304 for raw text ────────────────────────────────────────────────
  const etag = makeETag(slug, entry.updatedAt ?? entry.createdAt)
  if (isNotModified(c.req.raw, etag)) {
    // Still increment view count in background even on 304
    entry.views = (entry.views ?? 0) + 1
    c.executionCtx?.waitUntil(putEntry(c.env.PASTE_KV, entry))
    return new Response(null, {
      status: 304,
      headers: { 'ETag': etag, 'Cache-Control': 'no-cache' },
    })
  }

  // ── Increment view count non-blocking ──────────────────────────────────────
  // Response is returned immediately; KV write happens in background.
  entry.views = (entry.views ?? 0) + 1
  c.executionCtx?.waitUntil(putEntry(c.env.PASTE_KV, entry))

  if (entry.type === 'file' || (!entry.content && entry.hasFile)) {
    return handleReadFile(c)
  }

  let textContent = entry.content ?? ''

  // If content is encrypted, check if password was provided in query or header
  if (textContent && isEncrypted(textContent)) {
    const password = c.req.header('x-password') || c.req.header('x-pass') || c.req.query('password') || c.req.query('pass') || c.req.query('p')
    if (password) {
      const decrypted = await decryptContent(textContent, password)
      if (decrypted !== null) {
        return new Response(decrypted, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        })
      }
      return c.text(`Error: Incorrect password for encrypted paste /${slug}.\nUsage: curl -sL "https://clip.foo.ng/r/${slug}?pass=<password>"\n`, 401)
    }
  }

  return new Response(textContent, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'ETag':         etag,
      'Cache-Control': 'no-cache',
    },
  })
}

// ── GET /api/entry/:slug ──────────────────────────────────────────────────────

export async function handleRead(c: Context<{ Bindings: Env }>) {
  const slug  = c.req.param('slug') ?? ''
  if (!slug) return c.json({ error: 'not_found' }, 404)
  const entry = await getEntry(c.env.PASTE_KV, slug)

  if (!entry) return c.json({ error: 'not_found' }, 404)
  if (Date.now() > entry.expiresAt) return c.json({ error: 'expired' }, 404)

  // Self-heal: clear expired files (non-blocking — don't delay the response)
  if (entry.fileExpiresAt && Date.now() > entry.fileExpiresAt && entry.hasFile) {
    entry.hasFile = false
    entry.fileName = undefined
    entry.fileMime = undefined
    entry.fileSize = undefined
    entry.files = undefined
    entry.fileExpiresAt = undefined
    c.executionCtx?.waitUntil(putEntry(c.env.PASTE_KV, entry))
  }

  const userAgent = c.req.header('user-agent')?.toLowerCase() || ''
  const accept = c.req.header('accept')?.toLowerCase() || ''
  const isCli = userAgent.includes('curl') || userAgent.includes('wget')

  if (isCli && !accept.includes('application/json')) {
    return handleReadRaw(c)
  }

  const isPolling = !!c.req.query('_t') || c.req.query('poll') === 'true'

  // ── ETag / 304 for JSON API ────────────────────────────────────────────────
  const etag = makeETag(slug, entry.updatedAt ?? entry.createdAt)
  if (isNotModified(c.req.raw, etag)) {
    // Skip incrementing view count in background if it's a polling/refresh request
    if (!isPolling) {
      entry.views = (entry.views ?? 0) + 1
      c.executionCtx?.waitUntil(putEntry(c.env.PASTE_KV, entry))
    }
    return new Response(null, {
      status: 304,
      headers: { 'ETag': etag, 'Cache-Control': 'no-cache' },
    })
  }

  // ── Increment view count non-blocking ──────────────────────────────────────
  if (!isPolling) {
    entry.views = (entry.views ?? 0) + 1
    c.executionCtx?.waitUntil(putEntry(c.env.PASTE_KV, entry))
  }

  return c.json(toPublic(entry), 200, {
    'ETag':          etag,
    'Cache-Control': 'no-cache',
  })
}
