/**
 * The receiving side of Clip Beam.
 *
 * join with PIN → see file details → accept (pick where to save) → answer the sender's WebRTC
 * offer → write the incoming bytes to disk → check the SHA-256 the sender reports.
 *
 * Bytes are batched into ~4 MB Blobs and written in order. Only after a batch is safely written is it
 * added to the running SHA-256 and acknowledged, so "bytes written", "bytes hashed" and "bytes the
 * sender may forget" are always the same number. That makes resuming exact:
 *
 *   connection lost → commit the partial file, remember (written bytes, hash state) →
 *   reconnect to the same room → tell the sender "continue from byte N" → carry on.
 *
 * Browsers hold written data in a temporary file until the file is closed, so a closed tab or a crash
 * would lose it. To keep that from costing the whole transfer, the partial file is committed to disk
 * every ~10% (a "checkpoint"), and the record of how far it got is saved with it.
 *
 * Reconnecting is automatic for short outages (and via a Reconnect button at any time). After a page
 * reload the saved record offers the same Reconnect button, as long as the browser can reopen the file.
 */
import { createSHA256, type IHasher } from 'hash-wasm'
import {
  CONNECT_TIMEOUT_MS, PING_MS, RTC_CONFIG, WRITE_BATCH,
  beamWsUrl, type ChannelMessage, type FileOffer, type SignalData,
} from './beamProtocol'
import {
  createDiskWriter, hasWritePermission, reopenWriter, ResumeUnavailableError, UnsupportedSizeError,
  type DiskWriter, type ResumeToken,
} from './diskWriter'
import { deleteRecord, saveRecord, type ResumeRecord } from './resumeStore'
import { SpeedTracker } from './speedTracker'

export type ReceiverPhase =
  | 'idle'
  | 'connecting'   // opening the signalling socket
  | 'offered'      // looking at the file, deciding
  | 'peering'      // negotiating the direct connection (or waiting for the sender to come back)
  | 'transferring'
  | 'verifying'    // all bytes in; flushing to disk and checking the hash
  | 'interrupted'  // the connection dropped; the partial file is kept and can be continued
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
  // Reconnecting
  /** Bytes safely saved while interrupted */
  saved: number
  /** How many automatic attempts have been made */
  attempt: number
  /** Seconds until the next automatic attempt, or null when none is scheduled */
  retryIn: number | null
  /** Why the connection dropped */
  reason: string | null
  /** True while the sender's own connection is down (it may come back) */
  senderAway: boolean
  /** True when the browser must ask permission again, so the user has to press Reconnect */
  needsClick: boolean
  /** False when this transfer cannot continue and must start over */
  canResume: boolean
  /** Bytes that were already saved when this attempt carried on (0 for a fresh transfer) */
  resumedFrom: number
}

export const INITIAL_RECEIVER_STATE: ReceiverState = {
  phase: 'idle', myName: '', senderName: '', pin: null, offer: null, bytes: 0, speed: 0, eta: Infinity,
  route: null, error: null, result: null,
  saved: 0, attempt: 0, retryIn: null, reason: null, senderAway: false, needsClick: false, canResume: true, resumedFrom: 0,
}

/** How long to wait for the sender's own messages on the open channel after its socket closes. */
const PEER_LEFT_GRACE_MS = 3000
/** Seconds between automatic reconnect attempts; the last value repeats. */
const RETRY_DELAYS = [2, 4, 8, 15, 30]
/** Stop trying by itself after this long (a Beam room is only held for about ten minutes). */
const GIVE_UP_MS = 11 * 60_000
/** The partial file is committed to disk after this many bytes, or a tenth of the file if that is more. */
const CHECKPOINT_MIN_BYTES = 128 * 1024 * 1024

const TERMINAL: ReceiverPhase[] = ['done', 'cancelled', 'error']

