// ─── Cloudflare bindings ─────────────────────────────────────────────────────

export interface Env {
  PASTE_KV: KVNamespace
  APP_PEPPER: string        // set via: wrangler secret put APP_PEPPER
  FRONTEND_ORIGIN: string   // set in wrangler.toml [vars]
  ADMIN_SECRET?: string     // set via wrangler.toml [vars] or secret
}


// ─── Entry ───────────────────────────────────────────────────────────────────

export type EntryType = 'text' | 'file'

export interface FileItem {
  id: string
  fileName: string
  fileMime: string
  fileSize: number
}

export interface Entry {
  slug: string
  type: EntryType

  // Text entries
  content?: string          // max 2MB

  // File entries
  fileName?: string         // original filename
  fileMime?: string
  fileSize?: number
  hasFile?: boolean         // true if file binary stored under file:{slug} in KV
  files?: FileItem[]        // Array of attached files


  // Security — never returned to client
  editCodeHash: string
  editCodeSalt: string

  // Timing & Stats
  createdAt: number         // Unix ms (Pub)
  updatedAt?: number        // Unix ms (Edit)
  expiresAt: number         // Expiration Unix ms
  fileExpiresAt?: number    // Expiration Unix ms for files
  views: number             // View counter
}

// Entry shape returned to the client (sensitive fields stripped)
export type PublicEntry = Omit<Entry, 'editCodeHash' | 'editCodeSalt'>

// ─── API response shapes ──────────────────────────────────────────────────────

export interface CreateResponse {
  slug: string
  expiresAt: number
}

export interface VerifyResponse {
  valid: boolean
}

export interface ErrorResponse {
  error: string
  retryAfter?: number
}
