/**
 * Minimal operational transformation (OT) for the Live Pad text.
 *
 * IMPORTANT: this file is shared verbatim between the worker and the frontend
 * (`worker/src/lib/ot.ts` and `frontend/src/lib/ot.ts`). Keep them identical;
 * `npm test` fails if they drift apart.
 *
 * Design:
 *  - Every operation is ATOMIC: either a pure insert (`s === e`, `x !== ''`)
 *    or a pure delete (`e > s`, `x === ''`). A no-op is `s === e && x === ''`.
 *    Atomic ops keep transformation closed and easy to verify exhaustively.
 *  - The server is the single sequencer. Each accepted op bumps `version` by 1.
 *  - Clients keep one op in flight at a time. Anything typed meanwhile is
 *    recovered later by diffing, so there is no explicit buffer to get wrong.
 */

export interface Op {
  /** start index (UTF-16 code units) */
  s: number
  /** end index, exclusive; equals `s` for inserts */
  e: number
  /** inserted text; empty for deletes */
  x: string
}

/** Largest insert a single op may carry (also the client chunk size). */
export const MAX_OP_CHARS = 100_000
/** Hard cap on the document length. */
export const MAX_DOC_CHARS = 5_000_000
/** How many past ops the server keeps for transforming late clients. */
const HISTORY_LIMIT = 1000

/** Canonical no-op. Its position is meaningless, so it is always 0 (always in bounds). */
const noop = (): Op => ({ s: 0, e: 0, x: '' })

export function isNoop(op: Op): boolean {
  return op.s === op.e && op.x === ''
}

export function isInsert(op: Op): boolean {
  return op.s === op.e && op.x !== ''
}

export function isDelete(op: Op): boolean {
  return op.e > op.s && op.x === ''
}

/** True when `op` is a well-formed atomic op (or no-op) with sane numbers. */
export function isValidOp(op: unknown): op is Op {
  if (typeof op !== 'object' || op === null) return false
  const { s, e, x } = op as Op
  if (!Number.isSafeInteger(s) || !Number.isSafeInteger(e) || typeof x !== 'string') return false
  if (s < 0 || e < s) return false
  if (x.length > MAX_OP_CHARS) return false
  if (e > s) return x === ''
  return true
}

export function applyOp(text: string, op: Op): string {
  return text.slice(0, op.s) + op.x + text.slice(op.e)
}

/**
 * Transform `a` so it applies after `b` has already been applied.
 * Both ops must have been created against the same document state.
 * `bFirst` breaks the insert/insert tie at the same index: when true, `b`'s
 * text ends up before `a`'s.
 *
 * Convergence (TP1): for any `a`, `b` on text S,
 *   apply(apply(S, b), T(a, b, true)) === apply(apply(S, a), T(b, a, false))
 */
export function transformOp(a: Op, b: Op, bFirst: boolean): Op {
  if (isNoop(a)) return noop()
  if (isNoop(b)) return a

  if (isInsert(a)) {
    const p = a.s
    if (isInsert(b)) {
      const q = b.s
      const l = b.x.length
      if (p < q) return a
      if (p > q || bFirst) return { s: p + l, e: p + l, x: a.x }
      return a
    }
    // b is a delete
    const del = b.e - b.s
    if (p <= b.s) return a
    if (p >= b.e) return { s: p - del, e: p - del, x: a.x }
    // Insert landed strictly inside a concurrently deleted region: it is dropped.
    return noop()
  }

  // a is a delete
  const { s, e } = a
  if (isInsert(b)) {
    const q = b.s
    const l = b.x.length
    if (q <= s) return { s: s + l, e: e + l, x: '' }
    if (q >= e) return a
    // Concurrent insert inside the deleted span is swallowed by the delete.
    return { s, e: e + l, x: '' }
  }
  // both deletes
  const del = b.e - b.s
  const map = (p: number) => (p <= b.s ? p : p >= b.e ? p - del : b.s)
  const ns = map(s)
  const ne = map(e)
  return ns === ne ? noop() : { s: ns, e: ne, x: '' }
}

/** Map a caret/selection index through an op that has just been applied. */
export function mapPos(pos: number, op: Op): number {
  if (isNoop(op)) return pos
  if (isInsert(op)) return pos > op.s ? pos + op.x.length : pos
  const del = op.e - op.s
  if (pos <= op.s) return pos
  if (pos >= op.e) return pos - del
  return op.s
}

const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff

/**
 * Turn the difference between two texts into 0..2 sequential atomic ops
 * (a delete, then an insert at the same index). Applying them in order to
 * `from` yields `to`. Never splits a surrogate pair.
 */
