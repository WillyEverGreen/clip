/**
 * ClipRoom — Cloudflare Durable Object
 *
 * One instance per slug.
 * Manages:
 * 1. Open SSE streams for read updates
 * 2. Active WebSockets for Live Pad real-time collaborative text & file sharing
 * 3. In-memory and persistent SQLite storage of current live text and attached files
 */
import { DurableObject } from 'cloudflare:workers'
import type { Env, FileItem } from '../lib/types'

export class ClipRoom extends DurableObject<Env> {
  // SSE clients
  private clients: Map<string, WritableStreamDefaultWriter<Uint8Array>> = new Map()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private encoder = new TextEncoder()

  // Live Pad state
  private sockets: Set<WebSocket> = new Set()
  private currentText: string = ''
  private currentFiles: FileItem[] = []
  private loadedStorage: boolean = false

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.ctx.blockConcurrencyWhile(async () => {
      try {
        const saved = await this.ctx.storage.get<{ text: string; files: FileItem[] }>('live_state')
        if (saved) {
          this.currentText = saved.text || ''
          this.currentFiles = saved.files || []
        }
      } catch {
        // Storage init fallback
      }
      this.loadedStorage = true
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // ── WebSocket: Real-time Live Pad connection ──────────────────────────
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)

      server.accept()
      const clientId = crypto.randomUUID()
      this.sockets.add(server)

      // Send initial state to newly joined client
      server.send(JSON.stringify({
        type: 'init',
        text: this.currentText,
        files: this.currentFiles,
        peers: this.sockets.size,
        clientId,
      }))

      // Broadcast new peer count to everyone
      this.broadcastWebsocket({
        type: 'peers',
        peers: this.sockets.size,
      })

      server.addEventListener('message', (event) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
          const data = JSON.parse(raw)
          if (data.type === 'text' && typeof data.text === 'string') {
            this.currentText = data.text
            // Persist non-blocking in SQLite
            this.ctx.storage.put('live_state', { text: this.currentText, files: this.currentFiles })
            // Broadcast to other peers
            this.broadcastWebsocket({
              type: 'text',
              text: this.currentText,
              senderId: clientId,
            }, server)
          } else if (data.type === 'ping') {
            server.send(JSON.stringify({ type: 'pong' }))
          }
        } catch {
          // ignore malformed message
        }
      })

      const cleanup = () => {
        this.sockets.delete(server)
        this.broadcastWebsocket({
          type: 'peers',
          peers: this.sockets.size,
        })
      }

      server.addEventListener('close', cleanup)
      server.addEventListener('error', cleanup)

      return new Response(null, {
        status: 101,
        webSocket: client,
      })
    }

    // ── GET /room/:slug/live-state — get current live state ────────────────
    if (request.method === 'GET' && url.pathname.includes('/live-state')) {
      return new Response(JSON.stringify({
        text: this.currentText,
        files: this.currentFiles,
        peers: this.sockets.size,
      }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // ── POST /room/:slug/live-file — file added to Live Pad ────────────────
    if (request.method === 'POST' && url.pathname.includes('/live-file')) {
      try {
        const body = await request.json() as { file: FileItem }
        if (body?.file) {
          // Avoid duplicates
          this.currentFiles = this.currentFiles.filter(f => f.id !== body.file.id)
          this.currentFiles.push(body.file)
          this.ctx.storage.put('live_state', { text: this.currentText, files: this.currentFiles })
          // Broadcast to all active Live Pad sockets
          this.broadcastWebsocket({
            type: 'file_added',
            file: body.file,
          })
        }
      } catch {}
      return new Response('ok', { status: 200 })
    }

    // ── DELETE /room/:slug/live-file/:fileId — file removed from Live Pad ───
    if (request.method === 'DELETE' && url.pathname.includes('/live-file/')) {
      const fileId = url.pathname.split('/live-file/')[1] ?? ''
      if (fileId) {
        this.currentFiles = this.currentFiles.filter(f => f.id !== fileId)
        this.ctx.storage.put('live_state', { text: this.currentText, files: this.currentFiles })
        this.broadcastWebsocket({
          type: 'file_removed',
          fileId,
        })
      }
      return new Response('ok', { status: 200 })
    }

    // ── POST /room/:slug/notify — broadcast SSE update to paste viewers ───
    if (request.method === 'POST' && url.pathname.includes('/notify')) {
      const slug = url.pathname.split('/')[2] ?? ''
      let updatedAt: number | undefined
      try {
        const body = await request.json() as { updatedAt?: number }
        updatedAt = body?.updatedAt
      } catch {}
      await this.broadcastSSE(slug, updatedAt)
      return new Response('ok', { status: 200 })
    }

    // ── GET /room/:slug/events — open SSE stream for paste viewers ─────────
    if (request.method === 'GET' && url.pathname.includes('/events')) {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
      const writer = writable.getWriter()
      const clientId = crypto.randomUUID()

      this.clients.set(clientId, writer)
      this.ensureHeartbeat()

      try {
        await writer.write(this.encode('event: connected\ndata: {}\n\n'))
      } catch {
        this.clients.delete(clientId)
      }

      const cleanup = () => {
        this.clients.delete(clientId)
        if (this.clients.size === 0) {
          this.stopHeartbeat()
        }
      }

      readable.pipeTo(new WritableStream({ close: cleanup, abort: cleanup })).catch(cleanup)

      return new Response(readable, {
        headers: {
          'Content-Type':      'text/event-stream',
          'Cache-Control':     'no-cache, no-transform',
          'Connection':        'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      })
    }

    return new Response('Not found', { status: 404 })
  }

  // ── Broadcast to Live Pad WebSockets ──────────────────────────────────────
  private broadcastWebsocket(msgObj: any, excludeWs?: WebSocket) {
    const msg = JSON.stringify(msgObj)
    const dead: WebSocket[] = []
    for (const ws of this.sockets) {
      if (ws === excludeWs) continue
      try {
        ws.send(msg)
      } catch {
        dead.push(ws)
      }
    }
    for (const ws of dead) {
      this.sockets.delete(ws)
    }
  }

  // ── Broadcast update event to all SSE clients ─────────────────────────────
  private async broadcastSSE(slug: string, updatedAt?: number) {
    const data: { slug: string; updatedAt?: number } = { slug }
    if (updatedAt) data.updatedAt = updatedAt
    
    const msg = this.encode(`event: update\ndata: ${JSON.stringify(data)}\n\n`)
    const dead: string[] = []

    for (const [id, writer] of this.clients) {
      try {
        await writer.write(msg)
      } catch {
        dead.push(id)
      }
    }

    for (const id of dead) this.clients.delete(id)
  }

  // ── Heartbeat every 25s for SSE clients ───────────────────────────────────
  private ensureHeartbeat() {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(async () => {
      const ping = this.encode(': ping\n\n')
      const dead: string[] = []
      for (const [id, writer] of this.clients) {
        try {
          await writer.write(ping)
        } catch {
          dead.push(id)
        }
      }
      for (const id of dead) this.clients.delete(id)
      if (this.clients.size === 0) this.stopHeartbeat()
    }, 25_000)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private encode(text: string): Uint8Array {
    return this.encoder.encode(text)
  }
}
