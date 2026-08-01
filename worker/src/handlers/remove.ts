import type { Context } from 'hono'
import type { Env } from '../lib/types'
import { getEntry, deleteEntry } from '../lib/kv'
import { verifyCode } from '../lib/crypto'
import { log } from '../lib/logger'
import { getClientIp } from '../lib/rateLimit'

export async function handleRemove(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param('slug') ?? ''
  if (!slug) return c.json({ error: 'not_found' }, 404)
  const ip   = getClientIp(c.req.raw)

  let body: { editCode?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const { editCode } = body
  if (!editCode) return c.json({ error: 'wrong_edit_code' }, 403)

  const entry = await getEntry(c.env.PASTE_KV, slug)
  if (!entry) return c.json({ error: 'not_found' }, 404)

  const valid = await verifyCode(
    editCode,
    entry.editCodeSalt,
    c.env.APP_PEPPER,
    entry.editCodeHash,
  )

  if (!valid) {
    await log('auth.failed', { slug, ip }, c.env)
    return c.json({ error: 'wrong_edit_code' }, 403)
  }

  await deleteEntry(c.env.PASTE_KV, slug)

  await log('entry.deleted', { slug }, c.env)
  return c.json({ success: true })
}
