/**
 * The receiving side of Clip Beam.
 *
 * A receiver joins a sender's room (by PIN, or by accepting a request from the radar) and the two
 * browsers open one direct connection that stays up. The sender then offers files one at a time and the
 * receiver decides about each one: Accept (choose where to save), Decline, or "Accept all" (choose a
 * folder once; everything after saves there). Either side can end the connection at any point.
 *
 * Per file, bytes are batched into ~4 MB Blobs and written in order. Only after a batch is safely written
 * is it added to the running SHA-256 and acknowledged, so "bytes written", "bytes hashed" and "bytes the
 * sender may forget" are always the same number. That makes resuming exact:
 *
 *   connection lost → commit the partial file, remember (written bytes, hash state) →
 *   reconnect to the same room → the sender re-offers the file → "continue from byte N".
 *
 * Browsers hold written data in a temporary file until the file is closed, so a closed tab or a crash
 * would lose it. To keep that from costing the whole file, the partial file is committed to disk every
 * ~10% (a "checkpoint") and the record of how far it got is saved with it.
 */
import { createSHA256, type IHasher } from 'hash-wasm'
import { KeepAwake } from './keepAwake'
import {
  CONNECT_TIMEOUT_MS, HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, PING_MS, WRITE_BATCH, getRtcConfig,
  beamWsUrl, type ChannelMessage, type SignalData,
} from './beamProtocol'
import {
  canPickFolder, createDiskWriter, createFolderWriter, createMemoryWriter, hasWritePermission, pickFolder,
  reopenWriter, ResumeUnavailableError, UnsupportedSizeError,
  type DiskWriter, type ResumeToken,
} from './diskWriter'
import { safeFileName } from './beamFormat'
import { deleteRecord, saveRecord, type ResumeRecord } from './resumeStore'
import { SpeedTracker } from './speedTracker'

export type SessionPhase =
  | 'idle'
  | 'connecting'   // joined the room, opening the direct connection
  | 'connected'    // connected; files arrive as offers
  | 'interrupted'  // the connection dropped; reconnecting (any partial file is kept)
  | 'ended'        // the connection was ended on purpose, by either side
  | 'error'        // could not connect, or the room is gone

export type IncomingPhase = 'offered' | 'starting' | 'transferring' | 'verifying'

/** The file currently on offer or being received. */
export interface Incoming {
  f: number
  name: string
  size: number
  type: string
  phase: IncomingPhase
  bytes: number
  speed: number
  eta: number
  /** Bytes the file already had when this attempt carried on (0 for a fresh file) */
  resumedFrom: number
}

export interface ReceivedFile {
  f: number
  name: string
  size: number
  status: 'done' | 'declined' | 'cancelled' | 'failed'
  sha256: string
  /** Why it did not finish */
  error: string | null
  /** The name it was saved under (differs from `name` if that was taken in the folder) */
  savedName: string
  savedAs: 'disk' | 'folder' | 'download' | null
  seconds: number
  avgSpeed: number
}

export interface ReceiverState {
  phase: SessionPhase
  /** This receiver's display name, as the room knows it */
  myName: string
  /** The sender's display name */
  senderName: string
  pin: string | null
  route: string | null
  error: string | null
  /** Who ended the connection, once it has ended */
  endedBy: 'you' | 'sender' | null
  /** True while the sender's own connection is down (it may come back) */
  senderAway: boolean
  incoming: Incoming | null
  history: ReceivedFile[]
  /** Every offer is accepted automatically */
  acceptAll: boolean
  /** The folder accepted files are saved into (Chrome and Edge); null means the browser's downloads */
  folderName: string | null
  // Reconnecting
  /** A partly received file kept while interrupted */
  partial: { name: string; size: number; saved: number } | null
  /** How many reconnect attempts have been made */
  attempt: number
  /** Seconds until the next automatic attempt, or null when none is scheduled */
  retryIn: number | null
  /** Why the connection dropped */
  reason: string | null
  /** True when the browser must ask permission again, so the user has to press Reconnect */
  needsClick: boolean
}

export const INITIAL_RECEIVER_STATE: ReceiverState = {
  phase: 'idle', myName: '', senderName: '', pin: null, route: null, error: null, endedBy: null, senderAway: false,
  incoming: null, history: [], acceptAll: false, folderName: null,
  partial: null, attempt: 0, retryIn: null, reason: null, needsClick: false,
}

