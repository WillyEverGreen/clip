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
    if ((role !== 'sender' && role !== 'receiver') || !BEAM_PIN_RE.test(pin)) {
      return new Response('Bad request', { status: 400 })
    }
    // Lets the worker pick another PIN before any socket is opened
    if (role === 'sender' && this.room.sender) {
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
    if (role === 'sender') {
      this.room.addSender(peer, pin, now, name)
      await this.scheduleExpiry()
    } else {
      this.room.addReceiver(peer, now, name)
      await this.scheduleExpiry()
    }

    server.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
      this.room.handleMessage(peer, raw, Date.now())
    })
    const drop = () => {
      this.room.remove(peer)
      if (!this.room.sender) this.ctx.storage.deleteAlarm().catch(() => {})
    }
    server.addEventListener('close', () => {
      drop()
      // Finish the close handshake, or the client's socket never reports closed
      peer.close(1000, 'bye')
    })
    server.addEventListener('error', drop)

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