export function diffOps(from: string, to: string): Op[] {
  if (from === to) return []
  const max = Math.min(from.length, to.length)
  let p = 0
  while (p < max && from.charCodeAt(p) === to.charCodeAt(p)) p++
  if (p > 0 && p < from.length && isLowSurrogate(from.charCodeAt(p))) p--
  else if (p > 0 && p < to.length && isLowSurrogate(to.charCodeAt(p))) p--
  let q = 0
  while (q < max - p && from.charCodeAt(from.length - 1 - q) === to.charCodeAt(to.length - 1 - q)) q++
  if (q > 0 && isLowSurrogate(from.charCodeAt(from.length - q))) q--
  else if (q > 0 && isLowSurrogate(to.charCodeAt(to.length - q))) q--
  const delEnd = from.length - q
  const ins = to.slice(p, to.length - q)
  const ops: Op[] = []
  if (delEnd > p) ops.push({ s: p, e: delEnd, x: '' })
  if (ins) ops.push({ s: p, e: p, x: ins })
  return ops
}

/** Like `diffOps` but caps an insert at MAX_OP_CHARS (the rest follows on the next round). */
function nextOp(from: string, to: string): Op | null {
  const first = diffOps(from, to)[0]
  if (!first) return null
  if (first.x.length <= MAX_OP_CHARS) return first
  let cut = MAX_OP_CHARS
  const last = first.x.charCodeAt(cut - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut--
  return { s: first.s, e: first.e, x: first.x.slice(0, cut) }
}

/** Small, fast non-cryptographic hash used for the consistency check. */
export function hashText(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

// ── Server side ──────────────────────────────────────────────────────────────

/** Who authored an op: lets a reconnecting client recognise its own op in a replay. */
export interface OpMeta {
  sid?: string
  n?: number
}

export interface ReplayOp extends Op, OpMeta {
  /** version produced by this op */
  v: number
}

export type SubmitResult =
  | { ok: true; op: Op; version: number }
  | { ok: false; reason: 'invalid' | 'stale' | 'too_large' }

interface HistoryEntry extends OpMeta {
  op: Op
}

export class OtServerDoc {
  text: string
  version = 0
  /** Oldest version a client may still submit against. */
  private baseVersion = 0
  private history: HistoryEntry[] = []

  constructor(text = '') {
    this.text = text
  }

  /** Replace the whole document and invalidate every client's base version. */
  reset(text: string): void {
    this.text = text
    this.version += 1
    this.baseVersion = this.version
    this.history = []
  }

  private push(op: Op, meta: OpMeta = {}): number {
    this.text = applyOp(this.text, op)
    this.history.push({ op, sid: meta.sid, n: meta.n })
    this.version += 1
    if (this.history.length > HISTORY_LIMIT) {
      this.history.shift()
      this.baseVersion += 1
    }
    return this.version
  }

  /** Apply an op a client created against `clientVersion`. */
  submit(raw: unknown, clientVersion: unknown, meta: OpMeta = {}): SubmitResult {
    if (!isValidOp(raw) || !Number.isSafeInteger(clientVersion)) return { ok: false, reason: 'invalid' }
    const base = clientVersion as number
    if (base < this.baseVersion || base > this.version) return { ok: false, reason: 'stale' }

    let op: Op = { s: raw.s, e: raw.e, x: raw.x }
    for (let i = base - this.baseVersion; i < this.history.length; i++) {
      op = transformOp(op, this.history[i]!.op, true)
    }
    if (op.e > this.text.length) return { ok: false, reason: 'invalid' }
    if (this.text.length - (op.e - op.s) + op.x.length > MAX_DOC_CHARS) return { ok: false, reason: 'too_large' }
    return { ok: true, op, version: this.push(op, meta) }
  }

  /** Legacy full-text replacement: applied as sequential atomic ops. */
  replaceAll(next: string): { op: Op; version: number }[] {
    if (next.length > MAX_DOC_CHARS) return []
    const out: { op: Op; version: number }[] = []
    for (const op of diffOps(this.text, next)) out.push({ op, version: this.push(op) })
    return out
  }

  /** Ops a client that last saw `since` has missed, or null when history no longer reaches that far. */
  replaySince(since: unknown): ReplayOp[] | null {
    if (!Number.isSafeInteger(since)) return null
    const from = since as number
    if (from < this.baseVersion || from > this.version) return null
    return this.history.slice(from - this.baseVersion).map((h, i) => ({
      ...h.op, v: from + i + 1, sid: h.sid, n: h.n,
    }))
  }
}

// ── Client side ──────────────────────────────────────────────────────────────

export type ClientStep =
  /** Everything fine; `send` (if any) must be sent as op number `n` against `baseVersion`. */
  | { kind: 'ok'; send: Op | null; baseVersion: number; n: number }
  /** Local state no longer matches the server; ask for a resync. */
  | { kind: 'desync' }

export type RemoteStep =
  | { kind: 'ok'; applied: Op }
  | { kind: 'desync' }

export interface ServerState {
  text: string
  version: number
  /** Ops since the version the client announced when connecting, when the server could provide them. */
  replay?: ReplayOp[] | null
}

const sameOp = (a: Op, b: Op) => a.s === b.s && a.e === b.e && a.x === b.x

/**
 * Transform sequence `mine` over sequence `theirs`, both created against the same
 * state, so that `mine'` applies after `theirs`. `theirs` wins insert ties.
 */
function transformSeq(mine: Op[], theirs: Op[]): Op[] {
  let others = theirs
  const out: Op[] = []
  for (const m of mine) {
    let cur = m
    const next: Op[] = []
    for (const t of others) {
      const adapted = transformOp(cur, t, true)
      next.push(transformOp(t, cur, false))
      cur = adapted
    }
    others = next
    out.push(cur)
  }
  return out
}

export class OtClient {
  /** Server text at `version`, excluding our in-flight op. */
  base = ''
  version = 0
  /** What the user currently sees in the editor. */
  local = ''
  private inflight: Op | null = null
  private inflightSeq = 0
  private seq = 0
  private online = false

  /** Identifies this editor across reconnects so replays can recognise our own ops. */
  readonly sid: string

  constructor(sid = '') {
    this.sid = sid
  }

  isSynced(): boolean {
    return this.inflight === null && this.local === this.base
  }

  setOnline(online: boolean): void {
    this.online = online
  }

  private step(send: Op | null): ClientStep {
    return { kind: 'ok', send, baseVersion: this.version, n: send ? this.inflightSeq : 0 }
  }

  private flush(): ClientStep {
    if (!this.online || this.inflight) return this.step(null)
    const op = nextOp(this.base, this.local)
    if (!op) return this.step(null)
    this.inflight = op
    this.inflightSeq = ++this.seq
    return this.step(op)
  }

  /** Hard reset to the server state (first connect, or after the server told us to resync). */
  rebase(serverText: string, version: number): ClientStep {
    this.base = serverText
    this.local = serverText
    this.version = version
    this.inflight = null
    this.online = true
    return this.flush()
  }

  /**
   * Reconcile local edits with a server state we cannot replay to. Three-way merge
   * against the last base we knew. If server and client made the identical change,
   * it is treated as already applied rather than duplicated.
   */
  merge(serverText: string, version: number): ClientStep {
    const mine = diffOps(this.base, this.local)
    const theirs = diffOps(this.base, serverText)
    const identical = mine.length === theirs.length && mine.every((m, i) => sameOp(m, theirs[i]!))
    let merged = serverText
    if (!identical) for (const op of transformSeq(mine, theirs)) merged = applyOp(merged, op)
    this.base = serverText
    this.local = merged
    this.version = version
    this.inflight = null
    this.online = true
    return this.flush()
  }

  /**
   * Resume after a reconnect. `connectedAt` is the version announced to the server.
   * When the server replayed the ops we missed they are applied as if we never left
   * (our own in-flight op shows up in the replay and counts as acknowledged).
   */
  resume(state: ServerState, connectedAt: number): ClientStep {
    this.online = true
    const replay = state.replay
    if (replay && this.version === connectedAt) {
      let ok = true
      for (const r of replay) {
        if (this.inflight && r.sid === this.sid && r.n === this.inflightSeq) ok = this.applyAck(r.v)
        else ok = this.remote({ s: r.s, e: r.e, x: r.x }, r.v).kind === 'ok'
        if (!ok) break
      }
      if (ok && this.version === state.version && hashText(this.base) === hashText(state.text)) {
        if (this.inflight) {
          // The server never saw our op: it is already adapted to the current base, resend it.
          this.inflightSeq = ++this.seq
          return this.step(this.inflight)
        }
        return this.flush()
      }
    }
    return this.merge(state.text, state.version)
  }

  /** The user edited the textarea. */
  edit(text: string): ClientStep {
    this.local = text
    return this.flush()
  }

  private applyAck(version: number): boolean {
    if (!this.inflight || version !== this.version + 1) return false
    this.base = applyOp(this.base, this.inflight)
    this.version = version
    this.inflight = null
    return true
  }

  /** The server accepted our in-flight op as `version`. */
  ack(version: number): ClientStep {
    if (!this.applyAck(version)) return { kind: 'desync' }
    return this.flush()
  }

  /** Another client's op, accepted by the server as `version`. */
  remote(op: Op, version: number): RemoteStep {
    if (version !== this.version + 1 || !isValidOp(op) || op.e > this.base.length) return { kind: 'desync' }

    let adapted = op
    let nextInflight = this.inflight
    let mid = this.base
    if (this.inflight) {
      adapted = transformOp(op, this.inflight, false)
      nextInflight = transformOp(this.inflight, op, true)
      mid = applyOp(this.base, this.inflight)
    }
    // Carry the op through whatever the user has typed since (recovered by diff).
    for (const buffered of diffOps(mid, this.local)) adapted = transformOp(adapted, buffered, false)
    if (adapted.e > this.local.length) return { kind: 'desync' }

    this.local = applyOp(this.local, adapted)
    this.base = applyOp(this.base, op)
    this.version = version
    this.inflight = nextInflight
    return { kind: 'ok', applied: adapted }
  }
}