const MSG = {
  connectFailed: 'Could not open a direct connection between the two devices. If you are on different networks, one of them may be behind a strict firewall or mobile carrier NAT. Try both devices on the same Wi-Fi.',
  peerGone: 'The sender disconnected before the transfer finished.',
  serverGone: 'Lost the connection to Clip before the devices could pair. Try again.',
  corrupt: 'The received file did not match the original (SHA-256 mismatch), so it was discarded. Try sending it again.',
  lost: 'The connection was lost.',
}

type ReceiverMessage =
  | { type: 'joined'; offer: FileOffer | null; name: string; sender: string; away?: boolean }
  | { type: 'file_offer'; offer: FileOffer }
  | { type: 'signal'; data: SignalData }
  | { type: 'peer_left'; role: 'sender' }
  | { type: 'sender_away' }
  | { type: 'sender_back' }
  | { type: 'cancel' }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string }

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export class BeamReceiver {
  private state: ReceiverState = { ...INITIAL_RECEIVER_STATE }
  private ws: WebSocket | null = null
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private pendingCandidates: RTCIceCandidateInit[] = []
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private countdownTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private autoAccept = false

  private writer: DiskWriter | null = null
  /** Bumped when writing stops for good (interrupt, finish); queued writes from an older one are skipped */
  private gen = 0
  /** Bytes that have arrived (may be ahead of `written` by a batch or two) */
  private received = 0
  /** Bytes safely written to the file; hashed and acknowledged to the sender */
  private written = 0
  private hasher: IHasher | null = null
  private batch: Uint8Array[] = []
  private batchBytes = 0
  private writeChain: Promise<void> = Promise.resolve()
  private speed: SpeedTracker | null = null

  // Resume
  private rk = randomKey()
  private token: ResumeToken | null = null
  private savedHasher: Uint8Array | null = null
  /** The direct channel has opened at least once for this transfer */
  private hasConnected = false
  /** A reconnect attempt is in progress (carry on rather than start fresh) */
  private resuming = false
  private waitingForSender = false
  private interruptedAt = 0
  private interrupting = false
  private lastCheckpoint = 0

  constructor(private readonly emit: (state: ReceiverState) => void) {}

  /** `autoAccept`: the user already said yes to an invite, so go straight to choosing where to save. */
  join(pin: string, name: string, autoAccept = false): void {
    this.autoAccept = autoAccept
    this.update({ phase: 'connecting', pin, myName: name })
    this.openSocket()
  }

  /** Picks up an unfinished transfer remembered from an earlier visit. Call from a click (permission). */
  async resumeFromRecord(record: ResumeRecord): Promise<void> {
    this.rk = record.rk
    this.token = record.token
    this.savedHasher = record.hasher
    this.written = record.have
    this.received = record.have
    this.lastCheckpoint = record.have
    this.hasConnected = true
    this.interruptedAt = Date.now()
    this.update({
      phase: 'interrupted', pin: record.pin, myName: record.myName, senderName: record.senderName,
      offer: { name: record.name, size: record.size, type: record.type },
      bytes: record.have, saved: record.have, reason: 'Continuing a transfer from earlier.', canResume: true,
    })
    await this.reconnect(true)
  }

  /** Pick where to save, then tell the sender to start. Call from a click handler. */
  async accept(auto = false): Promise<void> {
    const offer = this.state.offer
    if (this.state.phase !== 'offered' || !offer) return
    try {
      this.hasher = await createSHA256()
      this.hasher.init()
      this.writer = await createDiskWriter(offer.name, offer.size, offer.type)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return // closed the save dialog
      // The browser may no longer count the invite click as a gesture; leave the Accept button for a fresh one
      if (auto && err instanceof DOMException && (err.name === 'SecurityError' || err.name === 'NotAllowedError')) return
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
    this.lastCheckpoint = 0
    this.sendAccept(0)
  }

  decline(): void {
    if (this.state.phase !== 'offered') return
    this.sendSignal({ type: 'file_reject' })
    this.finish('cancelled')
  }

  /** Cancel for good: the partial file is discarded and nothing is remembered. */
  cancel(): void {
    if (this.isFinished()) return
    this.sendChannel({ t: 'cancel' })
    this.sendSignal({ type: 'cancel' })
    this.forget()
    this.finish('cancelled')
  }

  /** Reconnect now and carry on from where it stopped. `fromClick` lets the browser ask for file permission. */
  async reconnect(fromClick: boolean): Promise<void> {
    if (this.state.phase !== 'interrupted' || !this.state.pin || this.interrupting) return
    this.clearRetry()
    if (this.token && !(await hasWritePermission(this.token, fromClick))) {
      // Only a click can bring the permission prompt up
      this.update({ needsClick: true, retryIn: null })
      return
    }
    this.update({ needsClick: false, attempt: this.state.attempt + 1, retryIn: null, reason: this.state.reason })
    this.resuming = true
    this.waitingForSender = false
    this.pendingCandidates = []
    this.openSocket()
  }

  /** Tears everything down without reporting a new state (page unmount or reset). */
  dispose(): void {
    this.disposed = true
    this.clearRetry()
    this.cleanup()
  }

  // ── Signalling ─────────────────────────────────────────────────────────────

  private openSocket(): void {
    const pin = this.state.pin
    if (!pin) return
    let ws: WebSocket
    try {
      ws = new WebSocket(beamWsUrl(pin, this.state.myName, undefined, this.resuming))
    } catch {
      this.onSocketLost()
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
      if (this.ws !== ws) return // an old socket from before a reconnect
      this.ws = null
      this.onSocketLost()
    }
  }

  /** The signalling socket closed without us asking. */
  private onSocketLost(): void {
    if (this.isFinished() || this.interrupting) return
    if (this.dc?.readyState === 'open') return // the socket is no longer needed once the channel is up
    // Once the transfer has started, losing the socket with no channel means the connection is gone: keep what we have
    if (this.writer && (this.resuming || this.hasConnected)) {
      this.interrupt(MSG.lost)
      return
    }
    if (this.resuming) {
      this.interrupt(MSG.lost) // a reconnect attempt that could not even reach Clip: stay interrupted and retry
      return
    }
    this.fail(this.state.phase === 'connecting'
      ? 'Could not connect with that PIN. Check the digits, or wait a minute if you have tried many PINs.'
      : MSG.serverGone)
  }

  private async onServerMessage(msg: ReceiverMessage): Promise<void> {
    if (this.isFinished()) return
    switch (msg.type) {
      case 'joined':
        this.update({ myName: msg.name || this.state.myName, senderName: msg.sender || this.state.senderName })
        if (this.resuming) {
          await this.onJoinedAgain(msg)
        } else if (msg.offer) {
          this.update({ offer: msg.offer, phase: 'offered' })
          if (this.autoAccept) {
            this.autoAccept = false
            await this.accept(true)
          }
        }
        break
      case 'file_offer':
        if (this.state.phase === 'connecting' || this.state.phase === 'offered') this.update({ offer: msg.offer, phase: 'offered' })
        break
      case 'signal':
        await this.onSignal(msg.data)
        break
      case 'sender_away':
        this.update({ senderAway: true })
        break
      case 'sender_back':
        this.update({ senderAway: false })
        if (this.waitingForSender) {
          this.waitingForSender = false
          await this.beginResume()
        }
        break
      case 'peer_left':
        if (this.state.phase === 'verifying') break
        if (this.dc?.readyState === 'open') {
          // The sender may be about to say something on the channel (cancel, or the final hash); let it
          setTimeout(() => this.failLostSender(), PEER_LEFT_GRACE_MS)
        } else {
          this.failLostSender()
        }
        break
      case 'cancel':
        this.forget()
        this.fail('The sender cancelled the transfer.')
        break
      case 'error':
        if (this.resuming && (msg.code === 'no_room' || msg.code === 'expired')) {
          this.forget()
          this.fail('The sender is no longer sharing this file, so the transfer cannot continue. Ask them to send it again.')
        } else {
          this.fail(errorText(msg.code, msg.message))
        }
        break
    }
  }

  /** The sender closed its room on purpose (or it expired): nothing to reconnect to. */
  private failLostSender(): void {
    if (this.isFinished() || this.interrupting || this.state.phase === 'verifying') return
    this.forget()
    this.fail(this.state.phase === 'peering' && !this.hasConnected ? MSG.connectFailed : MSG.peerGone)
  }

  private sendSignal(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  // ── Accepting and resuming ─────────────────────────────────────────────────

  private sendAccept(have: number): void {
    this.update({ phase: 'peering' })
    this.startConnectTimer()
    this.sendSignal({ type: 'file_accept', data: { rk: this.rk, have } })
  }

  /** Back in the sender's room after a drop. */
  private async onJoinedAgain(msg: Extract<ReceiverMessage, { type: 'joined' }>): Promise<void> {
    const offer = this.state.offer
    if (!msg.offer || !offer || msg.offer.name !== offer.name || msg.offer.size !== offer.size) {
      this.forget()
      this.fail('The sender is now sharing a different file, so the transfer cannot continue.')
      return
    }
    if (msg.away) {
      // The room is held but the sender's own connection is down; carry on when it is back
      this.waitingForSender = true
      this.update({ phase: 'peering', senderAway: true })
      return
    }
    await this.beginResume()
  }

  private async beginResume(): Promise<void> {
    const offer = this.state.offer
    if (!offer || this.isFinished()) return
    try {
      if (!this.hasher) {
        this.hasher = await createSHA256()
        if (this.savedHasher) this.hasher.load(this.savedHasher)
        else this.hasher.init()
      }
      if (!this.token) throw new ResumeUnavailableError('There is nothing saved to continue from.')
      this.writer = await reopenWriter(this.token, this.written, offer.name, offer.type)
    } catch (err) {
      this.forget()
      this.fail(err instanceof ResumeUnavailableError ? `${err.message} The transfer has to start over.` : `Could not reopen the partly saved file: ${(err as Error).message}`)
      return
    }
    this.received = this.written
    this.lastCheckpoint = this.written
    this.batch = []
    this.batchBytes = 0
    this.update({ resumedFrom: this.written })
    this.sendAccept(this.written)
  }

  // ── WebRTC ─────────────────────────────────────────────────────────────────

  private createPeer(): RTCPeerConnection {
    const pc = new RTCPeerConnection(RTC_CONFIG)
    this.pc = pc
    pc.onicecandidate = (event) => {
      if (event.candidate) this.sendSignal({ type: 'signal', data: { candidate: event.candidate.toJSON() } })
    }
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return
      if (pc.connectionState === 'failed') this.connectionLost(this.state.phase === 'peering' ? MSG.connectFailed : MSG.peerGone)
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
      this.hasConnected = true
      this.detectRoute()
    }
    dc.onclose = () => {
      if (this.dc !== dc) return
      this.connectionLost(MSG.peerGone)
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
          this.forget()
          this.fail('The sender changed the file after you accepted it.')
          return
        }
        if ((msg.start ?? 0) !== this.written) {
          this.forget()
          this.fail(`The sender could not continue from where this device stopped (it started at ${msg.start ?? 0} bytes, this device has ${this.written}). The transfer has to start over.`)
          return
        }
        this.speed = new SpeedTracker(msg.size)
        this.speed.start(performance.now(), this.written)
        if (this.tickTimer) clearInterval(this.tickTimer)
        this.tickTimer = setInterval(() => this.tick(), 200)
        this.resuming = false
        this.update({ phase: 'transferring', reason: null, senderAway: false })
        break
      case 'done':
        this.finishReceiving(msg.sha256).catch((err: Error) => this.fail(`Saving failed: ${err.message}`))
        break
      case 'cancel':
        this.forget()
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
    this.received += chunk.byteLength
    this.batch.push(chunk)
    this.batchBytes += chunk.byteLength
    if (this.batchBytes >= WRITE_BATCH) this.flushBatch()
  }

  /**
   * Writes the batched chunks as one Blob. Once the write has succeeded they are added to the hash and
   * acknowledged, so the hash always covers exactly the bytes that are safely in the file.
   */
  private flushBatch(): void {
    if (this.batch.length === 0 || !this.writer) return
    const gen = this.gen
    const chunks = this.batch
    const blob = new Blob(chunks as BlobPart[])
    this.batch = []
    this.batchBytes = 0
    this.writeChain = this.writeChain.then(async () => {
      if (this.gen !== gen) return // interrupted or finished meanwhile
      const writer = this.writer
      const hasher = this.hasher
      if (!writer || !hasher) return
      await writer.write(blob)
      if (this.gen !== gen) return
      for (const c of chunks) hasher.update(c)
      this.written += blob.size
      this.sendChannel({ t: 'ack', bytes: this.written })
      if (writer.kind === 'disk' && this.written - this.lastCheckpoint >= this.checkpointEvery()) await this.checkpoint()
    })
    this.writeChain.catch((err: Error) => this.writeFailed(err))
  }

  private checkpointEvery(): number {
    return Math.max(CHECKPOINT_MIN_BYTES, Math.ceil((this.state.offer?.size ?? 0) / 10))
  }

  /**
   * Commits the file as written so far (so a closed tab or crash keeps it) and saves how far it got,
   * then reopens it to carry on. Runs inside the write queue, so nothing is written meanwhile.
   */
  private async checkpoint(): Promise<void> {
    const writer = this.writer
    const hasher = this.hasher
    const offer = this.state.offer
    if (!writer || !hasher || !offer) return
    this.token = await writer.suspend()
    this.savedHasher = hasher.save()
    this.lastCheckpoint = this.written
    await this.persist()
    this.writer = await reopenWriter(this.token, this.written, offer.name, offer.type)
  }

  private writeFailed(err: Error): void {
    if (this.isFinished() || this.interrupting) return
    this.forget()
    this.fail(`Could not write to disk: ${err.message}`)
  }

  private async finishReceiving(expected: string): Promise<void> {
    if (this.state.phase !== 'transferring') return
    this.update({ phase: 'verifying' })
    this.flushBatch()
    await this.writeChain
    if (this.isFinished() || this.interrupting || !this.writer || !this.hasher) return
    const digest = this.hasher.digest('hex')
    const size = this.state.offer?.size ?? -1
    if (this.written !== size || digest !== expected) {
      this.sendChannel({ t: 'verified', ok: false })
      this.forget()
      this.fail(MSG.corrupt)
      return
    }
    await this.writer.close()
    const savedAs = this.writer.kind
    this.writer = null
    this.gen++
    this.sendChannel({ t: 'verified', ok: true })
    const seconds = this.speed?.elapsed() ?? 0
    const avgSpeed = this.speed?.average(this.written) ?? 0
    this.forget()
    this.update({
      bytes: this.written, speed: 0, eta: 0,
      result: { seconds, avgSpeed, sha256: digest, savedAs },
    })
    this.finish('done')
  }

  // ── Connection loss and resume ─────────────────────────────────────────────

  /** The direct connection is gone: keep what we have if the transfer had really started. */
  private connectionLost(message: string): void {
    if (this.isFinished() || this.interrupting) return
    if (this.state.phase === 'verifying') return // everything has arrived; only the sender's last message is lost
    if (this.writer && (this.hasConnected || this.resuming)) this.interrupt(message)
    else this.fail(message)
  }

  /**
   * Stops using the connection but keeps the partly received file: commits it to disk, remembers how
   * far it got (and the running hash) and starts trying to reconnect.
   */
  private interrupt(reason: string): void {
    if (this.isFinished() || this.interrupting) return
    this.interrupting = true
    this.resuming = false
    this.waitingForSender = false
    this.gen++
    if (!this.interruptedAt) this.interruptedAt = Date.now()
    this.dropConnection()
    this.update({ phase: 'interrupted', reason, speed: 0, eta: Infinity, saved: this.written, bytes: this.written })
    void this.settleAndSave()
  }

  private async settleAndSave(): Promise<void> {
    try {
      await this.writeChain.catch(() => undefined)
      this.batch = []
      this.batchBytes = 0
      this.received = this.written
      const writer = this.writer
      this.writer = null
      if (writer) this.token = await writer.suspend()
      if (this.hasher) this.savedHasher = this.hasher.save()
      this.hasher = null // reloaded from the saved state on reconnect
      this.lastCheckpoint = this.written
      await this.persist()
    } catch (err) {
      this.interrupting = false
      this.forget()
      this.fail(`Could not keep the partly received file: ${(err as Error).message}`)
      return
    }
    this.interrupting = false
    if (this.disposed || this.isFinished()) return
    this.update({ saved: this.written, bytes: this.written, canResume: this.token !== null && this.savedHasher !== null })
    this.scheduleRetry()
  }

  private async persist(): Promise<void> {
    const offer = this.state.offer
    if (!offer || !this.state.pin || !this.token || this.token.kind !== 'disk' || !this.savedHasher) return
    await saveRecord({
      rk: this.rk, name: offer.name, size: offer.size, type: offer.type, pin: this.state.pin,
      myName: this.state.myName, senderName: this.state.senderName, have: this.written,
      hasher: this.savedHasher, token: this.token, updatedAt: Date.now(),
    })
  }

  /** Forget the saved record (finished, cancelled, or impossible to continue). */
  private forget(): void {
    void deleteRecord(this.rk)
  }

  private scheduleRetry(): void {
    this.clearRetry()
    if (this.disposed || this.state.phase !== 'interrupted' || this.state.needsClick) return
    if (Date.now() - this.interruptedAt > GIVE_UP_MS) {
      this.update({ retryIn: null, reason: 'Could not reconnect for a while. Press Reconnect to try again, or cancel.' })
      return
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      // Wait for the network to return instead of counting down
      this.update({ retryIn: null, reason: 'You are offline. This will reconnect as soon as the network is back.' })
      window.addEventListener('online', this.onOnline, { once: true })
      return
    }
    const delay = RETRY_DELAYS[Math.min(this.state.attempt, RETRY_DELAYS.length - 1)]
    let left = delay
    this.update({ retryIn: left })
    this.countdownTimer = setInterval(() => {
      left -= 1
      if (left > 0) this.update({ retryIn: left })
    }, 1000)
    this.retryTimer = setTimeout(() => {
      this.clearRetry()
      void this.reconnect(false)
    }, delay * 1000)
  }

  private onOnline = (): void => {
    if (this.state.phase === 'interrupted') void this.reconnect(false)
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.countdownTimer) clearInterval(this.countdownTimer)
    this.retryTimer = null
    this.countdownTimer = null
    window.removeEventListener('online', this.onOnline)
  }

  // ── Progress and teardown ──────────────────────────────────────────────────

  private tick(): void {
    if (!this.speed || this.isFinished() || this.state.phase !== 'transferring') return
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
    this.clearRetry()
    this.update({ phase })
    this.cleanup()
  }

  private isFinished(): boolean {
    return this.disposed || TERMINAL.includes(this.state.phase)
  }

  private startConnectTimer(): void {
    this.clearConnectTimer()
    this.connectTimer = setTimeout(() => {
      if (this.state.phase !== 'peering' || this.waitingForSender) return
      if (this.hasConnected || this.resuming) this.interrupt(MSG.connectFailed)
      else this.fail(MSG.connectFailed)
    }, CONNECT_TIMEOUT_MS)
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  /** Closes the network side only; the file side is handled by the caller. */
  private dropConnection(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.pingTimer = null
    this.tickTimer = null
    this.clearConnectTimer()
    const { dc, pc, ws } = this
    this.dc = null
    this.pc = null
    this.ws = null
    this.pendingCandidates = []
    if (dc) dc.onclose = null
    if (pc) pc.onconnectionstatechange = null
    setTimeout(() => {
      try { dc?.close() } catch { /* already closed */ }
      try { pc?.close() } catch { /* already closed */ }
    }, 500)
    if (ws) {
      ws.onclose = null
      try { ws.close(1000) } catch { /* already closed */ }
    }
  }

  private cleanup(): void {
    this.gen++
    this.dropConnection()
    const writer = this.writer
    this.writer = null
    if (writer) writer.abort().catch(() => undefined)
    this.token = null
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
