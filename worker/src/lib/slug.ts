import { customAlphabet } from 'nanoid'

// ─── Reserved slugs ───────────────────────────────────────────────────────────

const RESERVED = new Set([
  'api', 'edit', 'new', 'create', 'help', 'about',
  '404', 'not-found', 'admin', 'login', 'signup',
  'static', '_next', '_headers', '_redirects',
  'favicon.ico', 'robots.txt', 'sitemap.xml',
  'raw', 'zip', 'r', 'z', 'f',
])

// ─── Auto-generator ───────────────────────────────────────────────────────────

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 8)

export function generateSlug(): string {
  return nanoid()
}

// ─── Validation ───────────────────────────────────────────────────────────────

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/

export type SlugValidationResult =
  | { valid: true }
  | { valid: false; reason: 'too_short' | 'too_long' | 'invalid_chars' | 'reserved' }

export function validateSlug(slug: string): SlugValidationResult {
  if (slug.length < 3)  return { valid: false, reason: 'too_short' }
  if (slug.length > 50) return { valid: false, reason: 'too_long' }
  if (!SLUG_REGEX.test(slug)) return { valid: false, reason: 'invalid_chars' }
  if (RESERVED.has(slug))     return { valid: false, reason: 'reserved' }
  return { valid: true }
}

export function isReserved(slug: string): boolean {
  return RESERVED.has(slug)
}
