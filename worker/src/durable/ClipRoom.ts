/**
 * ClipRoom — Cloudflare Durable Object
 *
 * One instance per slug. Holds all open SSE connections in memory.
 * The worker notifies it after every KV write; it fans out to all clients.
 */
export class ClipRoom {
  private clients: Map<string, WritableStreamDefaultWriter<Uint8Array>> = new Map()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private encoder = new TextEncoder()

  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // ── POST /room/:slug/notify — broadcast update to all connected clients ──
    if (request.method === 'POST' && url.pathname.includes('/notify')) {
      const slug = url.pathname.split('/')[2] ?? ''
      await this.broadcast(slug)
      return new Response('ok', { status: 200 })
    }

    // ── GET /room/:slug/events — open SSE stream ────────────────────────────
    if (request.method === 'GET' && url.pathname.includes('/events')) {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
      const writer = writable.getWriter()
      const clientId = crypto.randomUUID()

      this.clients.set(clientId, writer)
      this.ensureHeartbeat()

      // Send initial "connected" event so the client knows the stream is live
      try {
        await writer.write(this.encode('event: connected\ndata: {}\n\n'))
      } catch {
        this.clients.delete(clientId)
      }

      // Clean up when stream closes (client disconnects)
      const cleanup = () => {
        this.clients.delete(clientId)
        if (this.clients.size === 0) {
          this.stopHeartbeat()
        }
      }

      readable.pipeTo(new WritableStream({ close: cleanup, abort: cleanup })).catch(cleanup)

      return new Response(readable, {
        headers: {
          'Content-Type':  'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection':    'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      })
    }

    return new Response('Not found', { status: 404 })
  }

  // ── Broadcast update event to all clients ─────────────────────────────────
  private async broadcast(slug: string) {
    const msg = this.encode(`event: update\ndata: ${JSON.stringify({ slug })}\n\n`)
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

  // ── Heartbeat every 25s to keep connections alive (proxies/Cloudflare timeout) ──
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
