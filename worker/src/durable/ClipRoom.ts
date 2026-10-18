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
import { OtServerDoc, mapPos, hashText, type Op } from '../lib/ot'

const MAX_NAME_CHARS = 24
/** How long the doc must be quiet before clients are asked to verify they match the server. */
const CHECK_DELAY_MS = 1500
/** Clients ping every 20s, but hidden browser tabs can be throttled to about once a minute. */
const STALE_SOCKET_MS = 150_000
const STALE_SWEEP_MS = 30_000
/** Typing is saved at most this often; one write covers every edit made in the window. */
const PERSIST_DELAY_MS = 500
/** A viewer that cannot take a message within this long is dropped instead of holding up the rest. */
const SSE_WRITE_TIMEOUT_MS = 3000

interface PresenceInfo {
  name: string
  start: number
  end: number
}

// Display names come from clients: strip control chars, collapse whitespace, cap the length.
function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS)
  return name || null
}

/** Keep names unique in a room: if `base` is taken, "Mochi" becomes "Mochi 2", "Mochi 3", ... */
function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`
    const candidate = base.slice(0, MAX_NAME_CHARS - suffix.length) + suffix
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

function clampIndex(value: unknown, max: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? Math.min(Math.max(value, 0), max) : 0
}

function cleanSid(value: string | null): string {
  return value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : crypto.randomUUID()
}

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
  // The live text lives in an operational-transform document so concurrent typing merges
  private doc = new OtServerDoc('')
  private get currentText(): string { return this.doc.text }
  private set currentText(text: string) { this.doc.reset(text) }
  // Sockets that speak the op protocol; everyone else keeps receiving full-text updates
  private otSockets: Set<WebSocket> = new Set()
  private socketSid: Map<WebSocket, string> = new Map()
  // Multi-cursor presence, only for clients that opted in
  private presence: Map<string, PresenceInfo> = new Map()
  private checkTimer: ReturnType<typeof setTimeout> | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  // Last time each socket said anything, so connections that died silently can be dropped
  private lastSeen: Map<WebSocket, number> = new Map()
  private staleTimer: ReturnType<typeof setInterval> | null = null
  private currentFiles: FileItem[] = []
  private roomSecurity: RoomSecurity = { isProtected: false }
  private loadedStorage: boolean = false
  private slug: string = ''
  private createdAt: number = 0
  private updatedAt: number = 0
  private expiresAt: number = 0

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.ctx.blockConcurrencyWhile(async () => {
      try {
        const saved = await this.ctx.storage.get<{
          text: string
          files: FileItem[]
          expiresAt?: number
          createdAt?: number
          updatedAt?: number
          slug?: string
        }>('live_state')
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
            this.createdAt = saved.createdAt || 0
            this.updatedAt = saved.updatedAt || 0
            this.expiresAt = saved.expiresAt || 0
            if (saved.slug) this.slug = saved.slug
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
    const match = url.pathname.match(/(?:\/room\/|\/api\/live\/)([^\/]+)/)
    if (match && match[1]) {
      this.slug = match[1]
      const now = Date.now()
      if (!this.createdAt) this.createdAt = now
      if (!this.updatedAt) this.updatedAt = now
      if (!this.expiresAt) this.expiresAt = now + 24 * 3600 * 1000
    }

    // ── DELETE /room/:slug/terminate — terminate live room from admin ──────
    if (request.method === 'DELETE' && (url.pathname.includes('/terminate') || url.pathname.endsWith('/live-terminate'))) {
      for (const ws of this.sockets) {
        try {
          ws.send(JSON.stringify({ type: 'room_closed', message: 'Room has been terminated by administrator.' }))
          ws.close(1000, 'Room terminated')
        } catch {}
      }
      this.sockets.clear()
      this.authenticatedSockets.clear()
      this.clientMap.clear()
      this.socketToClient.clear()
      this.currentText = ''
      this.currentFiles = []
      this.roomSecurity = { isProtected: false }
      try {
        await this.ctx.storage.deleteAll()
      } catch {}
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // ── WebSocket: Real-time Live Pad connection ──────────────────────────
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)

      server.accept()
      const clientId = crypto.randomUUID()
      this.sockets.add(server)
      this.clientMap.set(clientId, server)
      this.socketToClient.set(server, clientId)
      this.lastSeen.set(server, Date.now())
      this.ensureStaleSweep()

      // Op-protocol clients announce themselves in the URL and say which version they last saw
      if (url.searchParams.get('ot') === '1') {
        this.otSockets.add(server)
        this.socketSid.set(server, cleanSid(url.searchParams.get('sid')))
      }
      const sinceParam = url.searchParams.get('v')
      const since = sinceParam !== null && /^\d{1,15}$/.test(sinceParam) ? Number(sinceParam) : -1

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
        server.send(this.buildInit(server, clientId, since))
      }

      // Broadcast new peer count to everyone
      this.broadcastWebsocket({
        type: 'peers',
        peers: this.sockets.size,
        peerIds: Array.from(this.clientMap.keys()),
      })
      this.persistLiveState().catch(() => {})

      let failedAuthAttempts = 0
      let lastAuthAttemptTime = 0

      server.addEventListener('message', (event) => {
        this.lastSeen.set(server, Date.now())
        try {
          const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
          const data = JSON.parse(raw)

          if (data.type === 'auth') {
            const now = Date.now()
            if (failedAuthAttempts >= 5 && now - lastAuthAttemptTime < 5000) {
              server.send(JSON.stringify({
                type: 'auth_error',
                message: 'Too many failed attempts. Please wait 5 seconds.',
              }))
              return
            }

            if (this.roomSecurity.isProtected && data.hash && data.hash === this.roomSecurity.authHash) {
              failedAuthAttempts = 0
              this.authenticatedSockets.add(server)
              server.send(this.buildInit(server, clientId, since))
            } else {
              failedAuthAttempts++
              lastAuthAttemptTime = now
              if (failedAuthAttempts >= 10) {
                server.send(JSON.stringify({
                  type: 'auth_error',
                  message: 'Connection closed due to excessive failed attempts.',
                }))
                try { server.close(4001, 'Too many failed attempts') } catch {}
                return
              }
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
            this.handleLegacyText(server, clientId, data.text)
          } else if (data.type === 'op') {
            this.handleOp(server, clientId, data)
          } else if (data.type === 'presence') {
            this.handlePresence(server, clientId, data)
          } else if (data.type === 'cursor') {
            this.handleCursor(server, clientId, data)
          } else if (data.type === 'resync') {
            if (this.otSockets.has(server)) server.send(this.resyncMessage())
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
        this.otSockets.delete(server)
        this.socketSid.delete(server)
        this.lastSeen.delete(server)
        if (this.sockets.size === 0 && this.staleTimer) {
          clearInterval(this.staleTimer)
          this.staleTimer = null
        }
        if (this.sockets.size === 0 && this.persistTimer) {
          clearTimeout(this.persistTimer)
          this.persistTimer = null
        }
        if (this.presence.delete(clientId)) {
          this.broadcastWebsocket({ type: 'cursor_off', id: clientId }, undefined, ws => this.hasPresence(ws))
        }
        this.broadcastWebsocket({
          type: 'peers',
          peers: this.sockets.size,
          peerIds: Array.from(this.clientMap.keys()),
        })
        this.persistLiveState().catch(() => {})
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
      const now = Date.now()
      const effectiveCreatedAt = this.createdAt || now
      const effectiveUpdatedAt = this.updatedAt || now
      const effectiveExpiresAt = this.expiresAt || (now + 24 * 3600 * 1000)
      return new Response(JSON.stringify({
        slug: this.slug,
        text: isProt ? '' : this.currentText,
        files: isProt ? [] : this.currentFiles,
        peers: this.sockets.size,
        isProtected: isProt,
        salt: this.roomSecurity?.salt,
        createdAt: effectiveCreatedAt,
        updatedAt: effectiveUpdatedAt,
        expiresAt: effectiveExpiresAt,
        fileCount: this.currentFiles.length,
        totalFileSize: this.currentFiles.reduce((acc, f) => acc + (f.fileSize || 0), 0),
        textLength: this.currentText.length,
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

      const now = Date.now()
      const effectiveCreatedAt = this.createdAt || now
      const effectiveUpdatedAt = this.updatedAt || now
      const effectiveExpiresAt = this.expiresAt || (now + 24 * 3600 * 1000)

      return new Response(JSON.stringify({
        slug: this.slug,
        text: this.currentText,
        files: this.currentFiles,
        peers: this.sockets.size,
        isProtected: !!this.roomSecurity?.isProtected,
        createdAt: effectiveCreatedAt,
        updatedAt: effectiveUpdatedAt,
        expiresAt: effectiveExpiresAt,
        fileCount: this.currentFiles.length,
        totalFileSize: this.currentFiles.reduce((acc, f) => acc + (f.fileSize || 0), 0),
        textLength: this.currentText.length,
      }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // ── POST /room/:slug/security — update room password protection ───────
    if (request.method === 'POST' && url.pathname.includes('/security')) {
      try {
        const body = await request.json() as RoomSecurity & { currentHash?: string }
        // If room is currently protected, verify the existing password hash before allowing modifications
        if (this.roomSecurity?.isProtected && this.roomSecurity.authHash) {
          if (!body.currentHash || body.currentHash !== this.roomSecurity.authHash) {
            return new Response(JSON.stringify({ error: 'unauthorized', message: 'Current room password required to modify protection' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            })
          }
        }

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
          this.broadcastResync()
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
    if (request.method === 'POST' && url.pathname.endsWith('/live-file')) {
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

      // Do not await: a stream write only completes once the response is being read, and the
      // response is not returned yet. Awaiting here made the stream hang with no headers.
      writer.write(this.encode('event: connected\ndata: {}\n\n')).catch(() => this.clients.delete(clientId))

      // The readable goes straight to the client. Viewers that disconnect are dropped when a write
      // to them fails (the next update or the 25s heartbeat), which also stops the heartbeat once
      // nobody is left.
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

  // ── Live Pad text sync (operational transform) ────────────────────────────

  private buildInit(ws: WebSocket, clientId: string, since: number): string {
    const base = {
      type: 'init',
      text: this.currentText,
      files: this.currentFiles,
      peers: this.sockets.size,
      peerIds: Array.from(this.clientMap.keys()),
      clientId,
    }
    if (!this.otSockets.has(ws)) return JSON.stringify(base)
    return JSON.stringify({
      ...base,
      version: this.doc.version,
      // Ops the client missed while away, when our history still reaches back that far
      replay: since >= 0 ? this.doc.replaySince(since) : null,
    })
  }

  private resyncMessage(): string {
    return JSON.stringify({ type: 'resync', text: this.currentText, version: this.doc.version })
  }

  /** The text jumped (seed): op clients resync, legacy clients get the full text. */
  private broadcastResync() {
    this.broadcastWebsocket(JSON.parse(this.resyncMessage()), undefined, ws => this.otSockets.has(ws))
    this.broadcastWebsocket({ type: 'text', text: this.currentText }, undefined, ws => !this.otSockets.has(ws))
  }

  private hasPresence(ws: WebSocket): boolean {
    const id = this.socketToClient.get(ws)
    return id !== undefined && this.presence.has(id)
  }

  /** Old clients replace the whole text; apply it as ops so op clients stay in step. */
  private handleLegacyText(sender: WebSocket, clientId: string, text: string) {
    if (this.otSockets.has(sender)) return
    const applied = this.doc.replaceAll(text)
    if (applied.length > 0) this.afterDocChange(sender, clientId, applied)
  }

  private handleOp(sender: WebSocket, clientId: string, data: { s?: unknown; e?: unknown; x?: unknown; v?: unknown; n?: unknown }) {
    if (!this.otSockets.has(sender)) return
    const n = typeof data.n === 'number' && Number.isSafeInteger(data.n) ? data.n : undefined
    const res = this.doc.submit({ s: data.s, e: data.e, x: data.x }, data.v, { sid: this.socketSid.get(sender), n })
    if (!res.ok) {
      // Out of step (stale, invalid or too large): give the client the truth to rebuild from
      sender.send(this.resyncMessage())
      return
    }
    sender.send(JSON.stringify({ type: 'ack', v: res.version }))
    this.afterDocChange(sender, clientId, [{ op: res.op, version: res.version }])
  }

  private afterDocChange(sender: WebSocket, clientId: string, applied: { op: Op; version: number }[]) {
    // Keep remembered carets glued to the text they were on
    for (const { op } of applied) {
      for (const info of this.presence.values()) {
        info.start = mapPos(info.start, op)
        info.end = mapPos(info.end, op)
      }
    }
    this.schedulePersist()
    for (const { op, version } of applied) {
      this.broadcastWebsocket(
        { type: 'op', v: version, s: op.s, e: op.e, x: op.x, from: clientId },
        sender,
        ws => this.otSockets.has(ws),
      )
    }
    // Clients without op support still get the whole text
    this.broadcastWebsocket(
      { type: 'text', text: this.currentText, senderId: clientId },
      sender,
      ws => !this.otSockets.has(ws),
    )
    this.scheduleCheck()
  }

  /**
   * Save with the 24-hour rolling TTL, but not on every keystroke: the first edit starts a short
   * timer and the write at its end covers everything typed meanwhile.
   */
  private schedulePersist() {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistLiveState().catch(() => {})
    }, PERSIST_DELAY_MS)
  }

  /** Drop connections that stopped talking (dead networks never send a close), so ghosts disappear. */
  private ensureStaleSweep() {
    if (this.staleTimer) return
    this.staleTimer = setInterval(() => {
      const cutoff = Date.now() - STALE_SOCKET_MS
      for (const ws of Array.from(this.sockets)) {
        if ((this.lastSeen.get(ws) ?? 0) < cutoff) {
          try { ws.close(1001, 'Idle connection') } catch { /* already gone */ }
        }
      }
    }, STALE_SWEEP_MS)
  }

  /** Once typing pauses, let op clients confirm they hold exactly the server's text. */
  private scheduleCheck() {
    if (this.checkTimer) clearTimeout(this.checkTimer)
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null
      this.broadcastWebsocket(
        { type: 'check', v: this.doc.version, h: hashText(this.currentText) },
        undefined,
        ws => this.otSockets.has(ws),
      )
    }, CHECK_DELAY_MS)
  }

  // ── Multi-cursor presence ─────────────────────────────────────────────────

  private cursorList(exceptId: string) {
    const list: { id: string; name: string; start: number; end: number }[] = []
    for (const [id, info] of this.presence) {
      if (id !== exceptId) list.push({ id, ...info })
    }
    return list
  }

  private handlePresence(sender: WebSocket, clientId: string, data: { on?: unknown; name?: unknown; start?: unknown; end?: unknown }) {
    if (data.on !== true) {
      if (this.presence.delete(clientId)) {
        this.broadcastWebsocket({ type: 'cursor_off', id: clientId }, sender, ws => this.hasPresence(ws))
      }
      return
    }
    const requested = cleanName(data.name)
    if (!requested) return
    const taken = new Set<string>()
    for (const [id, p] of this.presence) {
      if (id !== clientId) taken.add(p.name.toLowerCase())
    }
    const name = uniqueName(requested, taken)
    const len = this.currentText.length
    const info: PresenceInfo = { name, start: clampIndex(data.start, len), end: clampIndex(data.end, len) }
    this.presence.set(clientId, info)
    // The newcomer learns the name it was given and who is here; the others learn about the newcomer
    sender.send(JSON.stringify({ type: 'you', name }))
    sender.send(JSON.stringify({ type: 'cursors', list: this.cursorList(clientId) }))
    this.broadcastWebsocket({ type: 'cursor', id: clientId, ...info }, sender, ws => this.hasPresence(ws))
  }

  private handleCursor(sender: WebSocket, clientId: string, data: { start?: unknown; end?: unknown }) {
    const info = this.presence.get(clientId)
    if (!info) return
    const len = this.currentText.length
    info.start = clampIndex(data.start, len)
    info.end = clampIndex(data.end, len)
    this.broadcastWebsocket({ type: 'cursor', id: clientId, ...info }, sender, ws => this.hasPresence(ws))
  }

  // ── Broadcast to Live Pad WebSockets ──────────────────────────────────────
  private broadcastWebsocket(msgObj: any, excludeWs?: WebSocket, only?: (ws: WebSocket) => boolean) {
    const msg = JSON.stringify(msgObj)
    const dead: WebSocket[] = []
    for (const ws of this.sockets) {
      if (ws === excludeWs) continue
      if (only && !only(ws)) continue
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
    
    await this.writeToViewers(this.encode(`event: update\ndata: ${JSON.stringify(data)}\n\n`))
  }

  /** Send to every open viewer at once; anyone who errors or stalls is dropped. */
  private async writeToViewers(chunk: Uint8Array) {
    const entries = Array.from(this.clients)
    const results = await Promise.all(entries.map(async ([id, writer]) => {
      try {
        await Promise.race([
          writer.write(chunk),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('slow viewer')), SSE_WRITE_TIMEOUT_MS)),
        ])
        return null
      } catch {
        return id
      }
    }))
    for (const id of results) if (id) this.clients.delete(id)
  }

  // ── Heartbeat every 25s for SSE clients ───────────────────────────────────
  private ensureHeartbeat() {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(async () => {
      await this.writeToViewers(this.encode(': ping\n\n'))
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
    const now = Date.now()
    if (!this.createdAt) this.createdAt = now
    this.updatedAt = now
    this.expiresAt = now + 24 * 3600 * 1000

    try {
      await this.ctx.storage.put('live_state', {
        slug: this.slug,
        text: this.currentText,
        files: this.currentFiles,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
        expiresAt: this.expiresAt,
      })
      await this.ctx.storage.setAlarm(this.expiresAt)

      // Sync room index to KV with metadata so admin listing is instant
      if (this.slug && this.env.PASTE_KV) {
        const meta = {
          slug: this.slug,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt,
          expiresAt: this.expiresAt,
          isProtected: !!this.roomSecurity?.isProtected,
          fileCount: this.currentFiles.length,
          totalFileSize: this.currentFiles.reduce((acc, f) => acc + (f.fileSize || 0), 0),
          textLength: this.currentText.length,
          peers: this.sockets.size,
        }
        const ttlSeconds = Math.max(60, Math.ceil((this.expiresAt - now) / 1000))
        await this.env.PASTE_KV.put(`live_room:${this.slug}`, JSON.stringify(meta), {
          expirationTtl: ttlSeconds,
          metadata: meta,
        })
      }
    } catch {}
  }

  async alarm(): Promise<void> {
    try {
      if (this.slug && this.env.PASTE_KV) {
        await this.env.PASTE_KV.delete(`live_room:${this.slug}`)
        await this.env.PASTE_KV.delete(`live:reserved:${this.slug}`)
      }
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
