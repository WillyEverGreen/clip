/**
 * Magic byte (file signature) validation.
 * Cross-checks the browser-supplied Content-Type against actual file bytes.
 *
 * For unknown/unlisted types, we allow the upload (don't block).
 * For known types, the signatures must match.
 */

type Signature = number[]

const MAGIC: Record<string, Signature[]> = {
  'application/pdf':       [[0x25, 0x50, 0x44, 0x46]],          // %PDF
  'image/png':             [[0x89, 0x50, 0x4E, 0x47]],          // \x89PNG
  'image/jpeg':            [[0xFF, 0xD8, 0xFF]],
  'image/gif':             [[0x47, 0x49, 0x46, 0x38]],          // GIF8
  'image/webp':            [[0x52, 0x49, 0x46, 0x46]],          // RIFF
  'application/zip':       [[0x50, 0x4B, 0x03, 0x04]],
  'application/x-zip-compressed': [[0x50, 0x4B, 0x03, 0x04]],
  'video/mp4':             [[0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70],
                            [0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70]],
}

export async function validateMime(file: File): Promise<boolean> {
  const signatures = MAGIC[file.type]

  // Type not in our known list — allow it
  if (!signatures) return true

  const buf   = await file.slice(0, 8).arrayBuffer()
  const bytes = new Uint8Array(buf)

  return signatures.some(sig => sig.every((b, i) => bytes[i] === b))
}
