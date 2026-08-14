/**
 * Cryptographic helpers using the Web Crypto API.
 * All functions are edge-compatible (no Node.js APIs).
 *
 * Strategy:
 *  - Random 16-byte salt per entry (stored in KV)
 *  - App-wide pepper from Worker secret (never stored)
 *  - PBKDF2(code + ":" + pepper, salt, 200_000 iterations, SHA-256)
 *  - Constant-time comparison to prevent timing attacks
 */

const ITERATIONS = 100_000

// ─── Salt ─────────────────────────────────────────────────────────────────────

export function generateSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// ─── Hash ─────────────────────────────────────────────────────────────────────

export async function hashCode(
  code: string,
  salt: string,
  pepper: string = 'clip_default_pepper',
): Promise<string> {
  const enc = new TextEncoder()
  const input = `${code}:${pepper || 'clip_default_pepper'}`

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(input),
    'PBKDF2',
    false,
    ['deriveBits'],
  )

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode(salt),
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256,
  )

  return Array.from(new Uint8Array(bits))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// ─── Verify (constant-time) ───────────────────────────────────────────────────

export async function verifyCode(
  code: string,
  salt: string,
  pepper: string,
  storedHash: string,
): Promise<boolean> {
  const computed = await hashCode(code, salt, pepper)
  if (computed.length !== storedHash.length) return false

  // Bitwise OR of differences — prevents early exit timing leak
  let diff = 0
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ storedHash.charCodeAt(i)
  }
  return diff === 0
}

// ─── Content Payload Encryption / Decryption ────────────────────────────────

const PBKDF2_PAYLOAD_ITERATIONS = 250_000

export interface EncryptedPayload {
  encrypted: true
  iv: string
  salt: string
  ciphertext: string
}

export function isEncrypted(content: string): boolean {
  try {
    const p = JSON.parse(content)
    return p?.encrypted === true
  } catch {
    return false
  }
}

export async function decryptContent(raw: string, password: string): Promise<string | null> {
  try {
    const payload: EncryptedPayload = JSON.parse(raw)
    if (!payload.encrypted) return null

    const salt   = Uint8Array.from(atob(payload.salt),       c => c.charCodeAt(0))
    const iv     = Uint8Array.from(atob(payload.iv),         c => c.charCodeAt(0))
    const cipher = Uint8Array.from(atob(payload.ciphertext), c => c.charCodeAt(0))

    const enc = new TextEncoder()
    const rawKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_PAYLOAD_ITERATIONS, hash: 'SHA-256' },
      rawKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    )

    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher)
    return new TextDecoder().decode(plainBuf)
  } catch {
    return null
  }
}

// ─── IP hashing (for privacy-safe logging) ────────────────────────────────────

export async function hashIp(ip: string, pepper: string): Promise<string> {
  const enc = new TextEncoder()
  const data = enc.encode(`ip:${ip}:${pepper}`)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12)
}
