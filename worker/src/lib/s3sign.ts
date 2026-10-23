/**
 * Minimal AWS Signature V4 for an S3-compatible bucket (Backblaze B2), using only Web Crypto.
 *
 * Two uses: `presign` builds a time-limited URL the browser can PUT to or GET from directly, and
 * `s3Fetch` makes a signed request from the worker (multipart start/finish, HEAD, DELETE).
 */

export interface S3Config {
  /** e.g. https://s3.us-east-005.backblazeb2.com (no trailing slash) */
  endpoint: string
  region: string
  bucket: string
  keyId: string
  secret: string
}

const enc = new TextEncoder()

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data
  return hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', k, enc.encode(data))
}

/** RFC 3986 percent-encoding, as SigV4 requires (encodeURIComponent leaves ! ' ( ) * alone). */
export function uriEncode(s: string, keepSlash = false): string {
  const out = encodeURIComponent(s).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase())
  return keepSlash ? out.replace(/%2F/g, '/') : out
}

function amzDates(now: Date): { date: string; stamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '') // 20130524T000000Z
  return { date: iso.slice(0, 8), stamp: iso }
}

async function signingKey(secret: string, date: string, region: string): Promise<ArrayBuffer> {
  const kDate = await hmac(enc.encode('AWS4' + secret), date)
  const kRegion = await hmac(kDate, region)
  const kService = await hmac(kRegion, 's3')
  return hmac(kService, 'aws4_request')
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k]!)}`)
    .join('&')
}

/** Path-style location of an object: /bucket/key */
export function objectPath(cfg: Pick<S3Config, 'bucket'>, key: string): string {
  if (key === '') return `/${uriEncode(cfg.bucket)}` // the bucket itself, for listing
  return `/${uriEncode(cfg.bucket)}/${uriEncode(key, true)}`
}

/** The core of a presigned URL, split out so it can be checked against AWS's published example. */
export async function presignParts(opts: {
  host: string
  path: string
  method: string
  query?: Record<string, string>
  keyId: string
  secret: string
  region: string
  expires: number
  now: Date
}): Promise<string> {
  const { date, stamp } = amzDates(opts.now)
  const scope = `${date}/${opts.region}/s3/aws4_request`
  const query: Record<string, string> = {
    ...(opts.query ?? {}),
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${opts.keyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(opts.expires),
    'X-Amz-SignedHeaders': 'host',
  }
  const cq = canonicalQuery(query)
  const canonical = [opts.method, opts.path, cq, `host:${opts.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha256Hex(canonical)].join('\n')
  const signature = hex(await hmac(await signingKey(opts.secret, date, opts.region), toSign))
  return `${opts.path}?${cq}&X-Amz-Signature=${signature}`
}

/** A time-limited URL for one operation on one object (path-style). */
export async function presign(
  cfg: S3Config,
  method: 'GET' | 'PUT',
  key: string,
  query: Record<string, string> = {},
  expires = 3600,
  now = new Date(),
): Promise<string> {
  const host = new URL(cfg.endpoint).host
  const pathAndQuery = await presignParts({
    host, path: objectPath(cfg, key), method, query, keyId: cfg.keyId, secret: cfg.secret, region: cfg.region, expires, now,
  })
  return cfg.endpoint + pathAndQuery
}

/** A signed request made from the worker itself. */
export async function s3Fetch(
  cfg: S3Config,
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE',
  key: string,
  query: Record<string, string> = {},
  body?: string,
  now = new Date(),
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const host = new URL(cfg.endpoint).host
  const { date, stamp } = amzDates(now)
  const scope = `${date}/${cfg.region}/s3/aws4_request`
  const payloadHash = await sha256Hex(body ?? '')
  const cq = canonicalQuery(query)
  const path = objectPath(cfg, key)
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonical = [
    method, path, cq,
    `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${stamp}\n`,
    signedHeaders, payloadHash,
  ].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha256Hex(canonical)].join('\n')
  const signature = hex(await hmac(await signingKey(cfg.secret, date, cfg.region), toSign))
  const headers: Record<string, string> = {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
    Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
  if (body !== undefined) headers['content-type'] = 'application/xml'
  // Unsigned extras such as Range are allowed: only the headers listed in SignedHeaders are covered by the signature
  Object.assign(headers, extraHeaders)
  return fetch(`${cfg.endpoint}${path}${cq ? `?${cq}` : ''}`, { method, headers, body })
}
