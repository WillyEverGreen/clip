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

  // Content Security Policy - defense against XSS
  c.header('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https:; " +
    "font-src 'self' data:; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'"
  )
}
