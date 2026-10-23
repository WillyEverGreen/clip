// ─── Cloudflare bindings ─────────────────────────────────────────────────────

import type { BigUploadStore } from '../durable/BigUploadStore'

export interface Env {
  PASTE_KV: KVNamespace
  CLIP_DO: DurableObjectNamespace  // ClipRoom — SSE fan-out per slug
  BEAM_DO: DurableObjectNamespace  // BeamRoom — Clip Beam WebRTC signalling per PIN
  BEAM_LOBBY_DO: DurableObjectNamespace  // BeamLobby — Clip Beam nearby receivers per public IP
  BIG_DO: DurableObjectNamespace<BigUploadStore>  // BigUploadStore — one record per file-bucket upload (strongly consistent)
  APP_PEPPER: string        // set via: wrangler secret put APP_PEPPER
  FRONTEND_ORIGIN: string   // set in wrangler.toml [vars]
  ADMIN_SECRET?: string     // set via wrangler.toml [vars] or secret
  TURN_KEY_ID?: string      // Cloudflare Realtime TURN key id (optional; enables the relay fallback)
  TURN_API_TOKEN?: string   // its API token: wrangler secret put TURN_API_TOKEN
  // Large files (over 25 MB) go to a private S3-compatible bucket (Backblaze B2)
  B2_KEY_ID?: string        // bucket-scoped application key id: wrangler secret put B2_KEY_ID
  B2_APP_KEY?: string       // its secret: wrangler secret put B2_APP_KEY
  B2_BUCKET?: string        // wrangler.toml [vars]
  B2_S3_ENDPOINT?: string   // wrangler.toml [vars], e.g. https://s3.us-east-005.backblazeb2.com
  B2_REGION?: string        // wrangler.toml [vars], e.g. us-east-005
  SWEEP_CLOCK_SKEW_MS?: string  // tests only (wrangler dev --var): makes the cleanup job act as if this much time had passed
}


// ─── Entry ───────────────────────────────────────────────────────────────────

export type EntryType = 'text' | 'file'

export interface FileItem {
  id: string
  fileName: string
  fileMime: string
  fileSize: number
}

/** Files kept in the file bucket (one object each), uploaded together and deleted together at `expiresAt`. */
export interface EntryBundle {
  id: string
  expiresAt: number
  files: { n: number; name: string; size: number; type: string }[]
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
  bundles?: EntryBundle[]   // Files kept in the file bucket (too big for KV)


  // Security — never returned to client
  editCodeHash: string
  editCodeSalt: string

  // Timing & Stats
  createdAt: number         // Unix ms (Pub)
  updatedAt?: number        // Unix ms (Edit)
  expiresAt: number         // Expiration Unix ms
  fileExpiresAt?: number    // Expiration Unix ms for files
  views: number             // View counter
  isPermanent?: boolean     // Flag to skip expiration checks (~100-year TTL)
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

// ─── Live Room Info ───────────────────────────────────────────────────────────

export interface LiveRoomInfo {
  slug: string
  createdAt: number
  updatedAt: number
  expiresAt: number
  isProtected: boolean
  fileCount: number
  totalFileSize?: number
  textLength: number
  textPreview?: string
  peers: number
}

export interface AdminLiveRoomsResponse {
  total: number
  stats: {
    totalActiveRooms: number
    totalPeers: number
    totalFiles: number
    protectedRooms: number
  }
  rooms: LiveRoomInfo[]
}
