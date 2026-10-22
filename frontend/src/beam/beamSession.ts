/**
 * One Clip Beam transfer, from either side.
 *
 * Sender:   open room → share PIN → receiver joins and accepts → WebRTC offer → stream file
 * Receiver: join with PIN → see file details → accept (pick where to save) → answer → write to disk
 *
 * The signalling WebSocket only carries the offer, SDP and ICE. File bytes go over an ordered
 * RTCDataChannel with two kinds of backpressure: the channel's own send buffer, and a window of
 * bytes the receiver has not yet confirmed writing to disk. Both ends hash the bytes with SHA-256
 * as they pass, and the receiver only keeps the file if the hashes match.
 */
import { createSHA256, type IHasher } from 'hash-wasm'
import {
  BUFFER_HIGH, BUFFER_LOW, CONNECT_TIMEOUT_MS, FLOW_WINDOW, MAX_CHUNK, PING_MS, RTC_CONFIG, WRITE_BATCH,
  beamWsUrl, type ChannelMessage, type FileOffer, type ServerMessage, type SignalData,
} from './beamProtocol'
import { createDiskWriter, UnsupportedSizeError, type DiskWriter } from './diskWriter'
import { SpeedTracker } from './speedTracker'

export type BeamRole = 'sender' | 'receiver'

export type BeamPhase =
  | 'idle'
  | 'connecting'     // opening the signalling socket
  | 'waiting'        // sender: room open, waiting for a receiver
  | 'joined'         // sender: receiver is looking at the offer
  | 'offered'        // receiver: deciding whether to accept
  | 'peering'        // both: negotiating the direct connection
  | 'transferring'
  | 'verifying'      // last bytes sent; receiver is flushing and checking the hash
  | 'done'
  | 'rejected'       // sender: receiver declined
  | 'cancelled'
  | 'error'

export interface BeamResult {
  seconds: number
  avgSpeed: number
  sha256: string
  savedAs: 'disk' | 'download' | null
}

export interface BeamState {
  role: BeamRole | null
  phase: BeamPhase
  pin: string | null
  offer: FileOffer | null
  bytes: number
  speed: number
  eta: number
  route: string | null
  error: string | null
  result: BeamResult | null
}

export const INITIAL_BEAM_STATE: BeamState = {
  role: null, phase: 'idle', pin: null, offer: null, bytes: 0, speed: 0, eta: Infinity,
  route: null, error: null, result: null,
}

const TERMINAL: BeamPhase[] = ['done', 'rejected', 'cancelled', 'error']

const MSG = {
  connectFailed: 'Could not open a direct connection between the two devices. If you are on different networks, one of them may be behind a strict firewall or mobile carrier NAT. Try both devices on the same Wi-Fi.',
  peerGone: 'The other device disconnected before the transfer finished.',
  serverGone: 'Lost the connection to Clip before the devices could pair. Try again.',
  corrupt: 'The received file did not match the original (SHA-256 mismatch), so it was discarded. Try sending it again.',
}

export class BeamSession {
  private state: BeamState = { ...INITIAL_BEAM_STATE }
  private ws: WebSocket | null = null
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private pendingCandidates: RTCIceCandidateInit[] = []
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  // Sender
  private file: File | null = null
  private sent = 0
  private acked = 0
  private wake: (() => void) | null = null

  // Receiver
  private writer: DiskWriter | null = null
  private received = 0
  private hasher: IHasher | null = null
  private batch: Uint8Array[] = []
  private batchBytes = 0
  private writeChain: Promise<void> = Promise.resolve()

  private speed: SpeedTracker | null = null

  constructor(private readonly emit: (state: BeamState) => void) {}

  // ── Public actions ─────────────────────────────────────────────────────────

  send(file: File): void {
    this.file = file
    this.update({
      role: 'sender', phase: 'connecting',
      offer: { name: file.name || 'file', size: file.size, type: file.type },
    })
    this.openSocket()
  }

  join(pin: string): void {
    this.update({ role: 'receiver', phase: 'connecting', pin })
    this.openSocket(pin)
  }

  /** Receiver: pick where to save, then tell the sender to start. Call from a click handler. */
  async accept(): Promise<void> {
    const offer = this.state.offer
    if (this.state.role !== 'receiver' || this.state.phase !== 'offered' || !offer) return
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
    this.startConnectTimer()
    this.sendSignal({ type: 'file_accept' })
  }

