import type { Context } from 'hono'
import type { Env } from '../lib/types'
import { getEntry, deleteEntry } from '../lib/kv'
import { verifyCode } from '../lib/crypto'
import { log } from '../lib/logger'
import { getClientIp } from '../lib/rateLimit'
import { notifyRoom } from '../lib/notify'

export async function handleRemove(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param('slug') ?? ''
  if (!slug) return c.json({ error: 'not_found' }, 404)
  const ip   = getClientIp(c.req.raw)

  // ── Rate limit ────────────────────────────────────────────────────────────
  const rl = await checkRateLimit(c.env.PASTE_KV, 'delete', ip)
  if (rl.limited) {
    await log('rate.limited', { endpoint: 'delete', ip }, c.env)
    return c.json({ error: 'rate_limited', retryAfter: rl.retryAfter }, 429, {
      'Retry-After': String(rl.retryAfter ?? 120)
    })
  }

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
  if (!entry.isPermanent && Date.now() > entry.expiresAt) return c.json({ error: 'expired' }, 404)

  const pepper = c.env.APP_PEPPER || 'clip_default_pepper'
  const valid  = await verifyCode(
    editCode,
    entry.editCodeSalt,
    pepper,
    entry.editCodeHash,
  )


  if (!valid) {
    await log('auth.failed', { slug, ip }, c.env)
    return c.json({ error: 'wrong_edit_code' }, 403)
  }

  await deleteEntry(c.env.PASTE_KV, slug)

  c.executionCtx?.waitUntil(notifyRoom(c.env, slug))
  await log('entry.deleted', { slug }, c.env)
  return c.json({ success: true })
}
