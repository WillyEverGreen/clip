/**
 * Client for the Beam "nearby" lobby.
 *
 * Receivers who switch on Receive mode are listed to senders on the same network (random name only).
 * Senders are invisible. A sender invites chosen receivers with the PIN of a room it already opened;
 * the receiver accepts (and joins that room) or declines, optionally blocking that sender.
 */
import { BASE } from '../lib/api'
import { PING_MS, type FileOffer } from './beamProtocol'

export type LobbyRole = 'sender' | 'receiver'
export type LobbyStatus = 'connecting' | 'online' | 'offline'

export interface NearbyPerson {
  id: string
  name: string
}

export interface LobbyInvite {
  inviteId: string
  from: NearbyPerson
  offer: FileOffer
  pin: string
}

export interface LobbyHandlers {
  onStatus?: (status: LobbyStatus, message?: string) => void
  onWelcome?: (id: string, name: string) => void
  /** Sender: the full list of visible receivers, sent whenever it changes */
  onPeers?: (peers: NearbyPerson[]) => void
  /** Receiver: someone wants to send a file */
  onInvite?: (invite: LobbyInvite) => void
  /** Receiver: that sender withdrew the request (or left) */
  onInviteGone?: (inviteId: string) => void
  /** Sender: the lobby delivered the request to this receiver */
  onInviteSent?: (to: string) => void
  /** Sender: this receiver said yes (it is joining the room) */
  onInviteAccepted?: (to: string) => void
  /** Sender: this receiver declined, left, or is gone */
  onInviteClosed?: (to: string, reason: 'declined' | 'left' | 'gone') => void
}

export function lobbyWsUrl(role: LobbyRole, name: string): string {
  let base: string
  if (BASE.startsWith('http')) {
    base = BASE.replace(/^http/, 'ws')
  } else {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    base = `${proto}//${window.location.host}`
  }
  const query = new URLSearchParams({ role })
  if (name) query.set('name', name)
  return `${base}/api/beam/lobby/ws?${query.toString()}`
}

export class BeamLobbyClient {
  private ws: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(
    private readonly role: LobbyRole,
    private readonly name: string,
    private readonly handlers: LobbyHandlers,
  ) {}

  connect(): void {
    this.handlers.onStatus?.('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(lobbyWsUrl(this.role, this.name))
    } catch {
      this.handlers.onStatus?.('offline', 'Could not reach Clip.')
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_MS)
    }
    ws.onmessage = (event) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(event.data)) as Record<string, unknown>
      } catch {
        return
      }
      this.onMessage(msg)
    }
    ws.onclose = () => {
      this.stopPing()
      this.ws = null
      if (!this.closed) this.handlers.onStatus?.('offline', 'Lost the connection to nearby discovery.')
    }
  }

  /** Sender: ask these receivers to take the file waiting in room `pin`. */
  invite(ids: string[], offer: FileOffer, pin: string): void {
    this.send({ type: 'invite', to: ids, offer, pin })
  }

  /** Sender: withdraw every open request (when sharing stops). */
  cancelInvites(): void {
    this.send({ type: 'cancel_invites' })
  }

  /** Receiver: answer a request. `block` also hides future requests from that sender. */
  respond(inviteId: string, accept: boolean, block = false): void {
    this.send(accept ? { type: 'accept', inviteId } : { type: 'decline', inviteId, block })
  }

  close(): void {
    this.closed = true
    this.stopPing()
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      try { ws.close(1000) } catch { /* already closed */ }
    }
  }

  private onMessage(msg: Record<string, unknown>): void {
    const h = this.handlers
    switch (msg.type) {
      case 'welcome':
        h.onStatus?.('online')
        h.onWelcome?.(String(msg.id), String(msg.name))
        break
      case 'peers':
        h.onPeers?.(Array.isArray(msg.peers) ? (msg.peers as NearbyPerson[]) : [])
        break
      case 'invite':
        h.onInvite?.({
          inviteId: String(msg.inviteId),
          from: msg.from as NearbyPerson,
          offer: msg.offer as FileOffer,
          pin: String(msg.pin),
        })
        break
      case 'invite_gone':
        h.onInviteGone?.(String(msg.inviteId))
        break
      case 'invite_sent':
        h.onInviteSent?.(String(msg.to))
        break
      case 'invite_accepted':
        h.onInviteAccepted?.(String(msg.to))
        break
      case 'invite_closed':
        h.onInviteClosed?.(String(msg.to), msg.reason === 'left' ? 'left' : msg.reason === 'gone' ? 'gone' : 'declined')
        break
      case 'error':
        h.onStatus?.('offline', typeof msg.message === 'string' ? msg.message : 'Nearby discovery stopped.')
        break
    }
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }
}
