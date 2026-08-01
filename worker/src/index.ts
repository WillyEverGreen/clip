import { Hono } from 'hono'
import type { Env } from './lib/types'
import { securityHeaders } from './lib/headers'
import { strictCors } from './lib/cors'
import { handleCreate } from './handlers/create'
import { handleRead, handleReadFile } from './handlers/read'
import { handleVerify } from './handlers/verify'
import { handleUpdate } from './handlers/update'
import { handleRemove } from './handlers/remove'

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

// Read
app.get('/api/entry/:slug',           handleRead)
app.get('/api/entry/:slug/file',      handleReadFile)

// Verify edit code
app.post('/api/entry/:slug/verify',   handleVerify)

// Update
app.patch('/api/entry/:slug',         handleUpdate)

// Delete
app.delete('/api/entry/:slug',        handleRemove)

// Admin (Dynamic import so repository builds cleanly on GitHub without admin.ts)
app.get('/api/admin/entries', async (c) => {
  try {
    // @ts-ignore
    const mod = await import('./handlers/admin')
    return mod.handleAdminList(c)
  } catch {
    return c.json({ error: 'not_found' }, 404)
  }
})

app.delete('/api/admin/entry/:slug', async (c) => {
  try {
    // @ts-ignore
    const mod = await import('./handlers/admin')
    return mod.handleAdminDelete(c)
  } catch {
    return c.json({ error: 'not_found' }, 404)
  }
})

app.delete('/api/admin/purge', async (c) => {
  try {
    // @ts-ignore
    const mod = await import('./handlers/admin')
    return mod.handleAdminPurgeAll(c)
  } catch {
    return c.json({ error: 'not_found' }, 404)
  }
})



// ── Health check ──────────────────────────────────────────────────────────────


app.get('/api/health', (c) => c.json({ ok: true }))

// ── Default export ────────────────────────────────────────────────────────────

export default app
