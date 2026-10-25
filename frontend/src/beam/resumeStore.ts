/**
 * Remembers unfinished Beam downloads in this browser (IndexedDB) so they can be continued after the
 * page is reloaded. Only the receiving browser keeps anything: the partly saved file's handle, how many
 * bytes are safely in it, and the running SHA-256 state at that point. Nothing is sent to any server.
 * Everything here fails quietly (private windows, blocked storage): resume then simply is not offered.
 */
import type { ResumeToken } from './diskWriter'

const DB_NAME = 'clip-beam'
const STORE = 'unfinished'
/** Old leftovers are dropped; a Beam room itself only lives about ten minutes. */
const MAX_AGE_MS = 24 * 3600 * 1000

export interface ResumeRecord {
  /** Random id of this partly received file (the record's key) */
  rk: string
  /** This receiver's session key, so the sender can tell the same receiver is coming back */
  sk: string
  name: string
  size: number
  type: string
  /** The Beam room to reconnect to */
  pin: string
  myName: string
  senderName: string
  /** Bytes safely saved */
  have: number
  /** Saved SHA-256 state covering exactly those bytes */
  hasher: Uint8Array
  token: Extract<ResumeToken, { kind: 'disk' }>
  updatedAt: number
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'rk' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open()
    .then((db) => new Promise<T | null>((resolve) => {
      const tx = db.transaction(STORE, mode)
      const req = fn(tx.objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      tx.oncomplete = () => db.close()
      tx.onerror = () => resolve(null)
    }))
    .catch(() => null)
}

export async function saveRecord(record: ResumeRecord): Promise<void> {
  await run('readwrite', (s) => s.put(record))
  void listRecords() // drops anything older than a day, so abandoned transfers do not pile up
}

export async function deleteRecord(rk: string): Promise<void> {
  await run('readwrite', (s) => s.delete(rk))
}

export async function listRecords(): Promise<ResumeRecord[]> {
  const all = (await run<ResumeRecord[]>('readonly', (s) => s.getAll())) ?? []
  const now = Date.now()
  const fresh = all.filter((r) => now - r.updatedAt < MAX_AGE_MS)
  for (const old of all) if (!fresh.includes(old)) void deleteRecord(old.rk)
  return fresh.sort((a, b) => b.updatedAt - a.updatedAt)
}