/** How long to wait for the sender's own messages on the open channel after its socket closes. */
const PEER_LEFT_GRACE_MS = 3000
/** Seconds between automatic reconnect attempts; the last value repeats. */
const RETRY_DELAYS = [2, 4, 8, 15, 30]
/** Stop trying by itself after this long (a Beam room is only held for about ten minutes). */
const GIVE_UP_MS = 11 * 60_000
/** A partial file is committed to disk after this many bytes, or a tenth of the file if that is more. */
const CHECKPOINT_MIN_BYTES = 128 * 1024 * 1024
const MAX_HISTORY = 200

const MSG = {
  connectFailed: 'Could not open a direct connection between the two devices. If you are on different networks, one of them may be behind a strict firewall or mobile carrier NAT. Try both devices on the same Wi-Fi.',
  senderGone: 'The sender is no longer sharing.',
  serverGone: 'Lost the connection to Clip before the devices could pair. Try again.',
  corrupt: 'The received file did not match the original (SHA-256 mismatch), so it was discarded. Ask the sender to send it again.',
  lost: 'The connection to the sender was lost.',
}

type ReceiverMessage =
  | { type: 'joined'; offer: unknown; name: string; sender: string; away?: boolean }
  | { type: 'signal'; data: SignalData }
  | { type: 'peer_left'; role: 'sender' }
  | { type: 'sender_away' }
  | { type: 'sender_back' }
  | { type: 'cancel' }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string }

type OfferMessage = Extract<ChannelMessage, { t: 'offer' }>

