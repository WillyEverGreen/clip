/**
 * Clip Beam signalling logic, kept free of Cloudflare APIs so it can be tested in Node.
 *
 * One room per PIN. The sender opens the room, one receiver joins with the PIN, and the room
 * relays a whitelisted set of small JSON messages (file offer, accept/reject, SDP and ICE)
 * between the two. File bytes never pass through here: they go over the peers' RTCDataChannel.
 */

export const BEAM_PIN_RE = /^\d{6}$/
/** An unpaired room, or a paired room with no signalling traffic, is closed after this long. */
export const BEAM_IDLE_MS = 10 * 60_000
/** SDP offers are a few KB; anything far bigger is not signalling. */
export const BEAM_MAX_MESSAGE_BYTES = 64 * 1024
const MAX_FILE_NAME_CHARS = 255

export type BeamRole = 'sender' | 'receiver'

const MAX_NAME_CHARS = 24

/** Display names come from clients: strip control chars, collapse whitespace, cap the length. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS)
  return name || null
}

/** Keep names unique in a room: if `base` is taken, "Mochi" becomes "Mochi 2", "Mochi 3", ... */
export function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`
    const candidate = base.slice(0, MAX_NAME_CHARS - suffix.length) + suffix
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

export interface BeamPeer {
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface BeamFileOffer {
  name: string
  size: number
  type: string
}

/** Message types each side may send. Receiver messages reach the sender tagged with `from`. */
const RELAYED: Record<BeamRole, Set<string>> = {
  sender: new Set(['file_offer', 'signal', 'cancel']),
  receiver: new Set(['file_accept', 'file_reject', 'signal', 'cancel']),
}

/** One sender can feed this many receivers at once. */
export const BEAM_MAX_RECEIVERS = 8

/** Six random digits, without modulo bias. */
export function generateBeamPin(): string {
  const buf = new Uint32Array(1)
  const limit = Math.floor(2 ** 32 / 1_000_000) * 1_000_000
  for (;;) {
    crypto.getRandomValues(buf)
    if (buf[0] < limit) return String(buf[0] % 1_000_000).padStart(6, '0')
  }
}

export function cleanOffer(value: unknown): BeamFileOffer | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.name !== 'string' || typeof v.size !== 'number') return null
  if (!Number.isSafeInteger(v.size) || v.size < 0) return null
  // eslint-disable-next-line no-control-regex
  const name = v.name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, MAX_FILE_NAME_CHARS)
  if (!name) return null
  const type = typeof v.type === 'string' && v.type.length <= 255 ? v.type : ''
  return { name, size: v.size, type }
}

export class BeamSignalRoom {
  pin = ''
  sender: BeamPeer | null = null
  receivers = new Map<string, BeamPeer>()
  senderName = ''
  receiverNames = new Map<string, string>()
  offer: BeamFileOffer | null = null
  createdAt = 0
  lastActivity = 0
  /** When the room last had no receivers; an unattended room expires from here, pings or not. */
  emptySince = 0
  /** Secret the sender needs to take its room back after a dropped connection. */
  senderToken = ''
  /** The sender's socket dropped (not a deliberate stop); the room is held for it until `awaySince` + idle time. */
  senderAway = false
  awaySince = 0
  private nextId = 1

  /** Opens the room for a sender. Returns false when the PIN already has one. */
  addSender(peer: BeamPeer, pin: string, now: number, name?: unknown): boolean {
    if (this.sender) return false
    this.pin = pin
    if (this.senderAway) return false // the PIN is being held for the sender that lost its connection
    this.sender = peer
    this.senderToken = crypto.randomUUID()
    this.senderAway = false
    this.senderName = cleanName(name) ?? 'Sender'
    this.receivers.clear()
    this.receiverNames.clear()
    this.offer = null
    this.createdAt = now
    this.lastActivity = now
    this.emptySince = now
    send(peer, { type: 'room_created', pin, name: this.senderName, token: this.senderToken })
    return true
  }

  /**
   * The sender came back after its connection dropped. Needs the token from room_created.
   * Receivers that stayed are re-announced to it so it can pick their transfers up again.
   */
  reclaimSender(peer: BeamPeer, token: string, now: number): boolean {
    if (!this.senderAway || this.sender || !token || token !== this.senderToken) {
      send(peer, { type: 'error', code: 'no_room', message: 'That Beam is no longer open. Start a new one.' })
      peer.close(4004, 'no_room')
      return false
    }
    this.sender = peer
    this.senderAway = false
    this.lastActivity = now
    if (this.receivers.size === 0) this.emptySince = now
    send(peer, { type: 'room_resumed', pin: this.pin, name: this.senderName })
    for (const [id, name] of this.receiverNames) send(peer, { type: 'peer_joined', id, name })
    for (const r of this.receivers.values()) send(r, { type: 'sender_back' })
    return true
  }

  /** Lets a receiver in. Returns its id, or an error code (the peer has been told and closed). */
  addReceiver(peer: BeamPeer, now: number, name?: unknown, resume = false): { id: string; name: string } | { error: 'no_room' | 'room_full' | 'sender_away' } {
    if (!this.sender && !this.senderAway) {
      send(peer, { type: 'error', code: 'no_room', message: 'No transfer is waiting on that PIN.' })
      peer.close(4004, 'no_room')
      return { error: 'no_room' }
    }
    if (this.senderAway && !resume) {
      // Only a receiver coming back to a transfer it already had may wait for the sender; a new one should retry
      send(peer, { type: 'error', code: 'sender_away', message: 'The sender lost their connection. Ask them to check it, then try again.' })
      peer.close(4011, 'sender_away')
      return { error: 'sender_away' }
    }
    if (this.receivers.size >= BEAM_MAX_RECEIVERS) {
      send(peer, { type: 'error', code: 'room_full', message: 'This transfer already has the maximum number of receivers.' })
      peer.close(4009, 'room_full')
      return { error: 'room_full' }
    }
    const id = `r${this.nextId++}`
    const taken = new Set([this.senderName.toLowerCase(), ...[...this.receiverNames.values()].map((n) => n.toLowerCase())])
    const shown = uniqueName(cleanName(name) ?? 'Guest', taken)
    this.receivers.set(id, peer)
    this.receiverNames.set(id, shown)
    this.lastActivity = now
    send(peer, { type: 'joined', offer: this.offer, name: shown, sender: this.senderName, away: this.senderAway })
    if (this.sender) send(this.sender, { type: 'peer_joined', id, name: shown })
    return { id, name: shown }
  }

  roleOf(peer: BeamPeer): { role: BeamRole; id?: string } | null {
    if (peer === this.sender) return { role: 'sender' }
    for (const [id, p] of this.receivers) if (p === peer) return { role: 'receiver', id }
    return null
  }

  handleMessage(peer: BeamPeer, raw: string, now: number): void {
    const who = this.roleOf(peer)
    if (!who) return
    const { role } = who
    this.lastActivity = now
    if (raw.length > BEAM_MAX_MESSAGE_BYTES) {
      send(peer, { type: 'error', code: 'too_large', message: 'Signalling message too large.' })
      return
    }
    let msg: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      msg = parsed as Record<string, unknown>
    } catch {
      send(peer, { type: 'error', code: 'bad_message', message: 'Could not read that message.' })
      return
    }

    const type = typeof msg.type === 'string' ? msg.type : ''
    if (type === 'ping') {
      send(peer, { type: 'pong' })
      return
    }
    if (!RELAYED[role].has(type)) {
      send(peer, { type: 'error', code: 'bad_message', message: `Unexpected message: ${type.slice(0, 40) || '(none)'}` })
      return
    }

    if (role === 'receiver') {
      // Rebuilt from known fields so a receiver cannot smuggle a `from`, or anything else, to the sender
      if (this.sender) send(this.sender, { type, from: who.id, data: msg.data })
      return
    }

    if (type === 'file_offer') {
      const offer = cleanOffer(msg.offer)
      if (!offer) {
        send(peer, { type: 'error', code: 'bad_offer', message: 'File details are missing or invalid.' })
        return
      }
      this.offer = offer
      for (const r of this.receivers.values()) send(r, { type, offer })
      return
    }

    // signal / cancel: to one receiver, or (cancel only) everyone
    const to = typeof msg.to === 'string' ? msg.to : null
    const out = { type, data: msg.data }
    if (to) {
      const target = this.receivers.get(to)
      if (target) send(target, out)
    } else if (type === 'cancel') {
      for (const r of this.receivers.values()) send(r, out)
    }
  }

  /**
   * Called when a socket closes or errors. `abrupt` means the connection was lost rather than closed
   * on purpose; the sender's room is then held for it (with its receivers) so it can reconnect.
   */
  remove(peer: BeamPeer, now = Date.now(), abrupt = false): void {
    if (peer === this.sender && abrupt && this.senderToken) {
      this.sender = null
      this.senderAway = true
      this.awaySince = now
      for (const r of this.receivers.values()) send(r, { type: 'sender_away' })
      return
    }
    if (peer === this.sender) {
      const receivers = [...this.receivers.values()]
      this.reset()
      for (const r of receivers) {
        send(r, { type: 'peer_left', role: 'sender' })
        r.close(1000, 'sender_left')
      }
      return
    }
    const who = this.roleOf(peer)
    if (who?.id) {
      this.receivers.delete(who.id)
      this.receiverNames.delete(who.id)
      if (this.receivers.size === 0) this.emptySince = now
      if (this.sender) send(this.sender, { type: 'peer_left', role: 'receiver', id: who.id })
    }
  }

  /** When the room should next be checked for expiry, or null if it is empty. */
  deadline(): number | null {
    if (this.senderAway) return this.awaySince + BEAM_IDLE_MS
    if (!this.sender) return null
    return (this.receivers.size > 0 ? this.lastActivity : this.emptySince) + BEAM_IDLE_MS
  }

  /** Closes the room if it has expired. Returns true when it did. */
  expireIfIdle(now: number): boolean {
    const deadline = this.deadline()
    if (deadline === null || now < deadline) return false
    const peers = [this.sender, ...this.receivers.values()]
    this.reset()
    for (const p of peers) {
      if (!p) continue
      send(p, { type: 'error', code: 'expired', message: 'This Beam room timed out.' })
      p.close(4008, 'expired')
    }
    return true
  }

  private reset(): void {
    this.pin = ''
    this.sender = null
    this.senderToken = ''
    this.senderAway = false
    this.awaySince = 0
    this.senderName = ''
    this.receivers.clear()
    this.receiverNames.clear()
    this.offer = null
  }
}

function send(peer: BeamPeer, msg: object): void {
  try {
    peer.send(JSON.stringify(msg))
  } catch {
    // Socket already closed; its close handler will clean up
  }
}
