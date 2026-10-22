/**
 * The receiving side of Clip Beam.
 *
 * join with PIN → see file details → accept (pick where to save) → answer the sender's WebRTC
 * offer → write the incoming bytes to disk → check the SHA-256 the sender reports.
 *
 * Bytes are hashed as they arrive, batched into ~4 MB Blobs and written in order; after each write
 * the receiver acks how much is safely on disk, which is what lets the sender throttle itself.
 */
import { createSHA256, type IHasher } from 'hash-wasm'
import {
  CONNECT_TIMEOUT_MS, PING_MS, RTC_CONFIG, WRITE_BATCH,
  beamWsUrl, type ChannelMessage, type FileOffer, type SignalData,
} from './beamProtocol'
import { createDiskWriter, UnsupportedSizeError, type DiskWriter } from './diskWriter'
import { SpeedTracker } from './speedTracker'

export type ReceiverPhase =
  | 'idle'
  | 'connecting'   // opening the signalling socket
  | 'offered'      // looking at the file, deciding
  | 'peering'      // negotiating the direct connection
  | 'transferring'
  | 'verifying'    // all bytes in; flushing to disk and checking the hash
  | 'done'
  | 'cancelled'
  | 'error'

export interface ReceiverResult {
  seconds: number
  avgSpeed: number
  sha256: string
  savedAs: 'disk' | 'download' | null
}

export interface ReceiverState {
  phase: ReceiverPhase
  /** This receiver's display name, as the room knows it */
  myName: string
  /** The sender's display name */
  senderName: string
  pin: string | null
  offer: FileOffer | null
  bytes: number
  speed: number
  eta: number
  route: string | null
  error: string | null
  result: ReceiverResult | null
}

export const INITIAL_RECEIVER_STATE: ReceiverState = {
  phase: 'idle', myName: '', senderName: '', pin: null, offer: null, bytes: 0, speed: 0, eta: Infinity, route: null, error: null, result: null,
}

/** How long to wait for the sender's own messages on the open channel after its socket closes. */
const PEER_LEFT_GRACE_MS = 3000

const TERMINAL: ReceiverPhase[] = ['done', 'cancelled', 'error']

const MSG = {
  connectFailed: 'Could not open a direct connection between the two devices. If you are on different networks, one of them may be behind a strict firewall or mobile carrier NAT. Try both devices on the same Wi-Fi.',
  peerGone: 'The sender disconnected before the transfer finished.',
  serverGone: 'Lost the connection to Clip before the devices could pair. Try again.',
  corrupt: 'The received file did not match the original (SHA-256 mismatch), so it was discarded. Try sending it again.',
}

type ReceiverMessage =
  | { type: 'joined'; offer: FileOffer | null; name: string; sender: string }
  | { type: 'file_offer'; offer: FileOffer }
  | { type: 'signal'; data: SignalData }
  | { type: 'peer_left'; role: 'sender' }
  | { type: 'cancel' }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string }

export class BeamReceiver {
  private state: ReceiverState = { ...INITIAL_RECEIVER_STATE }
  private ws: WebSocket | null = null
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private pendingCandidates: RTCIceCandidateInit[] = []
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  private writer: DiskWriter | null = null
  private received = 0
  private hasher: IHasher | null = null
  private batch: Uint8Array[] = []
  private batchBytes = 0
  private writeChain: Promise<void> = Promise.resolve()
  private speed: SpeedTracker | null = null

  constructor(private readonly emit: (state: ReceiverState) => void) {}

  join(pin: string, name: string): void {
    this.update({ phase: 'connecting', pin, myName: name })
    let ws: WebSocket
    try {
      ws = new WebSocket(beamWsUrl(pin, name))
    } catch {
      this.fail('Could not reach Clip Beam.')
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.pingTimer = setInterval(() => this.sendSignal({ type: 'ping' }), PING_MS)
    }
    ws.onmessage = (event) => {
      let msg: ReceiverMessage
      try {
        msg = JSON.parse(String(event.data)) as ReceiverMessage
      } catch {
        return
      }
      this.onServerMessage(msg).catch((err: Error) => this.fail(`Connection setup failed: ${err.message}`))
    }
    ws.onclose = () => {
      this.ws = null
      if (this.isFinished()) return
      if (this.dc?.readyState === 'open') return // the socket is no longer needed once the channel is up
      this.fail(this.state.phase === 'connecting'
        ? 'Could not connect with that PIN. Check the digits, or wait a minute if you have tried many PINs.'
        : MSG.serverGone)
    }
  }

