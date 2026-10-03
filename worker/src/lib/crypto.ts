/**
 * Cryptographic helpers using the Web Crypto API.
 * All functions are edge-compatible (no Node.js APIs).
 *
 * Strategy:
 *  - Random 16-byte salt per entry (stored in KV)
 *  - App-wide pepper from Worker secret (never stored)
 *  - PBKDF2(code + ":" + pepper, salt, 100_000 iterations, SHA-256)
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
  } catch (err) {
    console.error('decryptContent error:', err)
    return null
  }
}

// ─── Zero-Knowledge Binary File Encryption (ENC1 Envelope) ───────────────────
const ENC_MAGIC = new Uint8Array([0x45, 0x4E, 0x43, 0x31]) // 'ENC1'

export interface DecryptedFileBuffer {
  buffer: ArrayBuffer
  fileName: string
  fileMime: string
  fileSize: number
}

export function isEncryptedFileBuffer(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 34) return false
  const bytes = new Uint8Array(buf, 0, 4)
  return bytes[0] === ENC_MAGIC[0] &&
         bytes[1] === ENC_MAGIC[1] &&
         bytes[2] === ENC_MAGIC[2] &&
         bytes[3] === ENC_MAGIC[3]
}

export async function decryptFileArrayBuffer(
  containerBuf: ArrayBuffer,
  password: string,
): Promise<DecryptedFileBuffer | null> {
  try {
    if (!isEncryptedFileBuffer(containerBuf)) return null

    const container = new Uint8Array(containerBuf)
    let offset = 4 // skip magic

    const salt = container.slice(offset, offset + 16); offset += 16
    const iv   = container.slice(offset, offset + 12); offset += 12

    const view = new DataView(containerBuf, container.byteOffset, container.byteLength)
    const metaLen = view.getUint16(offset, false); offset += 2

    const metaBytes = container.slice(offset, offset + metaLen); offset += metaLen
    const metaStr = new TextDecoder().decode(metaBytes)
    const meta = JSON.parse(metaStr) as { name: string; mime: string; size: number }

    const ciphertext = container.slice(offset)

    const enc = new TextEncoder()
    const rawKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_PAYLOAD_ITERATIONS, hash: 'SHA-256' },
      rawKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    )

    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)

    return {
      buffer: plainBuf,
      fileName: meta.name || 'decrypted_file',
      fileMime: meta.mime || 'application/octet-stream',
      fileSize: meta.size ?? plainBuf.byteLength,
    }
  } catch {
    return null
  }
}

// ─── IP hashing (for privacy-safe logging) ────────────────────────────────────

export async function hashIp(ip: string, pepper: string = 'clip_default_pepper'): Promise<string> {
  const enc = new TextEncoder()
  const data = enc.encode(`ip:${ip}:${pepper || 'clip_default_pepper'}`)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12)
}
