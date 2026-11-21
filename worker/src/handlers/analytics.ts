/**
 * User Analytics & IP Exclusion Engine for Clip
 *
 * Privacy-preserving, cookieless, edge-native analytics endpoints.
 * - Public beacon: POST /api/analytics/event
 * - Admin analytics: GET /api/admin/analytics
 * - Admin IP exclusion: GET & POST /api/admin/analytics/excluded-ips
 * - Admin detected IP: GET /api/admin/analytics/detected-ip
 */

import type { Context } from 'hono'
import type { Env } from '../lib/types'
import { getClientIp } from '../lib/rateLimit'
import { getAdminAuthStatus } from './admin'

/**
 * Sanitizes request paths to ensure private entry slugs are never stored in plain text.
 */
export function sanitizePath(rawPath: string): string {
  const p = (rawPath || '').split('?')[0].trim()
  if (['', '/', '/about', '/beam', '/live'].includes(p)) return p || '/'
  if (p.startsWith('/live/')) return '/live/:slug'
  if (p.startsWith('/b/')) return '/b/:slug'
  if (p.startsWith('/admin')) return '/admin'
  // Generic single-segment slug (e.g. /my-slug or /my-slug/edit)
  const parts = p.split('/').filter(Boolean)
  if (parts.length === 1) return '/:slug'
  if (parts.length === 2 && parts[1] === 'edit') return '/:slug/edit'
  return '/other'
}

/**
 * Classifies User-Agent into desktop, tablet, or mobile.
 */
export function parseDevice(ua: string): 'mobile' | 'tablet' | 'desktop' {
  if (!ua) return 'desktop'
  if (/iPad|tablet|(android(?!.*mobile))/i.test(ua)) return 'tablet'
  if (/Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Opera Mini/i.test(ua)) return 'mobile'
  return 'desktop'
}

/**
 * Matches crawlers, link-preview unfurlers, audit tools and scripted clients.
 * Explicit names rather than a bare "bot" substring, so real devices such as
 * CUBOT phones are not mistaken for crawlers.
 */
const BOT_UA_RE = new RegExp(
  [
    // Search engines & AI crawlers
    'googlebot', 'google-inspectiontool', 'bingbot', 'bingpreview', 'msnbot', 'yandex', 'baiduspider',
    'duckduckbot', 'applebot', 'slurp', 'sogou', 'exabot', 'petalbot', 'bytespider', 'gptbot',
    'chatgpt-user', 'claudebot', 'anthropic-ai', 'ccbot', 'perplexitybot', 'youbot',
    // SEO, audit and uptime tools
    'ahrefs', 'semrush', 'mj12bot', 'dotbot', 'screaming frog', 'lighthouse', 'pagespeed', 'gtmetrix',
    'pingdom', 'uptimerobot', 'statuscake', 'headlesschrome', 'phantomjs', 'selenium',
    // Link previews and social unfurlers
    'facebookexternalhit', 'facebookcatalog', 'twitterbot', 'linkedinbot', 'slackbot', 'discordbot',
    'telegrambot', 'whatsapp', 'pinterest', 'embedly', 'quora link preview', 'skypeuripreview',
    'vkshare', 'redditbot',
    // Scripts and CLI clients
    'python-requests', 'python-urllib', 'aiohttp', 'curl/', 'wget/', 'go-http-client', 'node-fetch',
    'undici', 'axios/', 'httpclient', 'okhttp', 'scrapy', 'libwww-perl',
  ].join('|'),
  'i'
)

/**
 * True when a User-Agent is a crawler, preview fetcher or scripted client,
 * i.e. not a genuine visitor page view.
 */
export function isBotRequest(userAgent: string | undefined | null): boolean {
  const ua = (userAgent || '').trim()
  // Browsers always send a User-Agent; an absent one is not proof of a bot
  if (!ua) return false
  return BOT_UA_RE.test(ua)
}

/**
 * Computes a monthly rotating SHA-256 hash for privacy-preserving unique visitor counting.
 * Formula: SHA256(ip + '-' + yearMonth + '-' + pepper)
 */
