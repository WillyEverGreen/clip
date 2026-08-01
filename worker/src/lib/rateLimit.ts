/**
 * KV-based per-IP, per-endpoint rate limiter.
 * Keys auto-expire (TTL = 120s) — no manual cleanup needed.
 */

interface LimitConfig {
  max: number
  window: number // seconds
}

const LIMITS: Record<string, LimitConfig> = {
  create: { max: 10, window: 120 }, // 10 creates / 2 min / IP
  patch:  { max: 30, window: 120 }, // 30 edits   / 2 min / IP
}

export interface RateLimitResult {
  limited: boolean
  retryAfter?: number
}

export async function checkRateLimit(
  kv: KVNamespace,
  endpoint: keyof typeof LIMITS,
  ip: string,
): Promise<RateLimitResult> {
  try {
    const config = LIMITS[endpoint]
    if (!config || !kv) return { limited: false }

    const kvKey = `ratelimit:${endpoint}:${ip}`
    const raw   = await kv.get(kvKey)
    const count = raw ? parseInt(raw, 10) : 0

    if (count >= config.max) {
      return { limited: true, retryAfter: config.window }
    }

    // Expiration TTL in Cloudflare KV must be >= 60 seconds
    await kv.put(kvKey, String(count + 1), { expirationTtl: 120 })
    return { limited: false }
  } catch (err) {
    console.error('Rate limit KV error:', err)
    return { limited: false }
  }
}

// Extract client IP from Cloudflare request headers
export function getClientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown'
  )
}
