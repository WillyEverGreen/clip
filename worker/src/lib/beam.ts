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

export interface BeamPeer {
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface BeamFileOffer {
  name: string
  size: number
  type: string
}

/** Message types each side may send; everything is relayed to the other side unchanged except `file_offer`. */
const RELAYED: Record<BeamRole, Set<string>> = {
  sender: new Set(['file_offer', 'signal', 'transfer_complete', 'cancel']),
  receiver: new Set(['file_accept', 'file_reject', 'signal', 'transfer_complete', 'cancel']),
}

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
  receiver: BeamPeer | null = null
  offer: BeamFileOffer | null = null
  createdAt = 0
  lastActivity = 0

  /** Opens the room for a sender. Returns false when the PIN already has one. */
  addSender(peer: BeamPeer, pin: string, now: number): boolean {
    if (this.sender) return false
    this.pin = pin
    this.sender = peer
    this.receiver = null
    this.offer = null
    this.createdAt = now
    this.lastActivity = now
    send(peer, { type: 'room_created', pin })
    return true
  }

  /** Lets one receiver in. Anyone else gets an error and is closed. */
  addReceiver(peer: BeamPeer, now: number): 'ok' | 'no_room' | 'room_full' {
    if (!this.sender) {
      send(peer, { type: 'error', code: 'no_room', message: 'No transfer is waiting on that PIN.' })
      peer.close(4004, 'no_room')
      return 'no_room'
    }
    if (this.receiver) {
      send(peer, { type: 'error', code: 'room_full', message: 'Someone else is already receiving this file.' })
      peer.close(4009, 'room_full')
      return 'room_full'
    }
    this.receiver = peer
    this.lastActivity = now
    send(peer, { type: 'joined', offer: this.offer })
    send(this.sender, { type: 'peer_joined' })
    return 'ok'
  }

  roleOf(peer: BeamPeer): BeamRole | null {
    if (peer === this.sender) return 'sender'
    if (peer === this.receiver) return 'receiver'
    return null
  }

  handleMessage(peer: BeamPeer, raw: string, now: number): void {
    const role = this.roleOf(peer)
    if (!role) return
    this.lastActivity = now
    if (raw.length > BEAM_MAX_MESSAGE_BYTES) {
      send(peer, { type: 'error', code: 'too_large', message: 'Signalling message too large.' })
      return
    }
    let msg: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
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
      send(peer, { type: 'error', code: 'bad_message', message: `Unexpected message: ${type || '(none)'}` })
      return
    }

    let out: Record<string, unknown> = msg
    if (type === 'file_offer') {
      const offer = cleanOffer(msg.offer)
      if (!offer) {
        send(peer, { type: 'error', code: 'bad_offer', message: 'File details are missing or invalid.' })
        return
      }
      this.offer = offer
      out = { type, offer }
    }

    const other = role === 'sender' ? this.receiver : this.sender
    if (other) send(other, out)
  }

  /** Called when a socket closes or errors. */
  remove(peer: BeamPeer): void {
    if (peer === this.sender) {
      const receiver = this.receiver
      this.reset()
      if (receiver) {
        send(receiver, { type: 'peer_left', role: 'sender' })
        receiver.close(1000, 'sender_left')
      }
    } else if (peer === this.receiver) {
      this.receiver = null
      if (this.sender) send(this.sender, { type: 'peer_left', role: 'receiver' })
    }
  }

  /** When the room should next be checked for expiry, or null if it is empty. */
  deadline(): number | null {
    if (!this.sender) return null
    return (this.receiver ? this.lastActivity : this.createdAt) + BEAM_IDLE_MS
  }

  /** Closes the room if it has expired. Returns true when it did. */
  expireIfIdle(now: number): boolean {
    const deadline = this.deadline()
    if (deadline === null || now < deadline) return false
    const peers = [this.sender, this.receiver]
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
    this.receiver = null
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