  /** Pick where to save, then tell the sender to start. Call from a click handler. */
  async accept(): Promise<void> {
    const offer = this.state.offer
    if (this.state.phase !== 'offered' || !offer) return
    try {
      this.hasher = await createSHA256()
      this.hasher.init()
      this.writer = await createDiskWriter(offer.name, offer.size, offer.type)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return // closed the save dialog
      if (err instanceof UnsupportedSizeError) {
        this.sendSignal({ type: 'file_reject' })
        this.fail(err.message)
        return
      }
      this.fail(`Could not open a file to save into: ${(err as Error).message}`)
      return
    }
    if (this.isFinished()) {
      await this.writer.abort()
      return
    }
    this.update({ phase: 'peering' })
    this.connectTimer = setTimeout(() => {
      if (this.state.phase === 'peering') this.fail(MSG.connectFailed)
    }, CONNECT_TIMEOUT_MS)
    this.sendSignal({ type: 'file_accept' })
  }

  decline(): void {
    if (this.state.phase !== 'offered') return
    this.sendSignal({ type: 'file_reject' })
    this.finish('cancelled')
  }

  cancel(): void {
    if (this.isFinished()) return
    this.sendChannel({ t: 'cancel' })
    this.sendSignal({ type: 'cancel' })
    this.finish('cancelled')
  }

  /** Tears everything down without reporting a new state (page unmount or reset). */
  dispose(): void {
    this.disposed = true
    this.cleanup()
  }

  // ── Signalling ─────────────────────────────────────────────────────────────

  private async onServerMessage(msg: ReceiverMessage): Promise<void> {
    if (this.isFinished()) return
    switch (msg.type) {
      case 'joined':
        this.update({ myName: msg.name || this.state.myName, senderName: msg.sender || '' })
        if (msg.offer) this.update({ offer: msg.offer, phase: 'offered' })
        break
      case 'file_offer':
        if (this.state.phase === 'connecting' || this.state.phase === 'offered') this.update({ offer: msg.offer, phase: 'offered' })
        break
      case 'signal':
        await this.onSignal(msg.data)
        break
      case 'peer_left':
        if (this.state.phase === 'verifying') break
        if (this.dc?.readyState === 'open') {
          // The sender may be about to say something on the channel (cancel, or the final hash); let it
          setTimeout(() => this.fail(MSG.peerGone), PEER_LEFT_GRACE_MS)
        } else {
          this.fail(MSG.peerGone)
        }
        break
      case 'cancel':
        this.fail('The sender cancelled the transfer.')
        break
      case 'error':
        this.fail(errorText(msg.code, msg.message))
        break
    }
  }

