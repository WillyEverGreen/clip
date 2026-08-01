import type { MiddlewareHandler } from 'hono'

/**
 * Adds security response headers to every Worker response.
 * Applied globally via app.use('*', securityHeaders())
 */
export const securityHeaders = (): MiddlewareHandler => async (c, next) => {
  await next()

  // Prevent browsers from sniffing content type
  c.header('X-Content-Type-Options', 'nosniff')

  // Block framing (clickjacking)
  c.header('X-Frame-Options', 'DENY')

  // Don't send referrer to third parties
  c.header('Referrer-Policy', 'no-referrer')

  // Restrict browser features
  c.header('Permissions-Policy', 'geolocation=(), camera=(), microphone=()')
}