/** One accepted file: its writer, running hash and progress. Kept (without a writer) while interrupted. */
interface Xfer {
  f: number
  name: string
  size: number
  type: string
  /** Random id of this partly received file (its saved record's key) */
  rk: string
  writer: DiskWriter | null
  hasher: IHasher | null
  /** Bytes that have arrived (may be ahead of `written` by a batch or two) */
  received: number
  /** Bytes safely written; hashed and acknowledged */
  written: number
  batch: Uint8Array[]
  batchBytes: number
  chain: Promise<void>
  /** Bumped when writing stops for good; queued writes from an older one are skipped */
  gen: number
  lastCheckpoint: number
  token: ResumeToken | null
  savedHasher: Uint8Array | null
  speed: SpeedTracker | null
  savedName: string
  saveKind: 'disk' | 'folder' | 'download'
  /** True once the bytes started flowing */
  started: boolean
}

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
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private lastHeard = 0
  private readonly awake = new KeepAwake()

  /** This receiver's identity for the whole visit, so the sender recognises it after a reconnect */
  private sk = randomKey()
  /** The file being received, or kept as a partial while interrupted */
  private x: Xfer | null = null
  /** An offer waiting for the user's decision */
  private offerPending: OfferMessage | null = null
  private accepting = false
  private dir: FileSystemDirectoryHandle | null = null

  private hasConnected = false
  /** A reconnect attempt is in progress */
  private resuming = false
  private waitingForSender = false
  private interruptedAt = 0
  private interrupting = false
  private ended = false

  constructor(private readonly emit: (state: ReceiverState) => void) {}

  // ── Public actions ─────────────────────────────────────────────────────────

  join(pin: string, name: string): void {
    this.update({ phase: 'connecting', pin, myName: name })
    this.startConnectTimer()
    this.openSocket()
  }

  /** Picks up an unfinished download from an earlier visit. Call from a click (permission). */
  async resumeFromRecord(record: ResumeRecord): Promise<void> {
    this.sk = record.sk || this.sk
    this.x = {
      f: -1, name: record.name, size: record.size, type: record.type, rk: record.rk,
      writer: null, hasher: null, received: record.have, written: record.have, batch: [], batchBytes: 0,
      chain: Promise.resolve(), gen: 0, lastCheckpoint: record.have, token: record.token, savedHasher: record.hasher,
      speed: null, savedName: record.name, saveKind: 'disk', started: true,
    }
    this.hasConnected = true
    this.interruptedAt = Date.now()
    this.update({
      phase: 'interrupted', pin: record.pin, myName: record.myName, senderName: record.senderName,
      partial: { name: record.name, size: record.size, saved: record.have },
      reason: 'Continuing a transfer from earlier.',
    })
    await this.reconnect(true)
  }

  /** Accept the file on offer and choose where to save it. Call from a click. */
  async acceptOffer(): Promise<void> {
    const offer = this.offerPending
    if (!offer || this.x || this.accepting) return
    this.accepting = true
    try {
      await this.acceptOfferNow(offer)
    } finally {
      this.accepting = false
    }
  }

  private async acceptOfferNow(offer: OfferMessage): Promise<void> {
    let writer: DiskWriter
    let kind: Xfer['saveKind'] = 'disk'
    let savedName = offer.name
    try {
      if (this.state.acceptAll) {
        const auto = await this.autoWriter(offer)
        writer = auto.writer
        kind = auto.kind
        savedName = auto.savedName
      } else {
        writer = await createDiskWriter(offer.name, offer.size, offer.type)
        kind = writer.kind === 'download' ? 'download' : 'disk'
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return // closed the save dialog: still on offer
      this.rejectOffer(offer, err instanceof UnsupportedSizeError ? err.message : `Could not open a file to save into: ${(err as Error).message}`, 'failed')
      return
    }
    if (this.offerPending !== offer || this.ended) {
      await writer.abort()
      return
    }
    await this.beginXfer(offer, writer, kind, savedName)
  }

  /** Decline the file on offer; the connection stays open. */
  declineOffer(): void {
    const offer = this.offerPending
    if (!offer) return
    this.offerPending = null
    this.sendChannel({ t: 'reject', f: offer.f, reason: 'declined' })
    this.addHistory({ f: offer.f, name: offer.name, size: offer.size, status: 'declined' })
    this.syncIncoming()
  }

  /**
   * Turn "accept all" on or off. Turning it on in Chrome or Edge asks for a folder once (call from a click);
   * elsewhere files simply download automatically.
   */
  async setAcceptAll(on: boolean): Promise<void> {
    if (!on) {
      this.dir = null
      this.update({ acceptAll: false, folderName: null })
      return
    }
    if (canPickFolder()) {
      try {
        this.dir = await pickFolder()
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return // closed the dialog: stays off
        // Could not use a folder here: fall back to automatic downloads rather than refusing
        this.dir = null
      }
    }
    this.update({ acceptAll: true, folderName: this.dir?.name ?? null })
    const offer = this.offerPending
    if (offer && !this.x) void this.acceptOffer()
  }

  /** Stop the file in progress; the connection stays open. */
  cancelFile(): void {
    const x = this.x
    if (x && !x.writer && x.f < 0) return
    if (x) {
      this.sendChannel({ t: 'cancel_file', f: x.f })
      this.abandonXfer(x, 'cancelled', 'You cancelled this file.')
    } else if (this.offerPending) {
      this.declineOffer()
    }
  }

  /** End the connection. Anything half-received is discarded. */
  disconnect(): void {
    if (this.ended) return
    this.sendChannel({ t: 'bye' })
    // Whatever was half-received (including a part saved for a later reconnect) is given up on
    this.discardAll('You ended the connection.')
    this.endSession('you')
  }

  /** Reconnect now and carry on. `fromClick` lets the browser ask for file permission. */
  async reconnect(fromClick: boolean): Promise<void> {
    if (this.state.phase !== 'interrupted' || !this.state.pin || this.interrupting || this.ended) return
    this.clearRetry()
    const token = this.x?.token
    if (token && !(await hasWritePermission(token, fromClick))) {
      this.update({ needsClick: true, retryIn: null })
      return
    }
    this.update({ needsClick: false, attempt: this.state.attempt + 1, retryIn: null })
    this.resuming = true
    this.waitingForSender = false
    this.pendingCandidates = []
    this.startConnectTimer()
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
      if (this.pingTimer) clearInterval(this.pingTimer)
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
    if (this.hasConnected || this.resuming) {
      this.interrupt(MSG.lost)
      return
    }
    this.fail(MSG.serverGone)
  }

  private async onServerMessage(msg: ReceiverMessage): Promise<void> {
    if (this.isFinished()) return
    switch (msg.type) {
      case 'joined':
        this.update({ myName: msg.name || this.state.myName, senderName: msg.sender || this.state.senderName })
        if (msg.away) {
          // Back in a held room while the sender's own connection is down; it will offer when it is back
          this.waitingForSender = true
          this.update({ senderAway: true })
        }
        break
      case 'signal':
        await this.onSignal(msg.data)
        break
      case 'sender_away':
        this.update({ senderAway: true })
        break
      case 'sender_back':
        this.waitingForSender = false
        this.update({ senderAway: false })
        break
      case 'peer_left':
        // The sender closed its room (it sends "bye" first on a deliberate stop; this covers the rest)
        if (this.dc?.readyState === 'open') setTimeout(() => this.failLostSender(), PEER_LEFT_GRACE_MS)
        else this.failLostSender()
        break
      case 'cancel':
        this.discardAll('The sender ended the connection.')
        this.endSession('sender')
        break
      case 'error':
        if (msg.code === 'no_room' || msg.code === 'expired') {
          if (this.hasConnected) this.failLostSender('The sender is no longer sharing, so the connection cannot continue.')
          else this.fail(errorText(msg.code, msg.message))
        } else {
          this.fail(errorText(msg.code, msg.message))
        }
        break
    }
  }

  /** The sender's room is gone: nothing to reconnect to. */
  private failLostSender(message = MSG.senderGone): void {
    if (this.isFinished() || this.interrupting) return
    if (this.state.phase === 'connecting' && !this.hasConnected) {
      this.fail(MSG.connectFailed)
      return
    }
    this.discardAll('The sender stopped sharing.')
    this.endSession('sender', message)
  }

  private sendSignal(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  // ── WebRTC ─────────────────────────────────────────────────────────────────

  private async newConnection(): Promise<RTCPeerConnection> {
    // A new offer means the sender is (re)starting the connection: drop any stale one first
    this.closePeer()
    const pc = new RTCPeerConnection(await getRtcConfig())
    this.pc = pc
    pc.onicecandidate = (event) => {
      if (event.candidate) this.sendSignal({ type: 'signal', data: { candidate: event.candidate.toJSON() } })
    }
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return
      if (pc.connectionState === 'failed') this.connectionLost(this.state.phase === 'connecting' ? MSG.connectFailed : MSG.lost)
    }
    pc.ondatachannel = (event) => this.setupChannel(event.channel)
    return pc
  }

  private async onSignal(data: SignalData): Promise<void> {
    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        // An ICE restart repairs the path of the connection we already have; anything else starts a new one
        const pc = data.restart && this.pc && this.dc ? this.pc : await this.newConnection()
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
      if (this.dc !== dc) return
      this.clearConnectTimer()
      this.hasConnected = true
      this.resuming = false
      this.interrupting = false
      this.clearRetry()
      this.update({ phase: 'connected', reason: null, senderAway: false, attempt: 0, retryIn: null, needsClick: false })
      this.sendChannel({ t: 'hello', sk: this.sk })
      this.detectRoute()
      this.startHeartbeat()
      this.awake.start()
    }
    dc.onclose = () => {
      if (this.dc !== dc) return
      this.connectionLost(MSG.lost)
    }
    dc.onmessage = (event) => {
      if (this.dc !== dc) return
      this.lastHeard = Date.now()
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
    if (this.dc?.readyState === 'open') {
      try {
        this.dc.send(JSON.stringify(msg))
      } catch {
        // The channel closed under us; its close handler deals with it
      }
    }
  }

  private onChannelMessage(msg: ChannelMessage): void {
    if (this.isFinished()) return
    switch (msg.t) {
      case 'ping':
        this.sendChannel({ t: 'pong' })
        break
      case 'pong':
        break
      case 'offer':
        void this.handleOffer(msg)
        break
      case 'meta':
        this.handleMeta(msg)
        break
      case 'done':
        this.finishReceiving(msg.f, msg.sha256).catch((err: Error) => {
          const x = this.x
          if (x && x.f === msg.f) this.failFile(x, `Saving failed: ${err.message}`)
        })
        break
      case 'cancel_file':
        if (this.x && this.x.f === msg.f) this.abandonXfer(this.x, 'cancelled', 'The sender cancelled this file.')
        else if (this.offerPending && this.offerPending.f === msg.f) {
          const o = this.offerPending
          this.offerPending = null
          this.addHistory({ f: o.f, name: o.name, size: o.size, status: 'cancelled', error: 'The sender withdrew this file.' })
          this.syncIncoming()
        }
        break
      case 'bye':
        this.discardAll('The sender ended the connection.')
        this.endSession('sender')
        break
      default:
        break
    }
  }

  /** Pings the sender while connected; a connection that has gone silent is treated as lost. */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.lastHeard = Date.now()
    this.heartbeat = setInterval(() => {
      if (this.dc?.readyState !== 'open') return
      if (Date.now() - this.lastHeard > HEARTBEAT_TIMEOUT_MS) {
        this.connectionLost('The connection went quiet.')
        return
      }
      this.sendChannel({ t: 'ping' })
    }, HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
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

  // ── Offers ─────────────────────────────────────────────────────────────────

  private async handleOffer(raw: OfferMessage): Promise<void> {
    const size = raw.size
    if (typeof raw.f !== 'number' || !Number.isSafeInteger(size) || size < 0 || typeof raw.name !== 'string') {
      this.sendChannel({ t: 'reject', f: typeof raw.f === 'number' ? raw.f : -1, reason: 'invalid' })
      return
    }
    const offer: OfferMessage = { t: 'offer', f: raw.f, name: safeFileName(raw.name), size, type: typeof raw.type === 'string' ? raw.type.slice(0, 255) : '', resume: raw.resume }
    if (this.offerPending) {
      this.sendChannel({ t: 'reject', f: offer.f, reason: 'busy' })
      return
    }
    // The file this device was part-way through when the connection dropped: carry on without asking again
    const x = this.x
    if (x && !x.writer && x.name === offer.name && x.size === offer.size && x.written <= x.size) {
      await this.resumeXfer(x, offer)
      return
    }
    if (x && x.writer) {
      this.sendChannel({ t: 'reject', f: offer.f, reason: 'busy' })
      return
    }
    if (x) {
      // A part-received file the sender has moved on from: leave its saved record for the Unfinished list
      // and take this offer instead of refusing everything while it is parked
      this.x = null
      this.update({ partial: null })
    }
    this.offerPending = offer
    this.syncIncoming()
    if (this.state.acceptAll) await this.acceptOffer()
  }

  /** Pick one writer for "accept all": the chosen folder, falling back to a download if the folder fails. */
  private async autoWriter(offer: OfferMessage): Promise<{ writer: DiskWriter; kind: Xfer['saveKind']; savedName: string }> {
    if (this.dir) {
      try {
        const w = await createFolderWriter(this.dir, offer.name)
        return { writer: w, kind: 'folder', savedName: w.savedName }
      } catch {
        // The folder is no longer writable (permission revoked, removed): use the browser's downloads instead
        this.dir = null
        this.update({ folderName: null })
      }
    }
    return { writer: createMemoryWriter(offer.name, offer.size, offer.type), kind: 'download', savedName: offer.name }
  }

  private async beginXfer(offer: OfferMessage, writer: DiskWriter, kind: Xfer['saveKind'], savedName: string): Promise<void> {
    let hasher: IHasher
    try {
      hasher = await createSHA256()
      hasher.init()
    } catch (err) {
      await writer.abort()
      this.rejectOffer(offer, `Could not start checking the file: ${(err as Error).message}`, 'failed')
      return
    }
    if (this.offerPending !== offer || this.ended) {
      await writer.abort()
      return
    }
    this.offerPending = null
    this.x = {
      f: offer.f, name: offer.name, size: offer.size, type: offer.type, rk: randomKey(), writer, hasher,
      received: 0, written: 0, batch: [], batchBytes: 0, chain: Promise.resolve(), gen: 0, lastCheckpoint: 0,
      token: null, savedHasher: null, speed: null, savedName, saveKind: kind, started: false,
    }
    this.syncIncoming('starting')
    this.sendChannel({ t: 'accept', f: offer.f, have: 0 })
  }

  /** Reopen the partial file after a reconnect and tell the sender where to continue from. */
  private async resumeXfer(x: Xfer, offer: OfferMessage): Promise<void> {
    try {
      const hasher = await createSHA256()
      if (x.savedHasher) hasher.load(x.savedHasher)
      else hasher.init()
      if (!x.token) throw new ResumeUnavailableError('There is nothing saved to continue from.')
      const writer = await reopenWriter(x.token, x.written, x.name, x.type)
      x.hasher = hasher
      x.writer = writer
    } catch (err) {
      // Could not reopen the partial file: start this file again from the beginning instead
      void deleteRecord(x.rk)
      this.x = null
      this.update({ partial: null })
      this.offerPending = offer
      this.syncIncoming()
      this.update({ reason: err instanceof ResumeUnavailableError ? `${err.message} Starting this file again.` : null })
      if (this.state.acceptAll) await this.acceptOffer()
      return
    }
    x.f = offer.f
    x.received = x.written
    x.batch = []
    x.batchBytes = 0
    x.chain = Promise.resolve()
    x.gen += 1
    x.lastCheckpoint = x.written
    this.update({ partial: null })
    this.syncIncoming('starting', x.written)
    this.sendChannel({ t: 'accept', f: offer.f, have: x.written })
  }

  private rejectOffer(offer: OfferMessage, error: string, status: 'failed' | 'declined'): void {
    if (this.offerPending === offer) this.offerPending = null
    this.sendChannel({ t: 'reject', f: offer.f, reason: error })
    this.addHistory({ f: offer.f, name: offer.name, size: offer.size, status, error })
    this.syncIncoming()
  }

  private handleMeta(msg: Extract<ChannelMessage, { t: 'meta' }>): void {
    const x = this.x
    if (!x || x.f !== msg.f || x.started) return
    if (msg.start !== x.written) {
      this.sendChannel({ t: 'cancel_file', f: x.f })
      this.failFile(x, `The sender could not continue from where this device stopped (it started at ${msg.start} bytes, this device has ${x.written}).`)
      return
    }
    x.started = true
    x.speed = new SpeedTracker(x.size)
    x.speed.start(performance.now(), x.written)
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = setInterval(() => this.tick(), 200)
    this.syncIncoming('transferring', x.written)
  }

  // ── Receiving ──────────────────────────────────────────────────────────────

  private onChunk(chunk: Uint8Array): void {
    const x = this.x
    if (!x || !x.started || !x.writer || !x.hasher) return
    x.received += chunk.byteLength
    x.batch.push(chunk)
    x.batchBytes += chunk.byteLength
    if (x.batchBytes >= WRITE_BATCH) this.flushBatch(x)
  }

  /**
   * Writes the batched chunks as one Blob. Once the write has succeeded they are added to the hash and
   * acknowledged, so the hash always covers exactly the bytes that are safely in the file.
   */
  private flushBatch(x: Xfer): void {
    if (x.batch.length === 0 || !x.writer) return
    const gen = x.gen
    const chunks = x.batch
    const blob = new Blob(chunks as BlobPart[])
    x.batch = []
    x.batchBytes = 0
    x.chain = x.chain.then(async () => {
      if (x.gen !== gen) return // interrupted or finished meanwhile
      const writer = x.writer
      const hasher = x.hasher
      if (!writer || !hasher) return
      await writer.write(blob)
      if (x.gen !== gen) return
      for (const c of chunks) hasher.update(c)
      x.written += blob.size
      this.sendChannel({ t: 'ack', f: x.f, bytes: x.written })
      if (writer.kind === 'disk' && x.saveKind !== 'download' && x.written - x.lastCheckpoint >= Math.max(CHECKPOINT_MIN_BYTES, Math.ceil(x.size / 10))) {
        await this.checkpoint(x)
      }
    })
    x.chain.catch((err: Error) => {
      if (this.x === x && !this.interrupting) this.failFile(x, `Could not write to disk: ${err.message}`)
    })
  }

  /**
   * Commits the file as written so far (so a closed tab or crash keeps it) and saves how far it got,
   * then reopens it to carry on. Runs inside the write queue, so nothing is written meanwhile.
   */
  private async checkpoint(x: Xfer): Promise<void> {
    const writer = x.writer
    const hasher = x.hasher
    if (!writer || !hasher) return
    x.token = await writer.suspend()
    x.savedHasher = hasher.save()
    x.lastCheckpoint = x.written
    await this.persist(x)
    x.writer = await reopenWriter(x.token, x.written, x.name, x.type)
  }

  private async finishReceiving(f: number, expected: string): Promise<void> {
    const x = this.x
    if (!x || x.f !== f || !x.started || !x.writer || !x.hasher) return
    this.syncIncoming('verifying')
    this.flushBatch(x)
    await x.chain
    if (this.x !== x || this.interrupting || !x.writer || !x.hasher) return
    const digest = x.hasher.digest('hex')
    if (x.written !== x.size || digest !== expected) {
      this.sendChannel({ t: 'verified', f, ok: false })
      this.failFile(x, MSG.corrupt)
      return
    }
    await x.writer.close()
    const savedAs = x.writer.kind === 'download' ? 'download' : x.saveKind
    x.writer = null
    x.gen += 1
    this.sendChannel({ t: 'verified', f, ok: true })
    const seconds = x.speed?.elapsed() ?? 0
    const avgSpeed = x.speed?.average(x.written) ?? 0
    void deleteRecord(x.rk)
    this.x = null
    this.stopTick()
    this.addHistory({ f, name: x.name, size: x.size, status: 'done', sha256: digest, savedName: x.savedName, savedAs, seconds, avgSpeed })
    this.syncIncoming()
  }

  /** A file stopped (cancelled or failed); the connection carries on. */
  private abandonXfer(x: Xfer, status: 'cancelled' | 'failed', error: string): void {
    x.gen += 1
    const writer = x.writer
    x.writer = null
    if (writer) writer.abort().catch(() => undefined)
    void deleteRecord(x.rk)
    if (this.x === x) this.x = null
    this.stopTick()
    this.addHistory({ f: x.f, name: x.name, size: x.size, status, error })
    this.update({ partial: null })
    this.syncIncoming()
  }

  private failFile(x: Xfer, message: string): void {
    this.abandonXfer(x, 'failed', message)
  }

  // ── Connection loss and resume ─────────────────────────────────────────────

  /** The direct connection is gone: keep what we have if a file was part-way. */
  private connectionLost(message: string): void {
    if (this.isFinished() || this.interrupting) return
    if (this.hasConnected || this.resuming) this.interrupt(message)
    else this.fail(message)
  }

  /**
   * Stops using the connection but keeps any partly received file: commits it to disk, remembers how far
   * it got (and the running hash) and starts trying to reconnect.
   */
  private interrupt(reason: string): void {
    if (this.isFinished() || this.interrupting) return
    this.interrupting = true
    this.resuming = false
    this.waitingForSender = false
    this.offerPending = null
    if (!this.interruptedAt) this.interruptedAt = Date.now()
    if (this.x) this.x.gen += 1
    this.stopTick()
    this.stopHeartbeat()
    this.closePeer()
    this.closeSocket()
    this.update({ phase: 'interrupted', reason, route: null, incoming: null })
    void this.settleAndSave()
  }

  private async settleAndSave(): Promise<void> {
    const x = this.x
    try {
      if (x) {
        await x.chain.catch(() => undefined)
        x.batch = []
        x.batchBytes = 0
        x.received = x.written
        const writer = x.writer
        x.writer = null
        if (writer) x.token = await writer.suspend()
        if (x.hasher) x.savedHasher = x.hasher.save()
        x.hasher = null // reloaded from the saved state when the file is offered again
        x.lastCheckpoint = x.written
        x.started = false
        await this.persist(x)
      }
    } catch (err) {
      // Could not keep the partial file: drop just that file, the connection can still come back
      this.interrupting = false
      if (x) this.abandonXfer(x, 'failed', `Could not keep the partly received file: ${(err as Error).message}`)
    }
    this.interrupting = false
    if (this.disposed || this.isFinished()) return
    this.update({ partial: this.x ? { name: this.x.name, size: this.x.size, saved: this.x.written } : null })
    this.scheduleRetry()
  }

  private async persist(x: Xfer): Promise<void> {
    if (!this.state.pin || !x.token || x.token.kind !== 'disk' || !x.savedHasher) return
    await saveRecord({
      rk: x.rk, sk: this.sk, name: x.name, size: x.size, type: x.type, pin: this.state.pin,
      myName: this.state.myName, senderName: this.state.senderName, have: x.written,
      hasher: x.savedHasher, token: x.token, updatedAt: Date.now(),
    })
  }

  /** Forget every saved partial and abort anything in flight (the connection ended for good). */
  private discardAll(reason: string): void {
    const x = this.x
    if (x) {
      x.gen += 1
      const writer = x.writer
      x.writer = null
      if (writer) writer.abort().catch(() => undefined)
      void deleteRecord(x.rk)
      this.x = null
      this.addHistory({ f: x.f, name: x.name, size: x.size, status: 'cancelled', error: reason })
    }
    if (this.offerPending) {
      const o = this.offerPending
      this.offerPending = null
      this.addHistory({ f: o.f, name: o.name, size: o.size, status: 'cancelled', error: reason })
    }
    this.stopTick()
    this.update({ incoming: null, partial: null })
  }

  private scheduleRetry(): void {
    this.clearRetry()
    if (this.disposed || this.state.phase !== 'interrupted' || this.state.needsClick) return
    if (Date.now() - this.interruptedAt > GIVE_UP_MS) {
      this.update({ retryIn: null, reason: 'Could not reconnect for a while. Press Reconnect to try again, or end the connection.' })
      return
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
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

  // ── State, progress and teardown ───────────────────────────────────────────

  /** Rebuilds `incoming` from what is on offer or in flight. */
  private syncIncoming(phase?: IncomingPhase, resumedFrom?: number): void {
    const x = this.x
    const o = this.offerPending
    if (x && x.writer) {
      const prev = this.state.incoming
      this.update({
        incoming: {
          f: x.f, name: x.name, size: x.size, type: x.type,
          phase: phase ?? prev?.phase ?? 'starting',
          bytes: x.received, speed: prev?.speed ?? 0, eta: prev?.eta ?? Infinity,
          resumedFrom: resumedFrom ?? prev?.resumedFrom ?? 0,
        },
      })
    } else if (o) {
      this.update({ incoming: { f: o.f, name: o.name, size: o.size, type: o.type, phase: 'offered', bytes: 0, speed: 0, eta: Infinity, resumedFrom: 0 } })
    } else {
      this.update({ incoming: null })
    }
  }

  private tick(): void {
    const x = this.x
    const inc = this.state.incoming
    if (!x || !x.speed || !x.writer || !inc || inc.phase !== 'transferring') return
    const { speed, eta } = x.speed.update(x.received)
    this.update({ incoming: { ...inc, bytes: x.received, speed, eta } })
  }

  private stopTick(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = null
  }

  private addHistory(entry: Partial<ReceivedFile> & Pick<ReceivedFile, 'f' | 'name' | 'size' | 'status'>): void {
    const full: ReceivedFile = {
      sha256: '', error: null, savedName: entry.name, savedAs: null, seconds: 0, avgSpeed: 0, ...entry,
    }
    this.update({ history: [...this.state.history, full].slice(-MAX_HISTORY) })
  }

  private fail(message: string): void {
    if (this.isFinished()) return
    this.ended = true
    this.clearRetry()
    this.discardAll(message)
    this.state.error = message
    this.update({ phase: 'error' })
    this.cleanup()
  }

  private endSession(by: 'you' | 'sender', note?: string): void {
    if (this.ended) return
    this.ended = true
    this.clearRetry()
    this.update({ phase: 'ended', endedBy: by, error: note ?? null, incoming: null, partial: null })
    this.cleanup()
  }

  private isFinished(): boolean {
    return this.disposed || this.ended
  }

  private startConnectTimer(): void {
    this.clearConnectTimer()
    this.connectTimer = setTimeout(() => {
      if (this.dc?.readyState === 'open' || this.waitingForSender || this.isFinished()) return
      if (this.hasConnected || this.resuming) this.interrupt(MSG.connectFailed)
      else this.fail(MSG.connectFailed)
    }, CONNECT_TIMEOUT_MS)
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  private closePeer(): void {
    const { dc, pc } = this
    this.dc = null
    this.pc = null
    this.pendingCandidates = []
    if (dc) {
      dc.onclose = null
      dc.onmessage = null
    }
    if (pc) pc.onconnectionstatechange = null
    setTimeout(() => {
      try { dc?.close() } catch { /* already closed */ }
      try { pc?.close() } catch { /* already closed */ }
    }, 500)
  }

  private closeSocket(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      try { ws.close(1000) } catch { /* already closed */ }
    }
  }

  private cleanup(): void {
    this.stopTick()
    this.stopHeartbeat()
    this.awake.stop()
    this.clearConnectTimer()
    const x = this.x
    if (x) {
      x.gen += 1
      const writer = x.writer
      x.writer = null
      if (writer) writer.abort().catch(() => undefined)
    }
    this.x = null
    this.closePeer()
    this.closeSocket()
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
    case 'sender_away': return 'The sender lost their connection. Ask them to check it, then try again.'
    default: return fallback || 'Something went wrong.'
  }
}
