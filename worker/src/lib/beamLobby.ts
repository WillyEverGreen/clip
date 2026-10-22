/**
 * Clip Beam "nearby" lobby logic, kept free of Cloudflare APIs so it can be tested in Node.
 *
 * One lobby per group of people on the same public IP. Visibility is one-way:
 *   - receivers who switched on Receive mode are listed to senders (random name only),
 *   - senders are never listed to anyone,
 *   - receivers never see each other.
 * A sender invites chosen receivers with the PIN of a Beam room it already opened; the receiver
 * accepts (and joins that room itself) or declines, optionally blocking that sender.
 * The lobby carries only names, ids and small invites. File bytes never come near it.
 */
import { BEAM_MAX_MESSAGE_BYTES, BEAM_MAX_RECEIVERS, BEAM_PIN_RE, cleanName, cleanOffer, uniqueName, type BeamFileOffer, type BeamPeer } from './beam.ts'

export const LOBBY_MAX_MEMBERS = 200
/** Clients ping every 25 s; hidden tabs can be throttled to about once a minute. */
export const LOBBY_STALE_MS = 150_000
export const LOBBY_SWEEP_MS = 30_000
/** A sender may send this many invite messages per minute. */
export const LOBBY_INVITES_PER_MIN = 30

export type LobbyRole = 'sender' | 'receiver'

export interface LobbyPersonView {
  id: string
  name: string
}

interface Member {
  id: string
  role: LobbyRole
  name: string
  peer: BeamPeer
  lastSeen: number
  /** Sender ids this receiver blocked */
  blocked: Set<string>
  /** Invite timestamps in the last minute (senders) */
  inviteTimes: number[]
}

interface Invite {
  id: string
  from: string
  to: string
}

export class BeamLobbyRoom {
  private members = new Map<string, Member>()
  private byPeer = new Map<BeamPeer, string>()
  private invites = new Map<string, Invite>()
  private nextId = 1
  private nextInvite = 1

  get size(): number {
    return this.members.size
  }

  /** Adds a member and tells everyone who needs to know. */
  add(peer: BeamPeer, role: LobbyRole, name: unknown, now: number): { id: string; name: string } | { error: 'lobby_full' } {
    if (this.members.size >= LOBBY_MAX_MEMBERS) {
      send(peer, { type: 'error', code: 'lobby_full', message: 'Too many people are here right now. Try again in a moment.' })
      peer.close(4010, 'lobby_full')
      return { error: 'lobby_full' }
    }
    const taken = new Set([...this.members.values()].map((m) => m.name.toLowerCase()))
    const shown = uniqueName(cleanName(name) ?? (role === 'sender' ? 'Sender' : 'Guest'), taken)
    const id = `${role === 'sender' ? 's' : 'r'}${this.nextId++}`
    this.members.set(id, { id, role, name: shown, peer, lastSeen: now, blocked: new Set(), inviteTimes: [] })
    this.byPeer.set(peer, id)
    send(peer, { type: 'welcome', id, name: shown, role })
    if (role === 'sender') send(peer, { type: 'peers', peers: this.receivers() })
    else this.broadcastPeers()
    return { id, name: shown }
  }

