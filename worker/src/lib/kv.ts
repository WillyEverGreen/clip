import type { Entry, PublicEntry } from './types'

const ENTRY_PREFIX = 'entry:'
const FILE_PREFIX  = 'file:'
const DEFAULT_TTL_SECONDS = 21_600 // 6 hours

// ─── Helpers ──────────────────────────────────────────────────────────────────

function key(slug: string): string {
  return `${ENTRY_PREFIX}${slug}`
}

function fileKey(slug: string): string {
  return `${FILE_PREFIX}${slug}`
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getEntry(
  kv: KVNamespace,
  slug: string,
): Promise<Entry | null> {
  return kv.get<Entry>(key(slug), 'json')
}

// Strip sensitive fields before returning to client
export function toPublic(entry: Entry): PublicEntry {
  const { editCodeHash: _h, editCodeSalt: _s, ...pub } = entry
  return pub
}

// ─── Write ────────────────────────────────────────────────────────────────────

export async function putEntry(
  kv: KVNamespace,
  entry: Entry,
): Promise<void> {
  const ttl = Math.max(60, Math.floor((entry.expiresAt - Date.now()) / 1000))
  await kv.put(key(entry.slug), JSON.stringify(entry), {
    expirationTtl: ttl,
  })
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteEntry(
  kv: KVNamespace,
  slug: string,
): Promise<void> {
  await kv.delete(key(slug))
  await kv.delete(fileKey(slug))
}

// ─── Existence check ──────────────────────────────────────────────────────────

export async function entryExists(
  kv: KVNamespace,
  slug: string,
): Promise<boolean> {
  const meta = await kv.getWithMetadata(key(slug))
  return meta.value !== null
}

// ─── File Binary KV ───────────────────────────────────────────────────────────

export async function putFileKV(
  kv: KVNamespace,
  slug: string,
  data: ArrayBuffer,
  ttlSeconds?: number,
): Promise<void> {
  await kv.put(fileKey(slug), data, {
    expirationTtl: ttlSeconds || DEFAULT_TTL_SECONDS,
  })
}

export async function getFileKV(
  kv: KVNamespace,
  slug: string,
): Promise<ArrayBuffer | null> {
  return kv.get(fileKey(slug), 'arrayBuffer')
}

export async function deleteFileKV(
  kv: KVNamespace,
  slug: string,
): Promise<void> {
  await kv.delete(fileKey(slug))
}