  decline(): void {
    if (this.state.role !== 'receiver' || this.state.phase !== 'offered') return
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

  private openSocket(pin?: string): void {
    let ws: WebSocket
    try {
      ws = new WebSocket(beamWsUrl(pin))
    } catch {
      this.fail('Could not reach Clip Beam.')
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.pingTimer = setInterval(() => this.sendSignal({ type: 'ping' }), PING_MS)
    }
    ws.onmessage = (event) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage
      } catch {
        return
      }
      this.onServerMessage(msg).catch((err: Error) => this.fail(`Connection setup failed: ${err.message}`))
    }
    ws.onclose = () => {
      this.ws = null
      if (this.isFinished()) return
      // Once the data channel is up the socket is no longer needed
      if (this.dc?.readyState === 'open') return
      if (this.state.phase === 'connecting') {
        this.fail(pin
          ? 'Could not connect with that PIN. Check the digits, or wait a minute if you have tried many PINs.'
          : 'Could not reach Clip Beam. Check your connection and try again.')
      } else {
        this.fail(MSG.serverGone)
      }
    }
  }

  private async onServerMessage(msg: ServerMessage): Promise<void> {
    if (this.isFinished()) return
    switch (msg.type) {
      case 'room_created':
        this.update({ pin: msg.pin, phase: 'waiting' })
        this.sendSignal({ type: 'file_offer', offer: this.state.offer })
        break
      case 'peer_joined':
        this.update({ phase: 'joined' })
        break
      case 'joined':
        if (msg.offer) this.update({ offer: msg.offer, phase: 'offered' })
        break
      case 'file_offer':
        this.update({ offer: msg.offer, phase: 'offered' })
        break
      case 'file_accept':
        if (this.state.role === 'sender' && this.state.phase === 'joined') await this.startSenderPeer()
        break
      case 'file_reject':
        if (this.state.role === 'sender') this.finish('rejected')
        break
      case 'signal':
        await this.onSignal(msg.data)
        break
      case 'peer_left':
        // A receiver who leaves before accepting just frees the PIN for someone else
        if (this.state.role === 'sender' && this.state.phase === 'joined') this.update({ phase: 'waiting' })
        else if (this.state.phase !== 'waiting' && this.state.phase !== 'verifying') this.fail(MSG.peerGone)
        break
      case 'cancel':
        this.fail('The other device cancelled the transfer.')
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
    return pc
  }

  private async startSenderPeer(): Promise<void> {
    this.update({ phase: 'peering' })
    this.startConnectTimer()
    const pc = this.createPeer()
    const dc = pc.createDataChannel('beam', { ordered: true })
    this.setupChannel(dc)
    await pc.setLocalDescription(await pc.createOffer())
    this.sendSignal({ type: 'signal', data: { sdp: pc.localDescription?.toJSON() } })
  }

  private async onSignal(data: SignalData): Promise<void> {
    if (data.sdp) {
      if (data.sdp.type === 'offer' && this.state.role === 'receiver' && !this.pc) {
        const pc = this.createPeer()
        pc.ondatachannel = (event) => this.setupChannel(event.channel)
        await pc.setRemoteDescription(data.sdp)
        await this.flushCandidates()
        await pc.setLocalDescription(await pc.createAnswer())
        this.sendSignal({ type: 'signal', data: { sdp: pc.localDescription?.toJSON() } })
      } else if (data.sdp.type === 'answer' && this.pc?.signalingState === 'have-local-offer') {
        await this.pc.setRemoteDescription(data.sdp)
        await this.flushCandidates()
      }
    } else if (data.candidate) {
      if (this.pc?.remoteDescription) await this.pc.addIceCandidate(data.candidate).catch(() => undefined)
      else this.pendingCandidates.push(data.candidate)
    }
  }

  private async flushCandidates(): Promise<void> {
    const queued = this.pendingCandidates
    this.pendingCandidates = []
    for (const c of queued) await this.pc?.addIceCandidate(c).catch(() => undefined)
  }

  private startConnectTimer(): void {
    this.clearConnectTimer()
    this.connectTimer = setTimeout(() => {
      if (this.state.phase === 'peering') this.fail(MSG.connectFailed)
    }, CONNECT_TIMEOUT_MS)
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  private setupChannel(dc: RTCDataChannel): void {
    this.dc = dc
    dc.binaryType = 'arraybuffer'
    dc.onopen = () => {
      this.clearConnectTimer()
      this.detectRoute()
      if (this.state.role === 'sender') this.runSender().catch((err: Error) => this.fail(`Sending failed: ${err.message}`))
    }
    dc.onclose = () => {
      if (!this.isFinished()) this.fail(MSG.peerGone)
    }
    dc.onbufferedamountlow = () => this.wakeSender()
    dc.onmessage = (event) => {
      if (typeof event.data === 'string') {
        let msg: ChannelMessage
        try {
          msg = JSON.parse(event.data) as ChannelMessage
        } catch {
          return
        }
        this.onChannelMessage(msg)
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
        if (this.state.role !== 'receiver') return
        if (msg.size !== this.state.offer?.size) {
          this.fail('The sender changed the file after you accepted it.')
          return
        }
        this.startProgress(msg.size)
        this.update({ phase: 'transferring' })
        break
      case 'ack':
        this.acked = Math.max(this.acked, msg.bytes)
        this.wakeSender()
        break
      case 'done':
        if (this.state.role === 'receiver') this.finishReceiving(msg.sha256).catch((err: Error) => this.fail(`Saving failed: ${err.message}`))
        break
      case 'verified':
        if (this.state.role !== 'sender') return
        if (msg.ok) this.complete(this.state.offer?.size ?? 0)
        else this.fail(MSG.corrupt)
        break
      case 'cancel':
        this.fail('The other device cancelled the transfer.')
        break
    }
  }

  /** Reads the candidate pair the browsers settled on, to show "same network" vs "internet". */
  private detectRoute(): void {
    const pc = this.pc
    if (!pc) return
    pc.getStats().then((stats) => {
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

  // ── Sending ────────────────────────────────────────────────────────────────

  private async runSender(): Promise<void> {
    const file = this.file
    const dc = this.dc
    if (!file || !dc) return
    const maxMessage = this.pc?.sctp?.maxMessageSize || 64 * 1024
    const chunkSize = Math.min(MAX_CHUNK, maxMessage)
    dc.bufferedAmountLowThreshold = BUFFER_LOW

    this.sendChannel({ t: 'meta', name: file.name, size: file.size, type: file.type })
    this.startProgress(file.size)
    this.update({ phase: 'transferring' })

    const hasher = await createSHA256()
    hasher.init()
    const reader = file.stream().getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hasher.update(value)
        for (let off = 0; off < value.byteLength; off += chunkSize) {
          await this.waitForRoom(dc)
          const piece = value.subarray(off, Math.min(off + chunkSize, value.byteLength))
          dc.send(piece)
          this.sent += piece.byteLength
        }
      }
    } finally {
      reader.releaseLock()
    }
    const digest = hasher.digest('hex')
    this.state.result = { seconds: 0, avgSpeed: 0, sha256: digest, savedAs: null }
    this.sendChannel({ t: 'done', sha256: digest })
    this.update({ phase: 'verifying' })
  }

  private async waitForRoom(dc: RTCDataChannel): Promise<void> {
    while (dc.bufferedAmount > BUFFER_HIGH || this.sent - this.acked > FLOW_WINDOW) {
      if (this.isFinished()) throw new Error('stopped')
      if (dc.readyState !== 'open') throw new Error('connection closed')
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
    if (this.isFinished()) throw new Error('stopped')
  }

  private wakeSender(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }

  // ── Receiving ──────────────────────────────────────────────────────────────

  private onChunk(chunk: Uint8Array): void {
    if (this.state.role !== 'receiver' || this.state.phase !== 'transferring' || !this.writer || !this.hasher) return
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
    this.state.result = { seconds: 0, avgSpeed: 0, sha256: digest, savedAs }
    this.complete(this.received)
  }

  // ── Progress and teardown ──────────────────────────────────────────────────

  private startProgress(total: number): void {
    this.speed = new SpeedTracker(total)
    this.speed.start()
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = setInterval(() => this.tick(), 200)
  }

  private currentBytes(): number {
    if (this.state.role === 'receiver') return this.received
    return Math.max(this.acked, this.sent - (this.dc?.bufferedAmount ?? 0))
  }

  private tick(): void {
    if (!this.speed || this.isFinished()) return
    const bytes = this.currentBytes()
    const { speed, eta } = this.speed.update(bytes)
    this.update({ bytes, speed, eta })
  }

  private complete(bytes: number): void {
    const seconds = this.speed?.elapsed() ?? 0
    const avgSpeed = this.speed?.average(bytes) ?? 0
    const prev = this.state.result
    this.update({
      bytes,
      result: { seconds, avgSpeed, sha256: prev?.sha256 ?? '', savedAs: prev?.savedAs ?? null },
    })
    this.finish('done')
  }

  private fail(message: string): void {
    if (this.isFinished()) return
    this.state.error = message
    this.finish('error')
  }

  private finish(phase: BeamPhase): void {
    if (this.isFinished()) return
    this.update({ phase })
    this.cleanup()
  }

  private isFinished(): boolean {
    return this.disposed || TERMINAL.includes(this.state.phase)
  }

  private cleanup(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.pingTimer = null
    this.tickTimer = null
    this.clearConnectTimer()
    this.wakeSender()
    const writer = this.writer
    this.writer = null
    if (writer) writer.abort().catch(() => undefined)
    const dc = this.dc
    const pc = this.pc
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

  private update(patch: Partial<BeamState>): void {
    this.state = { ...this.state, ...patch }
    if (!this.disposed) this.emit(this.state)
  }
}

function errorText(code: string, fallback: string): string {
  switch (code) {
    case 'no_room': return 'No transfer is waiting on that PIN. Check the digits with the sender.'
    case 'room_full': return 'Someone else is already receiving this file.'
    case 'expired': return 'This Beam timed out after 10 minutes without activity. Start a new one.'
    default: return fallback || 'Something went wrong.'
  }
}