  private sendSignal(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  // ── WebRTC ─────────────────────────────────────────────────────────────────

  private createPeer(): RTCPeerConnection {
    const pc = new RTCPeerConnection(RTC_CONFIG)
    this.pc = pc
    pc.onicecandidate = (event) => {
      if (event.candidate) this.sendSignal({ type: 'signal', data: { candidate: event.candidate.toJSON() } })
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.fail(this.state.phase === 'peering' ? MSG.connectFailed : MSG.peerGone)
    }
    pc.ondatachannel = (event) => this.setupChannel(event.channel)
    return pc
  }

  private async onSignal(data: SignalData): Promise<void> {
    if (data.sdp) {
      // Only answer once we have accepted; an offer before that would have nowhere to write
      if (data.sdp.type === 'offer' && !this.pc && this.state.phase === 'peering') {
        const pc = this.createPeer()
        await pc.setRemoteDescription(data.sdp)
        const queued = this.pendingCandidates
        this.pendingCandidates = []
        for (const c of queued) await pc.addIceCandidate(c).catch(() => undefined)
        await pc.setLocalDescription(await pc.createAnswer())
        this.sendSignal({ type: 'signal', data: { sdp: pc.localDescription?.toJSON() } })
      }
    } else if (data.candidate) {
      if (this.pc?.remoteDescription) await this.pc.addIceCandidate(data.candidate).catch(() => undefined)
      else this.pendingCandidates.push(data.candidate)
    }
  }

  private setupChannel(dc: RTCDataChannel): void {
    this.dc = dc
    dc.binaryType = 'arraybuffer'
    dc.onopen = () => {
      this.clearConnectTimer()
      this.detectRoute()
    }
    dc.onclose = () => {
      if (!this.isFinished()) this.fail(MSG.peerGone)
    }
    dc.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          this.onChannelMessage(JSON.parse(event.data) as ChannelMessage)
        } catch {
          // Not for us
        }
      } else if (event.data instanceof ArrayBuffer) {
        this.onChunk(new Uint8Array(event.data))
      }
    }
  }

  private sendChannel(msg: ChannelMessage): void {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(msg))
  }

  private onChannelMessage(msg: ChannelMessage): void {
    if (this.isFinished()) return
    switch (msg.t) {
      case 'meta':
        if (this.state.phase !== 'peering') return
        if (msg.size !== this.state.offer?.size) {
          this.fail('The sender changed the file after you accepted it.')
          return
        }
        this.speed = new SpeedTracker(msg.size)
        this.speed.start()
        if (this.tickTimer) clearInterval(this.tickTimer)
        this.tickTimer = setInterval(() => this.tick(), 200)
        this.update({ phase: 'transferring' })
        break
      case 'done':
        this.finishReceiving(msg.sha256).catch((err: Error) => this.fail(`Saving failed: ${err.message}`))
        break
      case 'cancel':
        this.fail('The sender cancelled the transfer.')
        break
    }
  }

  /** "Direct, same network" vs "Direct, over the internet", from the pair ICE settled on. */
  private detectRoute(): void {
    this.pc?.getStats().then((stats) => {
      let pairId: string | undefined
      stats.forEach((s) => {
        if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId
      })
      let local: string | undefined
      stats.forEach((s) => {
        if (s.type === 'candidate-pair' && (s.id === pairId || (!pairId && s.nominated && s.state === 'succeeded'))) {
          local = stats.get(s.localCandidateId)?.candidateType
        }
      })
      const route = local === 'host' ? 'Direct, same network'
        : local === 'relay' ? 'Relayed'
        : local ? 'Direct, over the internet' : null
      if (route) this.update({ route })
    }).catch(() => undefined)
  }

  // ── Receiving ──────────────────────────────────────────────────────────────

  private onChunk(chunk: Uint8Array): void {
    if (this.state.phase !== 'transferring' || !this.writer || !this.hasher) return
    this.hasher.update(chunk)
    this.received += chunk.byteLength
    this.batch.push(chunk)
    this.batchBytes += chunk.byteLength
    if (this.batchBytes >= WRITE_BATCH) this.flushBatch()
  }

  /** Writes the batched chunks as one Blob, then tells the sender how much is safely on disk. */
  private flushBatch(): void {
    if (this.batch.length === 0 || !this.writer) return
    const writer = this.writer
    const blob = new Blob(this.batch as BlobPart[])
    const upTo = this.received
    this.batch = []
    this.batchBytes = 0
    this.writeChain = this.writeChain.then(async () => {
      if (this.isFinished()) return
      await writer.write(blob)
      this.sendChannel({ t: 'ack', bytes: upTo })
    })
    this.writeChain.catch((err: Error) => this.fail(`Could not write to disk: ${err.message}`))
  }

  private async finishReceiving(expected: string): Promise<void> {
    if (this.state.phase !== 'transferring') return
    this.update({ phase: 'verifying' })
    this.flushBatch()
    await this.writeChain
    if (this.isFinished() || !this.writer || !this.hasher) return
    const digest = this.hasher.digest('hex')
    const size = this.state.offer?.size ?? -1
    if (this.received !== size || digest !== expected) {
      this.sendChannel({ t: 'verified', ok: false })
      this.fail(MSG.corrupt)
      return
    }
    await this.writer.close()
    const savedAs = this.writer.kind
    this.writer = null
    this.sendChannel({ t: 'verified', ok: true })
    const seconds = this.speed?.elapsed() ?? 0
    const avgSpeed = this.speed?.average(this.received) ?? 0
    this.update({
      bytes: this.received, speed: 0, eta: 0,
      result: { seconds, avgSpeed, sha256: digest, savedAs },
    })
    this.finish('done')
  }

  // ── Progress and teardown ──────────────────────────────────────────────────

  private tick(): void {
    if (!this.speed || this.isFinished() || this.state.phase === 'verifying') return
    const { speed, eta } = this.speed.update(this.received)
    this.update({ bytes: this.received, speed, eta })
  }

  private fail(message: string): void {
    if (this.isFinished()) return
    this.state.error = message
    this.finish('error')
  }

  private finish(phase: ReceiverPhase): void {
    if (this.isFinished()) return
    this.update({ phase })
    this.cleanup()
  }

  private isFinished(): boolean {
    return this.disposed || TERMINAL.includes(this.state.phase)
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  private cleanup(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.pingTimer = null
    this.tickTimer = null
    this.clearConnectTimer()
    const writer = this.writer
    this.writer = null
    if (writer) writer.abort().catch(() => undefined)
    const { dc, pc } = this
    this.dc = null
    this.pc = null
    // Give a final control message a moment to leave before closing the channel
    setTimeout(() => {
      try { dc?.close() } catch { /* already closed */ }
      try { pc?.close() } catch { /* already closed */ }
    }, 500)
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      try { ws.close(1000) } catch { /* already closed */ }
    }
  }

  private update(patch: Partial<ReceiverState>): void {
    this.state = { ...this.state, ...patch }
    if (!this.disposed) this.emit(this.state)
  }
}

function errorText(code: string, fallback: string): string {
  switch (code) {
    case 'no_room': return 'No transfer is waiting on that PIN. Check the digits with the sender.'
    case 'room_full': return 'This transfer already has the maximum number of receivers (8).'
    case 'expired': return 'This Beam timed out after 10 minutes without activity. Start a new one.'
    default: return fallback || 'Something went wrong.'
  }
}
