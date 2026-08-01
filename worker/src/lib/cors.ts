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
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600, // 10 min preflight cache

  })
}
