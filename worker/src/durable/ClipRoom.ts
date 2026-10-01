/**
 * ClipRoom — Cloudflare Durable Object
 *
 * One instance per slug.
 * Manages:
 * 1. Open SSE streams for read updates
 * 2. Active WebSockets for Live Pad real-time collaborative text & file sharing
 * 3. In-memory and persistent SQLite storage of current live text and attached files
 * 4. Password protection, access control verification & zero-knowledge security
 */
import { DurableObject } from 'cloudflare:workers'
import type { Env, FileItem } from '../lib/types'

export interface RoomSecurity {
  isProtected: boolean
  salt?: string
  authHash?: string
}

export class ClipRoom extends DurableObject<Env> {
  // SSE clients
  private clients: Map<string, WritableStreamDefaultWriter<Uint8Array>> = new Map()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private encoder = new TextEncoder()

  // Live Pad state
  private sockets: Set<WebSocket> = new Set()
  private authenticatedSockets: Set<WebSocket> = new Set()
  private clientMap: Map<string, WebSocket> = new Map()
  private socketToClient: Map<WebSocket, string> = new Map()
  private currentText: string = ''
  private currentFiles: FileItem[] = []
  private roomSecurity: RoomSecurity = { isProtected: false }
  private loadedStorage: boolean = false

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.ctx.blockConcurrencyWhile(async () => {
      try {
        const saved = await this.ctx.storage.get<{ text: string; files: FileItem[]; expiresAt?: number }>('live_state')
        if (saved) {
          if (saved.expiresAt && Date.now() > saved.expiresAt) {
            // Room expired after 24 hours of inactivity
            await this.ctx.storage.deleteAll()
            this.currentText = ''
            this.currentFiles = []
            this.roomSecurity = { isProtected: false }
          } else {
            this.currentText = saved.text || ''
            this.currentFiles = saved.files || []
          }
        }
        const sec = await this.ctx.storage.get<RoomSecurity>('room_security')
        if (sec) {
          this.roomSecurity = sec
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
      this.clientMap.set(clientId, server)
      this.socketToClient.set(server, clientId)

      // If room is protected, require authentication challenge before sharing state
      if (this.roomSecurity.isProtected) {
        server.send(JSON.stringify({
          type: 'auth_challenge',
          isProtected: true,
          salt: this.roomSecurity.salt,
          peers: this.sockets.size,
          peerIds: Array.from(this.clientMap.keys()),
          clientId,
        }))
      } else {
        this.authenticatedSockets.add(server)
        server.send(JSON.stringify({
          type: 'init',
          text: this.currentText,
          files: this.currentFiles,
          peers: this.sockets.size,
          peerIds: Array.from(this.clientMap.keys()),
          clientId,
        }))
      }

      // Broadcast new peer count to everyone
      this.broadcastWebsocket({
        type: 'peers',
        peers: this.sockets.size,
        peerIds: Array.from(this.clientMap.keys()),
      })

      server.addEventListener('message', (event) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
          const data = JSON.parse(raw)

          if (data.type === 'auth') {
            if (this.roomSecurity.isProtected && data.hash && data.hash === this.roomSecurity.authHash) {
              this.authenticatedSockets.add(server)
              server.send(JSON.stringify({
                type: 'init',
                text: this.currentText,
                files: this.currentFiles,
                peers: this.sockets.size,
                peerIds: Array.from(this.clientMap.keys()),
                clientId,
              }))
            } else {
              server.send(JSON.stringify({
                type: 'auth_error',
                message: 'Incorrect password',
              }))
            }
            return
          }

          // Protected room: ignore commands if not authenticated
          if (this.roomSecurity.isProtected && !this.authenticatedSockets.has(server)) {
            return
          }

          // ── WebRTC Signaling Relay ───────────────────────────────────────
          if (data.type === 'rtc_signal' && typeof data.targetId === 'string' && data.payload) {
            const targetWs = this.clientMap.get(data.targetId)
            if (targetWs) {
              try {
                targetWs.send(JSON.stringify({
                  type: 'rtc_signal',
                  senderId: clientId,
                  payload: data.payload,
                }))
              } catch {}
            }
            return
          }

          if (data.type === 'text' && typeof data.text === 'string') {
            this.currentText = data.text
            // Persist with 24-hour rolling TTL
            this.persistLiveState()
            // Broadcast to other authenticated peers
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
        this.authenticatedSockets.delete(server)
        this.clientMap.delete(clientId)
        this.socketToClient.delete(server)
        this.broadcastWebsocket({
          type: 'peers',
          peers: this.sockets.size,
          peerIds: Array.from(this.clientMap.keys()),
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
      const isProt = !!this.roomSecurity?.isProtected
      return new Response(JSON.stringify({
        text: isProt ? '' : this.currentText,
        files: isProt ? [] : this.currentFiles,
        peers: this.sockets.size,
        isProtected: isProt,
        salt: this.roomSecurity?.salt,
      }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // ── POST /room/:slug/live-state — authenticated state fetch ────────────
    if (request.method === 'POST' && url.pathname.includes('/live-state')) {
      let isAuthed = !this.roomSecurity.isProtected
      try {
        const body = await request.json() as { hash?: string }
        if (this.roomSecurity.isProtected && body.hash && body.hash === this.roomSecurity.authHash) {
          isAuthed = true
        }
      } catch {}

      if (!isAuthed) {
        return new Response(JSON.stringify({
          isProtected: true,
          salt: this.roomSecurity.salt,
          error: 'auth_required',
        }), { status: 401, headers: { 'Content-Type': 'application/json' } })
      }

      return new Response(JSON.stringify({
        text: this.currentText,
        files: this.currentFiles,
        peers: this.sockets.size,
        isProtected: !!this.roomSecurity?.isProtected,
      }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // ── POST /room/:slug/security — update room password protection ───────
    if (request.method === 'POST' && url.pathname.includes('/security')) {
      try {
        const body = await request.json() as RoomSecurity
        this.roomSecurity = {
          isProtected: !!body.isProtected,
          salt: body.salt,
          authHash: body.authHash,
        }
        await this.ctx.storage.put('room_security', this.roomSecurity)
        await this.persistLiveState()
        this.authenticatedSockets.clear()
        return new Response(JSON.stringify({ ok: true, isProtected: this.roomSecurity.isProtected }), {
          headers: { 'Content-Type': 'application/json' },
        })
      } catch {
        return new Response(JSON.stringify({ error: 'invalid_security_payload' }), { status: 400 })
      }
    }

    // ── POST /room/:slug/seed — seed room from static KV clip if empty ─────
    if (request.method === 'POST' && url.pathname.includes('/seed')) {
      try {
        const body = await request.json() as { text?: string; files?: FileItem[]; security?: RoomSecurity }
        let changed = false
        if (!this.currentText && body.text) {
          this.currentText = body.text
          changed = true
        }
        if (this.currentFiles.length === 0 && Array.isArray(body.files) && body.files.length > 0) {
          this.currentFiles = body.files
          changed = true
        }
        if (body.security && !this.roomSecurity.isProtected) {
          this.roomSecurity = body.security
          await this.ctx.storage.put('room_security', this.roomSecurity)
        }
        if (changed || body.security) {
          await this.persistLiveState()
        }
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
        })
      } catch {
        return new Response(JSON.stringify({ error: 'seed_failed' }), { status: 400 })
      }
    }

    // ── POST /room/:slug/live-file — file added to Live Pad ────────────────
    if (request.method === 'POST' && url.pathname.includes('/live-file')) {
      try {
        const body = await request.json() as { file: FileItem }
        if (body?.file) {
          // Avoid duplicates
          this.currentFiles = this.currentFiles.filter(f => f.id !== body.file.id)
          this.currentFiles.push(body.file)
          await this.persistLiveState()
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
        await this.persistLiveState()
        this.broadcastWebsocket({
          type: 'file_removed',
          fileId,
        })
      }
      return new Response('ok', { status: 200 })
    }

    // ── POST /room/:slug/live-files-delete — batch delete files ────────────
    if (request.method === 'POST' && url.pathname.includes('/live-files-delete')) {
      try {
        const body = await request.json() as { fileIds: string[] }
        if (Array.isArray(body?.fileIds) && body.fileIds.length > 0) {
          const idSet = new Set(body.fileIds)
          this.currentFiles = this.currentFiles.filter(f => !idSet.has(f.id))
          await this.persistLiveState()
          this.broadcastWebsocket({
            type: 'files_removed',
            fileIds: body.fileIds,
          })
        }
      } catch {}
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
      // If room is protected, only broadcast sensitive updates (text, files) to authenticated peers
      if (this.roomSecurity.isProtected && !this.authenticatedSockets.has(ws) && msgObj.type !== 'peers') {
        continue
      }
      try {
        ws.send(msg)
      } catch {
        dead.push(ws)
      }
    }
    for (const ws of dead) {
      this.sockets.delete(ws)
      this.authenticatedSockets.delete(ws)
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

  private async persistLiveState() {
    const expiresAt = Date.now() + 24 * 3600 * 1000
    try {
      await this.ctx.storage.put('live_state', {
        text: this.currentText,
        files: this.currentFiles,
        expiresAt,
      })
      await this.ctx.storage.setAlarm(expiresAt)
    } catch {}
  }

  async alarm(): Promise<void> {
    try {
      await this.ctx.storage.deleteAll()
    } catch {}
    this.currentText = ''
    this.currentFiles = []
    this.roomSecurity = { isProtected: false }
    this.authenticatedSockets.clear()
  }

  private encode(text: string): Uint8Array {
    return this.encoder.encode(text)
  }
}
