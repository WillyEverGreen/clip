/**
 * Zero-knowledge AES-256-GCM encryption utilities.
 * All encryption/decryption happens entirely in the browser.
 * The server never sees passwords or plaintext content.
 */

const PBKDF2_ITERATIONS = 250_000
const KEY_USAGE: KeyUsage[] = ['encrypt', 'decrypt']

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const raw = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    KEY_USAGE,
  )
}

export interface EncryptedPayload {
  encrypted: true
  iv: string
  salt: string
  ciphertext: string
}

/** Encrypts a plaintext string with AES-256-GCM using the given password. */
export async function encryptContent(plaintext: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)))
  const iv   = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)))
  const key  = await deriveKey(password, salt)

  const encoded    = new TextEncoder().encode(plaintext)
  const cipherBuf  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)

  const payload: EncryptedPayload = {
    encrypted: true,
    iv:         btoa(String.fromCharCode(...iv)),
    salt:       btoa(String.fromCharCode(...salt)),
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(cipherBuf))),
  }
  return JSON.stringify(payload)
}

/** Returns the decrypted string, or null if the password is wrong / data is corrupted. */
export async function decryptContent(raw: string, password: string): Promise<string | null> {
  try {
    const payload: EncryptedPayload = JSON.parse(raw)
    if (!payload.encrypted) return null

    const salt   = Uint8Array.from(atob(payload.salt),       c => c.charCodeAt(0))
    const iv     = Uint8Array.from(atob(payload.iv),         c => c.charCodeAt(0))
    const cipher = Uint8Array.from(atob(payload.ciphertext), c => c.charCodeAt(0))

    const key       = await deriveKey(password, salt)
    const plainBuf  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher)
    return new TextDecoder().decode(plainBuf)
  } catch {
    return null
  }
}

/** Returns true if the content string is an encrypted payload. */
export function isEncrypted(content: string): boolean {
  try {
    const p = JSON.parse(content)
    return p?.encrypted === true
  } catch {
    return false
  }
}
