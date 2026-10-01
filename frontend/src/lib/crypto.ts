/**
 * Zero-knowledge AES-256-GCM encryption utilities.
 * All encryption/decryption happens entirely in the browser.
 * The server never sees passwords or plaintext content.
 */

const PBKDF2_ITERATIONS = 250_000
const KEY_USAGE: KeyUsage[] = ['encrypt', 'decrypt']

// ── PBKDF2 Key cache ──────────────────────────────────────────────────────────
// Avoids re-deriving the key (250,000 iterations) on every re-render or retry.
// Keyed by `password::base64(salt)` so different salts always derive fresh keys.
// Bounded to 50 entries to prevent memory bloat on long-lived sessions.
const keyCache = new Map<string, CryptoKey>()
const KEY_CACHE_MAX = 50

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const cacheKey = `${password}::${btoa(String.fromCharCode(...salt))}`
  const cached = keyCache.get(cacheKey)
  if (cached) return cached

  const enc = new TextEncoder()
  const raw = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  const derived = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    KEY_USAGE,
  )

  // Evict oldest entry if cache is full
  if (keyCache.size >= KEY_CACHE_MAX) {
    keyCache.delete(keyCache.keys().next().value!)
  }
  keyCache.set(cacheKey, derived)
  return derived
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

/** Generates a random cryptographic salt (hex string) */
export function generateSalt(): string {
  const buf = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Derives a SHA-256 verifier hash for room authentication */
export async function computeAuthHash(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder()
  const data = enc.encode(`${password}:${salt}`)
  const hashBuf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Zero-Knowledge Binary File Encryption (ENC1 Envelope) ───────────────────
const ENC_MAGIC = new Uint8Array([0x45, 0x4E, 0x43, 0x31]) // 'ENC1'

export interface DecryptedFileResult {
  blob: Blob
  fileName: string
  fileMime: string
  fileSize: number
}

/** Check if an ArrayBuffer starts with the ENC1 magic container header */
export function isEncryptedFileBuffer(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 34) return false
  const bytes = new Uint8Array(buf, 0, 4)
  return bytes[0] === ENC_MAGIC[0] &&
         bytes[1] === ENC_MAGIC[1] &&
         bytes[2] === ENC_MAGIC[2] &&
         bytes[3] === ENC_MAGIC[3]
}

/** Encrypts a File client-side with AES-256-GCM and wraps it in an ENC1 container */
export async function encryptFile(file: File, password: string): Promise<File> {
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)))
  const iv   = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)))
  const key  = await deriveKey(password, salt)

  const fileData = await file.arrayBuffer()
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, fileData)

  const metaJson = JSON.stringify({
    name: file.name,
    mime: file.type || 'application/octet-stream',
    size: file.size,
  })
  const metaBytes = new TextEncoder().encode(metaJson)
  if (metaBytes.length > 65535) {
    throw new Error('File metadata too long')
  }

  const totalLength = 4 + 16 + 12 + 2 + metaBytes.length + cipherBuf.byteLength
  const container = new Uint8Array(totalLength)
  let offset = 0

  // 1. Magic
  container.set(ENC_MAGIC, offset); offset += 4
  // 2. Salt
  container.set(salt, offset); offset += 16
  // 3. IV
  container.set(iv, offset); offset += 12
  // 4. Meta length (Uint16 Big-Endian)
  const view = new DataView(container.buffer, container.byteOffset, container.byteLength)
  view.setUint16(offset, metaBytes.length, false); offset += 2
  // 5. Meta bytes
  container.set(metaBytes, offset); offset += metaBytes.length
  // 6. Ciphertext
  container.set(new Uint8Array(cipherBuf), offset)

  return new File([container], file.name, {
    type: 'application/octet-stream',
    lastModified: file.lastModified,
  })
}

/** Decrypts an ENC1 container ArrayBuffer into original File Blob & metadata */
export async function decryptFileBuffer(
  containerBuf: ArrayBuffer,
  password: string,
): Promise<DecryptedFileResult | null> {
  try {
    if (!isEncryptedFileBuffer(containerBuf)) return null

    const container = new Uint8Array(containerBuf)
    let offset = 4 // skip magic

    const salt = container.slice(offset, offset + 16); offset += 16
    const iv = container.slice(offset, offset + 12); offset += 12

    const view = new DataView(containerBuf, container.byteOffset, container.byteLength)
    const metaLen = view.getUint16(offset, false); offset += 2

    const metaBytes = container.slice(offset, offset + metaLen); offset += metaLen
    const metaStr = new TextDecoder().decode(metaBytes)
    const meta = JSON.parse(metaStr) as { name: string; mime: string; size: number }

    const ciphertext = container.slice(offset)
    const key = await deriveKey(password, salt)
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)

    const blob = new Blob([plainBuf], { type: meta.mime || 'application/octet-stream' })
    return {
      blob,
      fileName: meta.name || 'decrypted_file',
      fileMime: meta.mime || 'application/octet-stream',
      fileSize: meta.size ?? plainBuf.byteLength,
    }
  } catch {
    return null
  }
}

