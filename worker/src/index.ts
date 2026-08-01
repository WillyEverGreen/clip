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

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/api/health', (c) => c.json({ ok: true }))

// ── Default export ────────────────────────────────────────────────────────────

export default app