  handleMessage(peer: BeamPeer, raw: string, now: number): void {
    const id = this.byPeer.get(peer)
    const me = id ? this.members.get(id) : undefined
    if (!me) return
    me.lastSeen = now
    if (raw.length > BEAM_MAX_MESSAGE_BYTES) {
      send(peer, { type: 'error', code: 'too_large', message: 'Message too large.' })
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

    if (me.role === 'sender') {
      if (type === 'invite') this.onInvite(me, msg, now)
      else if (type === 'cancel_invites') this.cancelInvitesFrom(me.id)
      else send(peer, { type: 'error', code: 'bad_message', message: `Unexpected message: ${type.slice(0, 40) || '(none)'}` })
      return
    }

    if (type === 'accept' || type === 'decline') this.onResponse(me, msg, type === 'accept')
    else send(peer, { type: 'error', code: 'bad_message', message: `Unexpected message: ${type.slice(0, 40) || '(none)'}` })
  }

  /** A socket closed. Receivers vanish from radars; a sender's open invites are withdrawn. */
  remove(peer: BeamPeer): void {
    const id = this.byPeer.get(peer)
    if (!id) return
    const me = this.members.get(id)
    this.byPeer.delete(peer)
    this.members.delete(id)
    if (!me) return
    if (me.role === 'sender') {
      this.cancelInvitesFrom(id)
    } else {
      for (const [invId, inv] of this.invites) {
        if (inv.to === id) {
          this.invites.delete(invId)
          const sender = this.members.get(inv.from)
          if (sender) send(sender.peer, { type: 'invite_closed', to: id, reason: 'left' })
        }
      }
      this.broadcastPeers()
    }
  }

  /** Drops members that went quiet (closed laptop, dead connection). Returns how many were dropped. */
  sweep(now: number): number {
    let dropped = 0
    for (const m of [...this.members.values()]) {
      if (now - m.lastSeen > LOBBY_STALE_MS) {
        this.remove(m.peer)
        m.peer.close(4008, 'idle')
        dropped++
      }
    }
    return dropped
  }

  private receivers(): LobbyPersonView[] {
    return [...this.members.values()].filter((m) => m.role === 'receiver').map((m) => ({ id: m.id, name: m.name }))
  }

  private broadcastPeers(): void {
    const peers = this.receivers()
    for (const m of this.members.values()) if (m.role === 'sender') send(m.peer, { type: 'peers', peers })
  }

  private onInvite(me: Member, msg: Record<string, unknown>, now: number): void {
    me.inviteTimes = me.inviteTimes.filter((t) => now - t < 60_000)
    if (me.inviteTimes.length >= LOBBY_INVITES_PER_MIN) {
      send(me.peer, { type: 'error', code: 'rate_limited', message: 'Too many requests. Wait a moment.' })
      return
    }
    me.inviteTimes.push(now)

    const pin = typeof msg.pin === 'string' ? msg.pin : ''
    const offer: BeamFileOffer | null = cleanOffer(msg.offer)
    if (!BEAM_PIN_RE.test(pin) || !offer || !Array.isArray(msg.to)) {
      send(me.peer, { type: 'error', code: 'bad_invite', message: 'That request was not valid.' })
      return
    }
    const targets = [...new Set(msg.to.filter((t): t is string => typeof t === 'string'))].slice(0, BEAM_MAX_RECEIVERS)
    for (const tid of targets) {
      const target = this.members.get(tid)
      if (!target || target.role !== 'receiver') {
        send(me.peer, { type: 'invite_closed', to: tid, reason: 'gone' })
        continue
      }
      if (target.blocked.has(me.id)) {
        // Blocked senders are told it was declined, never that they were blocked
        send(me.peer, { type: 'invite_closed', to: tid, reason: 'declined' })
        continue
      }
      // One open invite per pair: a new one replaces the old
      for (const [invId, inv] of this.invites) {
        if (inv.from === me.id && inv.to === tid) {
          this.invites.delete(invId)
          send(target.peer, { type: 'invite_gone', inviteId: invId })
        }
      }
      const inviteId = `i${this.nextInvite++}`
      this.invites.set(inviteId, { id: inviteId, from: me.id, to: tid })
      send(target.peer, { type: 'invite', inviteId, from: { id: me.id, name: me.name }, offer, pin })
      send(me.peer, { type: 'invite_sent', to: tid })
    }
  }

  private onResponse(me: Member, msg: Record<string, unknown>, accepted: boolean): void {
    const inviteId = typeof msg.inviteId === 'string' ? msg.inviteId : ''
    const inv = this.invites.get(inviteId)
    // Only the invited receiver can answer, and only once
    if (!inv || inv.to !== me.id) return
    this.invites.delete(inviteId)
    if (!accepted && msg.block === true) me.blocked.add(inv.from)
    const sender = this.members.get(inv.from)
    if (sender) send(sender.peer, accepted ? { type: 'invite_accepted', to: me.id } : { type: 'invite_closed', to: me.id, reason: 'declined' })
  }

  private cancelInvitesFrom(senderId: string): void {
    for (const [invId, inv] of this.invites) {
      if (inv.from !== senderId) continue
      this.invites.delete(invId)
      const target = this.members.get(inv.to)
      if (target) send(target.peer, { type: 'invite_gone', inviteId: invId })
    }
  }
}

function send(peer: BeamPeer, msg: object): void {
  try {
    peer.send(JSON.stringify(msg))
  } catch {
    // Socket already closed; its close handler will clean up
  }
}
