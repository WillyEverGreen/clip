import type { Entry, EntryBundle } from './types'
import type { BigRecord } from './big'

/** The part of an upload record a clip keeps: names, sizes and when the files go. */
export function bundleFromRecord(rec: BigRecord, expiresAt: number): EntryBundle {
  return { id: rec.slug, expiresAt, files: rec.files.map((f) => ({ n: f.n, name: f.name, size: f.size, type: f.type })) }
}

/** Drop uploads whose time is up. Returns the ids that were dropped (their stored files still need deleting). */
export function pruneExpiredBundles(entry: Entry, now = Date.now()): string[] {
  if (!entry.bundles?.length) return []
  const gone = entry.bundles.filter((b) => b.expiresAt <= now).map((b) => b.id)
  if (gone.length) {
    const left = entry.bundles.filter((b) => b.expiresAt > now)
    entry.bundles = left.length ? left : undefined
  }
  return gone
}

export function bundleTotals(bundles: EntryBundle[] | undefined): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  for (const b of bundles ?? []) for (const f of b.files) { files++; bytes += f.size }
  return { files, bytes }
}
