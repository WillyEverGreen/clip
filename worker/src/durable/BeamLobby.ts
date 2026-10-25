/**
 * BeamLobby — Cloudflare Durable Object
 *
 * One instance per public-IP group. Lists receivers who opted in to senders on the same network and
 * relays small invites (see lib/beamLobby.ts). In memory only; the alarm just drops idle sockets.
 */
import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../lib/types'
import type { BeamPeer } from '../lib/beam'
import { BeamLobbyRoom, LOBBY_SWEEP_MS } from '../lib/beamLobby'

export class BeamLobby extends DurableObject<Env> {
  private lobby = new BeamLobbyRoom()

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }
    const url = new URL(request.url)
    const role = url.searchParams.get('role')
    if (role !== 'sender' && role !== 'receiver') return new Response('Bad request', { status: 400 })

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
    this.lobby.add(peer, role, url.searchParams.get('name'), Date.now())
    await this.ensureSweep()

    server.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
      this.lobby.handleMessage(peer, raw, Date.now())
    })
    server.addEventListener('close', () => {
      this.lobby.remove(peer)
      peer.close(1000, 'bye')
    })
    server.addEventListener('error', () => this.lobby.remove(peer))

    return new Response(null, { status: 101, webSocket: client })
  }

  async alarm(): Promise<void> {
    this.lobby.sweep(Date.now())
    await this.ensureSweep()
  }

  private async ensureSweep(): Promise<void> {
    if (this.lobby.size > 0) await this.ctx.storage.setAlarm(Date.now() + LOBBY_SWEEP_MS)
  }
}
