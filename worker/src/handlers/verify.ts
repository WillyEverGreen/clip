import type { Context } from 'hono'
import type { Env } from '../lib/types'
import { getEntry } from '../lib/kv'
import { verifyCode } from '../lib/crypto'

// ── POST /api/entry/:slug/verify ──────────────────────────────────────────────
// Used by the Edit page to check the edit code before showing the edit form.

export async function handleVerify(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param('slug') ?? ''
  if (!slug) return c.json({ valid: false }, 200)

  let body: { editCode?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const { editCode } = body
  if (!editCode) return c.json({ valid: false }, 200)

  const entry = await getEntry(c.env.PASTE_KV, slug)
  if (!entry)  return c.json({ valid: false }, 200)
  if (Date.now() > entry.expiresAt) return c.json({ valid: false }, 200)

  const pepper = c.env.APP_PEPPER || 'clip_default_pepper'
  const valid  = await verifyCode(
    editCode,
    entry.editCodeSalt,
    pepper,
    entry.editCodeHash,
  )


  return c.json({ valid })
}