export async function getVisitorHash(ip: string, pepper = 'clip-pepper', date = new Date()): Promise<string> {
  const yearMonth = date.toISOString().slice(0, 7)
  const data = new TextEncoder().encode(`${ip}-${yearMonth}-${pepper}`)
  const hashBuf = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuf))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Retrieves the list of excluded IPs from KV namespace.
 */
export async function getExcludedIps(kv: KVNamespace): Promise<string[]> {
  try {
    const raw = await kv.get('analytics:excluded_ips')
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/**
 * Strips query parameters or paths from referrers, preserving domain only for privacy.
 */
export function cleanReferrer(rawReferrer?: string): string {
  if (!rawReferrer || typeof rawReferrer !== 'string') return 'direct'
  const trimmed = rawReferrer.trim()
  if (!trimmed || trimmed === 'direct') return 'direct'
  try {
    const parsed = new URL(trimmed)
    return parsed.hostname.toLowerCase()
  } catch {
    return trimmed.slice(0, 100)
  }
}

// ─── Public Beacon Handler ───────────────────────────────────────────────────

/**
 * POST /api/analytics/event
 * Records page view events from the client beacon.
 * Silently drops events (returns 204) for:
 * 1. Requests from authenticated admins
 * 2. Paths matching or starting with /admin
 * 3. Client IPs listed in analytics:excluded_ips
 */
export async function handleAnalyticsEvent(c: Context<{ Bindings: Env }>) {
  // Exclusion Rule 1: Authenticated admin requests are never recorded
  const adminSecret = c.env.ADMIN_SECRET?.trim()
  const authHeader = c.req.header('Authorization')
  if (adminSecret && authHeader) {
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim()
    if (token === adminSecret) {
      return c.body(null, 204)
    }
  }

  // Parse beacon payload safely
  let body: { path?: string; referrer?: string } = {}
  try {
    const text = await c.req.text()
    if (text) {
      body = JSON.parse(text)
    }
  } catch {
    // Graceful fallback to default empty body
  }

  const rawPath = typeof body.path === 'string' ? body.path.trim() : '/'

  // Exclusion Rule 2: Paths under /admin are never recorded
  if (rawPath === '/admin' || rawPath.startsWith('/admin/')) {
    return c.body(null, 204)
  }

  const sanitized = sanitizePath(rawPath)
  if (sanitized === '/admin') {
    return c.body(null, 204)
  }

  // Exclusion Rule 3: Excluded IP addresses in KV are never recorded
  const ip = getClientIp(c.req.raw)
  if (c.env.PASTE_KV) {
    const excludedIps = await getExcludedIps(c.env.PASTE_KV)
    if (excludedIps.includes(ip)) {
      return c.body(null, 204)
    }
  }

  // Exclusion Rule 4: crawlers, link previews and scripted clients are not genuine visitors
  const ua = c.req.header('User-Agent') || ''
  if (isBotRequest(ua)) {
    return c.body(null, 204)
  }

  // Derive metadata
  const device = parseDevice(ua)
  const country = (c.req.raw as unknown as { cf?: { country?: string } }).cf?.country || c.req.header('CF-IPCountry') || 'Unknown'
  const visitorHash = await getVisitorHash(ip, c.env.APP_PEPPER || 'clip-pepper')
  const referrer = cleanReferrer(body.referrer)

  if (c.env.ANALYTICS_DO) {
    try {
      const id = c.env.ANALYTICS_DO.idFromName('global')
      const store = c.env.ANALYTICS_DO.get(id)
      await store.recordEvent({
        path: sanitized,
        referrer,
        country,
        device,
        visitorHash,
      })
    } catch (err) {
      console.error('Analytics recordEvent error:', err)
    }
  }

  return c.body(null, 204)
}

// ─── Admin Analytics Handlers ─────────────────────────────────────────────────

/**
 * GET /api/admin/analytics
 * Retrieves aggregate statistics (today, 7d, 30d). Requires admin authentication.
 */
export async function handleAdminAnalytics(c: Context<{ Bindings: Env }>) {
  const authStatus = getAdminAuthStatus(c)
  if (authStatus === 'unconfigured') {
    return c.json({ error: 'unconfigured', message: 'ADMIN_SECRET secret is not set on the worker.' }, 500)
  }
  if (authStatus === 'unauthorized') {
    return c.json({ error: 'unauthorized', message: 'Invalid admin secret key' }, 401)
  }

  if (!c.env.ANALYTICS_DO) {
    return c.json({ error: 'analytics_unavailable', message: 'ANALYTICS_DO Durable Object binding is missing' }, 503)
  }

  const rawRange = c.req.query('range') || 'today'
  const range = (rawRange === '7d' || rawRange === '30d' ? rawRange : 'today') as 'today' | '7d' | '30d'

  try {
    const id = c.env.ANALYTICS_DO.idFromName('global')
    const store = c.env.ANALYTICS_DO.get(id)
    const stats = await store.getStats(range)
    return c.json(stats)
  } catch (err) {
    console.error('Analytics getStats error:', err)
    return c.json({ error: 'internal_error', message: 'Failed to retrieve analytics data' }, 500)
  }
}

/**
 * GET & POST /api/admin/analytics/excluded-ips
 * Manages the list of excluded IP addresses in KV.
 */
export async function handleAdminExcludedIps(c: Context<{ Bindings: Env }>) {
  const authStatus = getAdminAuthStatus(c)
  if (authStatus === 'unconfigured') {
    return c.json({ error: 'unconfigured', message: 'ADMIN_SECRET secret is not set on the worker.' }, 500)
  }
  if (authStatus === 'unauthorized') {
    return c.json({ error: 'unauthorized', message: 'Invalid admin secret key' }, 401)
  }

  const kv = c.env.PASTE_KV
  if (!kv) {
    return c.json({ error: 'kv_unavailable', message: 'PASTE_KV is not configured' }, 500)
  }

  if (c.req.method === 'GET') {
    const excludedIps = await getExcludedIps(kv)
    return c.json({ excludedIps })
  }

  if (c.req.method === 'POST') {
    let body: { action?: string; ip?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json', message: 'Body must be valid JSON' }, 400)
    }

    const { action, ip } = body || {}
    if (!action || !ip || typeof ip !== 'string' || (action !== 'add' && action !== 'remove')) {
      return c.json({ error: 'invalid_params', message: 'action must be "add" or "remove" and ip must be a string' }, 400)
    }

    const targetIp = ip.trim()
    if (!targetIp) {
      return c.json({ error: 'invalid_ip', message: 'ip must not be empty' }, 400)
    }

    const currentIps = await getExcludedIps(kv)
    let updatedIps: string[]

    if (action === 'add') {
      if (!currentIps.includes(targetIp)) {
        updatedIps = [...currentIps, targetIp]
      } else {
        updatedIps = currentIps
      }
    } else {
      updatedIps = currentIps.filter((item) => item !== targetIp)
    }

    await kv.put('analytics:excluded_ips', JSON.stringify(updatedIps))
    return c.json({ success: true, excludedIps: updatedIps })
  }

  return c.json({ error: 'method_not_allowed' }, 405)
}

/**
 * GET /api/admin/analytics/detected-ip
 * Returns the current requester's detected IP address for one-click exclusion in the UI.
 */
export async function handleAdminDetectedIp(c: Context<{ Bindings: Env }>) {
  const authStatus = getAdminAuthStatus(c)
  if (authStatus === 'unconfigured') {
    return c.json({ error: 'unconfigured', message: 'ADMIN_SECRET secret is not set on the worker.' }, 500)
  }
  if (authStatus === 'unauthorized') {
    return c.json({ error: 'unauthorized', message: 'Invalid admin secret key' }, 401)
  }

  const ip = getClientIp(c.req.raw)
  return c.json({ ip })
}
