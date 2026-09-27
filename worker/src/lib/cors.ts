import { cors } from 'hono/cors'

/**
 * Flexible CORS — allows local development and production Pages domain.
 */
export function strictCors(configuredOrigin?: string) {
  return cors({
    origin: (reqOrigin) => {
      if (!reqOrigin) return configuredOrigin || '*'
      if (
        reqOrigin.includes('localhost') ||
        reqOrigin.endsWith('.pages.dev') ||
        reqOrigin.endsWith('.foo.ng') ||
        reqOrigin === configuredOrigin
      ) {
        return reqOrigin
      }
      return configuredOrigin || '*'
    },
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'x-password',
      'x-pass',
      'If-None-Match',
      'Cache-Control',
      'Pragma',
      'Accept',
      'Origin',
      'X-Requested-With',
    ],
    exposeHeaders: ['ETag', 'Content-Disposition', 'Content-Length'],
    maxAge: 86400, // 24h preflight cache
  })
}
