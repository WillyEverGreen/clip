import { mapPos, type Op } from './ot'

export interface RemoteCursor {
  id: string
  name: string
  start: number
  end: number
}

/** What the cursor UI renders: our own name (as the server gave it) and everyone else's caret. */
export interface CursorSnapshot {
  me: string
  others: readonly RemoteCursor[]
}

export function isRemoteCursor(v: unknown): v is RemoteCursor {
  if (typeof v !== 'object' || v === null) return false
  const c = v as RemoteCursor
  return typeof c.id === 'string' && typeof c.name === 'string' && Number.isFinite(c.start) && Number.isFinite(c.end)
}

/**
 * Holds other people's cursors outside React state. Cursor messages arrive many times a second and
 * must not re-render the whole pad page, so only components subscribed through
 * `useSyncExternalStore(store.subscribe, store.getSnapshot)` update when something changes.
 */
export class CursorStore {
  private cursors = new Map<string, RemoteCursor>()
  private me = ''
  private snapshot: CursorSnapshot = { me: '', others: [] }
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): CursorSnapshot => this.snapshot

  get size(): number {
    return this.cursors.size
  }

  private publish(): void {
    this.snapshot = { me: this.me, others: Array.from(this.cursors.values()) }
    for (const listener of this.listeners) listener()
  }

  setMe(name: string): void {
    if (this.me === name) return
    this.me = name
    this.publish()
  }

  replaceAll(list: readonly RemoteCursor[]): void {
    this.cursors = new Map(list.map(c => [c.id, { id: c.id, name: c.name, start: c.start, end: c.end }]))
    this.publish()
  }

  upsert(cursor: RemoteCursor): void {
    const prev = this.cursors.get(cursor.id)
    if (prev && prev.name === cursor.name && prev.start === cursor.start && prev.end === cursor.end) return
    this.cursors.set(cursor.id, { id: cursor.id, name: cursor.name, start: cursor.start, end: cursor.end })
    this.publish()
  }

  remove(id: string): void {
    if (this.cursors.delete(id)) this.publish()
  }

  /** Drop cursors of people who are no longer in the room. */
  prune(presentIds: ReadonlySet<string>): void {
    let changed = false
    for (const id of Array.from(this.cursors.keys())) {
      if (!presentIds.has(id)) {
        this.cursors.delete(id)
        changed = true
      }
    }
    if (changed) this.publish()
  }

  clear(): void {
    if (this.cursors.size === 0) return
    this.cursors.clear()
    this.publish()
  }

  /** The text changed under the carets: keep each one on the same words. */
  shift(op: Op): void {
    if (this.cursors.size === 0) return
    for (const [id, c] of this.cursors) {
      this.cursors.set(id, { ...c, start: mapPos(c.start, op), end: mapPos(c.end, op) })
    }
    this.publish()
  }
}
