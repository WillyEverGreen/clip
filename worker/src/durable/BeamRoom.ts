/**
 * BeamRoom — Cloudflare Durable Object
 *
 * One instance per Beam PIN. Pure WebRTC signalling relay between one sender and one receiver
 * (see lib/beam.ts). Holds only in-memory socket references; nothing is written to storage
 * except the expiry alarm.
 */
import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../lib/types'
import { BEAM_PIN_RE, BeamSignalRoom, type BeamPeer } from '../lib/beam'

export class BeamRoom extends DurableObject<Env> {
  private room = new BeamSignalRoom()

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }
    const url = new URL(request.url)
    const role = url.searchParams.get('role')
    const pin = url.searchParams.get('pin') ?? ''
    const name = url.searchParams.get('name')
    const token = url.searchParams.get('token')
    const resume = url.searchParams.get('resume') === '1'
    if ((role !== 'sender' && role !== 'receiver') || !BEAM_PIN_RE.test(pin)) {
      return new Response('Bad request', { status: 400 })
    }
    // Lets the worker pick another PIN before any socket is opened (a held room keeps its PIN too)
    if (role === 'sender' && !token && (this.room.sender || this.room.senderAway)) {
      return new Response('PIN in use', { status: 409 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    server.accept()
    const peer: BeamPeer = {
      send: (data) => server.send(data),
      close: (code, reason) => {
        try {
          server.close(code, reason)
        } catch {
          // Already closed
        }
      },
    }

    const now = Date.now()
    if (role === 'sender' && token) {
      this.room.reclaimSender(peer, token, now)
      await this.scheduleExpiry()
    } else if (role === 'sender') {
      this.room.addSender(peer, pin, now, name)
      await this.scheduleExpiry()
    } else {
      this.room.addReceiver(peer, now, name, resume)
      await this.scheduleExpiry()
    }

    server.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
      this.room.handleMessage(peer, raw, Date.now())
    })
    const drop = (abrupt: boolean) => {
      this.room.remove(peer, Date.now(), abrupt)
      if (!this.room.sender && !this.room.senderAway) this.ctx.storage.deleteAlarm().catch(() => {})
      else this.scheduleExpiry().catch(() => {})
    }
    // 1000 (or 1005, close() with no code) is a deliberate close (Stop sharing); anything else is a lost connection or a closed tab
    server.addEventListener('close', (event) => {
      drop(event.code !== 1000 && event.code !== 1005)
      // Finish the close handshake, or the client's socket never reports closed
      peer.close(1000, 'bye')
    })
    server.addEventListener('error', () => drop(true))

    return new Response(null, { status: 101, webSocket: client })
  }

  async alarm(): Promise<void> {
    if (!this.room.expireIfIdle(Date.now())) await this.scheduleExpiry()
  }

  private async scheduleExpiry(): Promise<void> {
    const deadline = this.room.deadline()
    if (deadline !== null) await this.ctx.storage.setAlarm(deadline)
  }
}
