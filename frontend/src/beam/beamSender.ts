/**
 * The sending side of Clip Beam: a room that stays open, with a queue of files and up to MAX_RECEIVERS
 * receivers connected at once.
 *
 * The sender opens a room and shares its PIN (or invites people from the radar). Every receiver that joins
 * gets its own "leg": one direct WebRTC connection that stays up for the whole visit. Over it the sender
 * offers files one at a time; the receiver accepts, declines, or accepts everything. Files can be added at
 * any time, and either side can end the connection whenever it likes.
 *
 * A leg is independent: one receiver failing, leaving or being slow never affects the others. If a leg's
 * connection drops it is only paused; when the same receiver comes back (recognised by its session key) the
 * leg picks up its history and carries on with the file that was interrupted.
 *
 * Keeping the connection alive: each leg pings over the direct channel and treats silence as a lost
 * connection; a flaky path is repaired with an ICE restart without dropping the channel; the sender's own
 * link to Clip reconnects with growing delays and holds its room for about ten minutes.
 */
import { createSHA256 } from 'hash-wasm'
import {
  BUFFER_HIGH, BUFFER_LOW, CONNECT_TIMEOUT_MS, FLOW_WINDOW, HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, MAX_CHUNK, PING_MS,
  getRtcConfig, beamWsUrl, type ChannelMessage, type FileOffer, type SignalData,
} from './beamProtocol'
import { KeepAwake } from './keepAwake'
import { SpeedTracker } from './speedTracker'
import { BeamLobbyClient, type LobbyStatus, type NearbyPerson } from './beamLobby'

export interface SenderFile {
  /** Position in the queue; also how the receiver names this file in its messages */
  id: number
  name: string
  size: number
  type: string
}

export type TransferStatus = 'offered' | 'transferring' | 'verifying' | 'done' | 'declined' | 'cancelled' | 'error'

export interface LegResult {
  seconds: number
  avgSpeed: number
  sha256: string
}

/** One file's journey to one receiver. */
export interface LegTransfer {
  f: number
  name: string
  size: number
  status: TransferStatus
  bytes: number
  speed: number
  eta: number
  error: string | null
  result: LegResult | null
  /** Bytes the receiver already had when this attempt started (0 unless it carried on after a drop) */
  resumedFrom: number
}

export type LegPhase = 'connecting' | 'connected' | 'paused' | 'ended' | 'error'

export interface SenderLeg {
  id: string
  /** The receiver's display name, e.g. "Mochi" */
  name: string
  phase: LegPhase
  route: string | null
  error: string | null
  /** Who ended the connection, once it has ended */
  endedBy: 'you' | 'them' | null
  transfers: LegTransfer[]
}

export type SenderPhase = 'idle' | 'connecting' | 'open' | 'stopped' | 'error'

/** A receiver on the radar. */
export interface NearbyEntry extends NearbyPerson {
  /** idle: not asked yet. invited: request delivered. accepted: said yes. declined: said no or left. */
  status: 'idle' | 'invited' | 'accepted' | 'declined'
}

export interface SenderState {
  phase: SenderPhase
  /** Receivers who switched on Receive mode on this network */
  nearby: NearbyEntry[]
  nearbyStatus: LobbyStatus
  /** The sender's own link to Clip. "reconnecting" while it is down and being retried. */
  connection: 'online' | 'reconnecting'
  /** This sender's own display name, as the room knows it */
  myName: string
  pin: string | null
  /** Everything queued to send, in order */
  files: SenderFile[]
  legs: SenderLeg[]
  error: string | null
}

export const INITIAL_SENDER_STATE: SenderState = {
  phase: 'idle', nearby: [], nearbyStatus: 'connecting', connection: 'online', myName: '', pin: null, files: [], legs: [], error: null,
}

/** How long a leg with an open data channel waits for its own messages after its socket closes. */
const PEER_LEFT_GRACE_MS = 3000
/** Seconds between the sender's own reconnect attempts; the last value repeats. */
const RECONNECT_DELAYS = [1, 2, 3, 5, 8, 13, 20, 30]
/** A Beam room is only held about ten minutes for a sender that dropped, so stop trying after that. */
const RECONNECT_GIVE_UP_MS = 11 * 60_000
/** A struggling path gets this many ICE restarts before the connection is declared lost. */
const MAX_ICE_RESTARTS = 3
const ICE_DISCONNECTED_WAIT_MS = 4000
const ICE_RESTART_WAIT_MS = 10_000

const IN_FLIGHT: TransferStatus[] = ['offered', 'transferring', 'verifying']

const MSG = {
  connectFailed: 'Could not open a direct connection to this device. It may be behind a strict firewall or mobile carrier NAT. Try both devices on the same Wi-Fi.',
  corrupt: 'This device reported that the file did not match the original (SHA-256 mismatch). Send it again.',
  lost: 'Connection lost. Waiting for this device to reconnect.',
}

interface FileEntry {
  meta: SenderFile
  file: File
}

type Decision = { accept: true; have: number } | { accept: false; reason: string; cancelled: boolean } | 'aborted'
type Verdict = { ok: boolean } | 'cancelled' | 'aborted'

interface Current {
  f: number
  sent: number
  acked: number
  cancelled: boolean
  speed: SpeedTracker
}

interface LegDeps {
  files: () => FileEntry[]
  signal: (to: string, data: SignalData) => void
  changed: () => void
  /** The receiver introduced itself; the sender may hand over a returning receiver's history */
  onHello: (leg: Leg) => void
}

/** One receiver's connection, queue progress and history. */
class Leg {
  info: SenderLeg
  /** The receiver's session key (same across its reconnects) */
  sk = ''
  /** The next file in the queue still to be offered */
  nextIdx = 0
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private pendingCandidates: RTCIceCandidateInit[] = []
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private iceTimer: ReturnType<typeof setTimeout> | null = null
  private iceRestarts = 0
  private lastHeard = 0
  private gotHello = false
  private connectedOnce = false
  /** Bumped whenever this leg stops (pause, end, error) so a running send loop knows to leave */
  private epoch = 0
  private looping = false
  private wakeLoop: (() => void) | null = null
  private decide: ((d: Decision) => void) | null = null
  private verify: ((v: Verdict) => void) | null = null
  private wakeSend: (() => void) | null = null
  private cur: Current | null = null

  constructor(id: string, name: string, private readonly deps: LegDeps) {
    this.info = { id, name, phase: 'connecting', route: null, error: null, endedBy: null, transfers: [] }
  }

  get id(): string {
    return this.info.id
  }

  get finished(): boolean {
    return this.info.phase === 'ended' || this.info.phase === 'error'
  }

  get connected(): boolean {
    return this.info.phase === 'connected'
  }

  // ── Connecting ─────────────────────────────────────────────────────────────

  /** Starts the direct connection (the sender is always the one that offers). */
  async begin(): Promise<void> {
    this.connectTimer = setTimeout(() => {
      if (!this.gotHello && !this.finished) this.fail(MSG.connectFailed)
    }, CONNECT_TIMEOUT_MS)
    const config = await getRtcConfig()
    if (this.finished) return
    const pc = new RTCPeerConnection(config)
    this.pc = pc
    pc.onicecandidate = (e) => {
      if (e.candidate) this.deps.signal(this.id, { candidate: e.candidate.toJSON() })
    }
    pc.onconnectionstatechange = () => {
      if (this.pc === pc) this.onConnectionState(pc)
    }
    const dc = pc.createDataChannel('beam', { ordered: true })
    this.setupChannel(dc)
    await pc.setLocalDescription(await pc.createOffer())
    this.deps.signal(this.id, { sdp: pc.localDescription?.toJSON() })
  }

  private setupChannel(dc: RTCDataChannel): void {
    this.dc = dc
    dc.binaryType = 'arraybuffer'
    dc.bufferedAmountLowThreshold = BUFFER_LOW
    dc.onopen = () => {
      if (this.dc !== dc) return
      this.connectedOnce = true
      this.iceRestarts = 0
      this.startHeartbeat()
      this.detectRoute()
    }
    dc.onclose = () => {
      if (this.dc === dc) this.lost(MSG.lost)
    }
    dc.onbufferedamountlow = () => this.poke()
    dc.onmessage = (e) => {
      if (this.dc !== dc) return
      this.lastHeard = Date.now()
      if (typeof e.data !== 'string') return
      try {
        this.onMessage(JSON.parse(e.data) as ChannelMessage)
      } catch {
        // Not for us
      }
    }
  }

  async onSignal(data: SignalData): Promise<void> {
    const pc = this.pc
    if (!pc || this.finished) return
    if (data.sdp) {
      if (data.sdp.type === 'answer' && (pc.signalingState === 'have-local-offer')) {
        await pc.setRemoteDescription(data.sdp)
        const queued = this.pendingCandidates
        this.pendingCandidates = []
        for (const c of queued) await pc.addIceCandidate(c).catch(() => undefined)
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => undefined)
      else this.pendingCandidates.push(data.candidate)
    }
  }

  /** A struggling path is repaired in place (ICE restart) before the connection is given up on. */
  private onConnectionState(pc: RTCPeerConnection): void {
    const state = pc.connectionState
    if (state === 'connected') {
      this.iceRestarts = 0
      if (this.iceTimer) clearTimeout(this.iceTimer)
      this.iceTimer = null
    } else if (state === 'disconnected') {
      if (this.iceTimer) clearTimeout(this.iceTimer)
      this.iceTimer = setTimeout(() => void this.restartIce(), ICE_DISCONNECTED_WAIT_MS)
    } else if (state === 'failed') {
      if (this.connectedOnce) void this.restartIce()
      else this.fail(MSG.connectFailed)
    }
  }

  private async restartIce(): Promise<void> {
    const pc = this.pc
    if (!pc || this.finished || this.info.phase === 'paused') return
    if (pc.connectionState === 'connected') return
    if (this.iceRestarts >= MAX_ICE_RESTARTS) {
      this.lost(MSG.lost)
      return
    }
    this.iceRestarts += 1
    try {
      pc.restartIce()
      await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }))
      this.deps.signal(this.id, { sdp: pc.localDescription?.toJSON(), restart: true })
    } catch {
      // Could not renegotiate (signalling is down too); the next check decides
    }
    if (this.iceTimer) clearTimeout(this.iceTimer)
    this.iceTimer = setTimeout(() => void this.restartIce(), ICE_RESTART_WAIT_MS)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.lastHeard = Date.now()
    this.heartbeat = setInterval(() => {
      if (this.dc?.readyState !== 'open') return
      if (Date.now() - this.lastHeard > HEARTBEAT_TIMEOUT_MS) {
        this.lost('The connection went quiet.')
        return
      }
      this.send({ t: 'ping' })
    }, HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  // ── Messages from the receiver ─────────────────────────────────────────────

  private onMessage(msg: ChannelMessage): void {
    if (this.finished) return
    switch (msg.t) {
      case 'hello':
        if (this.gotHello || typeof msg.sk !== 'string') return
        this.gotHello = true
        this.sk = msg.sk.slice(0, 64)
        if (this.connectTimer) clearTimeout(this.connectTimer)
        this.connectTimer = null
        this.deps.onHello(this)
        this.set({ phase: 'connected' })
        this.startLoop()
        break
      case 'ping':
        this.send({ t: 'pong' })
        break
      case 'pong':
        break // any message counts as proof of life (see lastHeard); nothing else to do
      case 'accept':
        this.settleDecision({ accept: true, have: typeof msg.have === 'number' && Number.isSafeInteger(msg.have) ? msg.have : 0 })
        break
      case 'reject':
        this.settleDecision({ accept: false, reason: typeof msg.reason === 'string' ? msg.reason.slice(0, 200) : 'declined', cancelled: false })
        break
      case 'ack':
        if (this.cur && this.cur.f === msg.f && typeof msg.bytes === 'number') {
          this.cur.acked = Math.max(this.cur.acked, msg.bytes)
          this.poke()
        }
        break
      case 'verified':
        this.settleVerdict({ ok: msg.ok === true })
        break
      case 'cancel_file':
        if (this.cur && this.cur.f === msg.f) {
          this.cur.cancelled = true
          this.settleVerdict('cancelled')
          this.poke()
        } else {
          this.settleDecision({ accept: false, reason: 'cancelled', cancelled: true })
        }
        break
      case 'bye':
        this.endBy('them')
        break
      default:
        break
    }
  }

  private send(msg: ChannelMessage): void {
    if (this.dc?.readyState === 'open') {
      try {
        this.dc.send(JSON.stringify(msg))
      } catch {
        // The channel closed under us; its close handler deals with it
      }
    }
  }

  // ── The send loop ──────────────────────────────────────────────────────────

  /** Wakes the loop to look for newly queued files. */
  kick(): void {
    if (this.connected) this.startLoop()
    const wake = this.wakeLoop
    this.wakeLoop = null
    wake?.()
  }

  private startLoop(): void {
    if (this.looping || !this.connected) return
    this.looping = true
    void this.runLoop().finally(() => {
      this.looping = false
    })
  }

  private async runLoop(): Promise<void> {
    const epoch = this.epoch
    while (this.epoch === epoch && this.connected) {
      const entry = this.deps.files().find((e) => e.meta.id >= this.nextIdx)
      if (!entry) {
        // Nothing queued: wait for more files (or for the connection to end)
        await new Promise<void>((resolve) => {
          this.wakeLoop = resolve
        })
        continue
      }
      try {
        await this.sendOne(entry, epoch)
      } catch (err) {
        if (this.epoch === epoch) this.lost(`Sending failed: ${(err as Error).message}`)
        return
      }
    }
  }

  private async sendOne(entry: FileEntry, epoch: number): Promise<void> {
    const { meta, file } = entry
    const dc = this.dc
    if (!dc) return
    const resumed = this.info.transfers.find((t) => t.f === meta.id && IN_FLIGHT.includes(t.status) && t.bytes > 0)
    this.setTransfer(meta, { status: 'offered', error: null, speed: 0, eta: Infinity })
    this.send({ t: 'offer', f: meta.id, name: meta.name, size: meta.size, type: meta.type, resume: resumed ? true : undefined })

    const decision = await new Promise<Decision>((resolve) => {
      this.decide = resolve
    })
    this.decide = null
    if (decision === 'aborted' || this.epoch !== epoch) return
    if (!decision.accept) {
      this.setTransfer(meta, { status: decision.cancelled ? 'cancelled' : 'declined', error: decision.cancelled ? 'The receiver withdrew.' : null })
      this.nextIdx = meta.id + 1
      return
    }

    const start = decision.have >= 0 && decision.have <= meta.size ? decision.have : 0
    const cur: Current = { f: meta.id, sent: start, acked: start, cancelled: false, speed: new SpeedTracker(meta.size) }
    this.cur = cur
    cur.speed.start(performance.now(), start)
    this.setTransfer(meta, { status: 'transferring', resumedFrom: start, bytes: start })
    this.send({ t: 'meta', f: meta.id, start })

    const maxMessage = this.pc?.sctp?.maxMessageSize || 64 * 1024
    const chunkSize = Math.min(MAX_CHUNK, maxMessage)
    const hasher = await createSHA256()
    hasher.init()
    const stopped = (): boolean => this.epoch !== epoch || cur.cancelled
    if (start > 0) {
      // The receiver already has these bytes; read them here only so the final SHA-256 covers the whole file
      const head = file.slice(0, start).stream().getReader()
      try {
        for (;;) {
          const { done, value } = await head.read()
          if (done || stopped()) break
          hasher.update(value)
        }
      } finally {
        head.releaseLock()
      }
    }
    if (!stopped()) {
      const reader = file.slice(start).stream().getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          hasher.update(value)
          for (let off = 0; off < value.byteLength; off += chunkSize) {
            await this.waitForRoom(dc, cur, epoch)
            if (stopped()) break
            const piece = value.subarray(off, Math.min(off + chunkSize, value.byteLength))
            dc.send(piece)
            cur.sent += piece.byteLength
          }
          if (stopped()) break
        }
      } finally {
        reader.releaseLock()
      }
    }
    this.cur = null
    if (this.epoch !== epoch) return
    if (cur.cancelled) {
      this.setTransfer(meta, { status: 'cancelled', error: 'Cancelled.' })
      this.nextIdx = meta.id + 1
      return
    }

    const sha256 = hasher.digest('hex')
    this.setTransfer(meta, { status: 'verifying', result: { seconds: 0, avgSpeed: 0, sha256 } })
    this.send({ t: 'done', f: meta.id, sha256 })
    const verdict = await new Promise<Verdict>((resolve) => {
      this.verify = resolve
    })
    this.verify = null
    if (verdict === 'aborted' || this.epoch !== epoch) return
    this.nextIdx = meta.id + 1
    if (verdict === 'cancelled') {
      this.setTransfer(meta, { status: 'cancelled', error: 'The receiver cancelled.' })
    } else if (verdict.ok) {
      this.setTransfer(meta, {
        status: 'done', bytes: meta.size, speed: 0, eta: 0,
        result: { seconds: cur.speed.elapsed(), avgSpeed: cur.speed.average(meta.size), sha256 },
      })
    } else {
      this.setTransfer(meta, { status: 'error', error: MSG.corrupt, speed: 0 })
    }
  }

  private async waitForRoom(dc: RTCDataChannel, cur: Current, epoch: number): Promise<void> {
    while (dc.bufferedAmount > BUFFER_HIGH || cur.sent - cur.acked > FLOW_WINDOW) {
      if (this.epoch !== epoch || cur.cancelled) return
      if (dc.readyState !== 'open') throw new Error('connection closed')
      await new Promise<void>((resolve) => {
        this.wakeSend = resolve
      })
    }
  }

  private poke(): void {
    const w = this.wakeSend
    this.wakeSend = null
    w?.()
  }

  private settleDecision(d: Decision): void {
    const r = this.decide
    this.decide = null
    r?.(d)
  }

  private settleVerdict(v: Verdict): void {
    const r = this.verify
    this.verify = null
    r?.(v)
  }

  /** Lets every waiting part of the loop go (the leg is stopping). */
  private abortWaiters(): void {
    this.settleDecision('aborted')
    this.settleVerdict('aborted')
    this.poke()
    const w = this.wakeLoop
    this.wakeLoop = null
    w?.()
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  /** Stop one file for this receiver; the connection stays open. */
  cancelFile(f: number): void {
    this.send({ t: 'cancel_file', f })
    if (this.cur && this.cur.f === f) {
      this.cur.cancelled = true
      this.settleVerdict('cancelled')
      this.poke()
    } else {
      this.settleDecision({ accept: false, reason: 'cancelled', cancelled: true })
    }
  }

  /** End the connection with this receiver. */
  disconnect(): void {
    if (this.finished) return
    this.send({ t: 'bye' })
    this.endBy('you')
  }

  /** The receiver left or went quiet on the signalling side. The channel gets a moment to say why. */
  gone(graceMs = 0): void {
    if (this.finished) return
    if (!this.gotHello) {
      this.fail(MSG.connectFailed)
      return
    }
    if (graceMs > 0 && this.dc?.readyState === 'open') setTimeout(() => this.lost(MSG.lost), graceMs)
    else this.lost(MSG.lost)
  }

  /** The connection dropped without anyone ending it: pause (the receiver may come back and carry on). */
  lost(message: string): void {
    if (this.finished || this.info.phase === 'paused') return
    if (!this.gotHello) {
      this.fail(message === MSG.lost ? MSG.connectFailed : message)
      return
    }
    this.epoch += 1
    this.abortWaiters()
    this.cur = null
    this.shutdownConnection()
    this.set({ phase: 'paused', error: null })
  }

  private endBy(who: 'you' | 'them'): void {
    if (this.finished) return
    this.epoch += 1
    this.abortWaiters()
    this.cur = null
    this.settleInFlight('cancelled', who === 'you' ? 'You ended the connection.' : 'The receiver ended the connection.')
    this.shutdownConnection()
    this.info = { ...this.info, endedBy: who }
    this.set({ phase: 'ended' })
  }

  fail(message: string): void {
    if (this.finished) return
    this.epoch += 1
    this.abortWaiters()
    this.cur = null
    this.settleInFlight('error', message)
    this.shutdownConnection()
    this.info = { ...this.info, error: message }
    this.set({ phase: 'error' })
  }

  /** Closes the network side without changing what the leg shows (a replaced or discarded leg). */
  discard(): void {
    this.epoch += 1
    this.abortWaiters()
    this.shutdownConnection()
  }

  private settleInFlight(status: 'cancelled' | 'error', error: string): void {
    this.info = {
      ...this.info,
      transfers: this.info.transfers.map((t) => (IN_FLIGHT.includes(t.status) ? { ...t, status, error, speed: 0, eta: Infinity } : t)),
    }
  }

  private shutdownConnection(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    if (this.iceTimer) clearTimeout(this.iceTimer)
    this.connectTimer = null
    this.iceTimer = null
    this.stopHeartbeat()
    const { dc, pc } = this
    this.dc = null
    this.pc = null
    if (dc) {
      dc.onclose = null
      dc.onmessage = null
    }
    if (pc) pc.onconnectionstatechange = null
    // Let a final control message leave before the channel is closed
    setTimeout(() => {
      try { dc?.close() } catch { /* already closed */ }
      try { pc?.close() } catch { /* already closed */ }
    }, 500)
  }

  // ── History handover ───────────────────────────────────────────────────────

  /** What a returning receiver's new connection should inherit. */
  snapshot(): { transfers: LegTransfer[]; nextIdx: number } {
    return { transfers: this.info.transfers, nextIdx: this.nextIdx }
  }

  /** Takes over a previous connection's history; the file that was in flight is offered again. */
  inherit(prev: { transfers: LegTransfer[]; nextIdx: number }): void {
    const inflight = prev.transfers.filter((t) => IN_FLIGHT.includes(t.status))
    this.nextIdx = inflight.length ? Math.min(prev.nextIdx, ...inflight.map((t) => t.f)) : prev.nextIdx
    this.info = { ...this.info, transfers: prev.transfers.map((t) => (IN_FLIGHT.includes(t.status) ? { ...t, status: 'offered', speed: 0, eta: Infinity } : t)) }
  }

  // ── Progress ───────────────────────────────────────────────────────────────

  tick(): void {
    const cur = this.cur
    if (!cur) return
    const row = this.info.transfers.find((t) => t.f === cur.f)
    if (!row || row.status !== 'transferring') return
    const bytes = Math.min(row.size, Math.max(cur.acked, cur.sent - (this.dc?.bufferedAmount ?? 0)))
    const { speed, eta } = cur.speed.update(bytes)
    this.setTransfer({ id: row.f, name: row.name, size: row.size, type: '' }, { bytes, speed, eta }, false)
  }

  private setTransfer(meta: SenderFile, patch: Partial<LegTransfer>, notify = true): void {
    const existing = this.info.transfers.find((t) => t.f === meta.id)
    const row: LegTransfer = existing
      ? { ...existing, ...patch }
      : { f: meta.id, name: meta.name, size: meta.size, status: 'offered', bytes: 0, speed: 0, eta: Infinity, error: null, result: null, resumedFrom: 0, ...patch }
    this.info = {
      ...this.info,
      transfers: existing ? this.info.transfers.map((t) => (t.f === meta.id ? row : t)) : [...this.info.transfers, row],
    }
    if (notify) this.deps.changed()
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
      if (route) this.set({ route })
    }).catch(() => undefined) // cosmetic only: the label just stays empty
  }

  private set(patch: Partial<SenderLeg>): void {
    this.info = { ...this.info, ...patch }
    this.deps.changed()
  }
}

type SenderMessage =
  | { type: 'room_created'; pin: string; name: string; token: string }
  | { type: 'room_resumed'; pin: string; name: string }
  | { type: 'peer_joined'; id: string; name: string }
  | { type: 'peer_left'; role: 'receiver'; id: string }
  | { type: 'signal'; from: string; data: SignalData }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string }

export class BeamSender {
  private state: SenderState = { ...INITIAL_SENDER_STATE }
  private ws: WebSocket | null = null
  private legs = new Map<string, Leg>()
  private entries: FileEntry[] = []
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private lobby: BeamLobbyClient | null = null
  /** Secret that lets this sender take its room back after its own connection drops */
  private token = ''
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private reconnectSince = 0
  private stopping = false
  private readonly awake = new KeepAwake()

  constructor(private readonly emit: (state: SenderState) => void) {}

  /** Opens the room with the first files. More can be added with `addFiles` for as long as it stays open. */
  start(files: File[], name: string): void {
    this.addEntries(files)
    this.update({ phase: 'connecting', myName: name })
    window.addEventListener('online', this.onOnline)
    this.connect()
  }

  /** Queue more files; every connected receiver is offered them in turn. */
  addFiles(files: File[]): void {
    if (this.state.phase === 'stopped' || this.state.phase === 'error' || this.stopping) return
    this.addEntries(files)
    this.publish()
    for (const leg of this.legs.values()) leg.kick()
    this.refreshInviteSummary()
  }

  private addEntries(files: File[]): void {
    for (const file of files) {
      const id = this.entries.length
      this.entries.push({ meta: { id, name: file.name || `file-${id + 1}`, size: file.size, type: file.type }, file })
    }
    this.update({ files: this.entries.map((e) => e.meta) })
  }

  /** What an invite or the room shows: the file, or "3 files" for several. */
  private summary(): FileOffer {
    const metas = this.entries.map((e) => e.meta)
    return {
      name: metas.length === 1 ? metas[0].name : `${metas.length} files`,
      size: metas.reduce((n, m) => n + m.size, 0),
      type: '',
    }
  }

  private refreshInviteSummary(): void {
    // Requests already sent keep the summary they were sent with; new ones use the current queue
  }

  /** Opens (or, with a token, re-opens) the signalling socket. */
  private connect(): void {
    const reclaiming = this.token !== ''
    let ws: WebSocket
    try {
      ws = new WebSocket(beamWsUrl(reclaiming ? this.state.pin ?? undefined : undefined, this.state.myName, reclaiming ? this.token : undefined))
    } catch {
      if (reclaiming) this.scheduleReconnect()
      else this.fail('Could not reach Clip Beam.')
      return
    }
    this.ws = ws
    ws.onopen = () => {
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_MS)
    }
    ws.onmessage = (event) => {
      let msg: SenderMessage
      try {
        msg = JSON.parse(String(event.data)) as SenderMessage
      } catch {
        return
      }
      this.onMessage(msg).catch((err: Error) => this.fail(`Connection setup failed: ${err.message}`))
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = null
      if (this.state.phase === 'stopped' || this.state.phase === 'error' || this.stopping) return
      if (this.state.phase === 'connecting' && !this.token) {
        this.fail('Could not reach Clip Beam. Check your connection and try again.')
        return
      }
      // The room is held for a while for a sender that dropped, and running connections are direct, so keep going
      this.scheduleReconnect()
    }
  }

  /** Retries the link to Clip with a growing delay, for as long as the room is held. */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.disposed) return
    if (!this.reconnectSince) this.reconnectSince = Date.now()
    if (Date.now() - this.reconnectSince > RECONNECT_GIVE_UP_MS) {
      this.fail('Lost the connection to Clip for too long. This Beam has closed; start a new one.')
      return
    }
    this.update({ connection: 'reconnecting' })
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt++, RECONNECT_DELAYS.length - 1)]
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay * 1000)
  }

  /** "Reconnect now": skip the wait and try again immediately. */
  reconnectNow(): void {
    if (this.state.connection !== 'reconnecting' || this.disposed) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.connect()
  }

  private onOnline = (): void => this.reconnectNow()

  /** Asks these nearby receivers to connect. */
  invite(ids: string[]): void {
    const { pin } = this.state
    if (!this.lobby || !pin || ids.length === 0 || this.entries.length === 0) return
    this.lobby.invite(ids, this.summary(), pin)
  }

  /** Ends every connection and closes the room. */
  stop(): void {
    if (this.state.phase === 'stopped' || this.state.phase === 'error') return
    this.stopping = true
    this.lobby?.cancelInvites()
    for (const leg of this.legs.values()) leg.disconnect()
    this.publish()
    this.update({ phase: 'stopped' })
    this.shutdown()
  }

  /** Stop one file for one receiver. */
  cancelFile(legId: string, f: number): void {
    this.legs.get(legId)?.cancelFile(f)
    this.publish()
  }

  /** End the connection with one receiver. */
  disconnectLeg(legId: string): void {
    this.legs.get(legId)?.disconnect()
    this.publish()
  }

  /** Remove the row of a receiver whose connection has ended (or failed). */
  dismissLeg(legId: string): void {
    const leg = this.legs.get(legId)
    if (!leg || !leg.finished) return
    leg.discard()
    this.legs.delete(legId)
    this.publish()
  }

  dispose(): void {
    this.disposed = true
    window.removeEventListener('online', this.onOnline)
    this.lobby?.close()
    this.lobby = null
    this.shutdown()
    for (const leg of this.legs.values()) leg.discard()
  }

  private async onMessage(msg: SenderMessage): Promise<void> {
    if (this.state.phase === 'stopped' || this.state.phase === 'error') return
    switch (msg.type) {
      case 'room_resumed':
        // Back after a dropped connection: the room, its PIN and the receivers who stayed are all as we left them
        this.reconnectAttempt = 0
        this.reconnectSince = 0
        this.update({ connection: 'online', myName: msg.name || this.state.myName })
        this.lobby?.close()
        this.startLobby(this.state.myName)
        break
      case 'room_created':
        this.token = msg.token
        this.update({ phase: 'open', pin: msg.pin, myName: msg.name || this.state.myName })
        this.startLobby(this.state.myName)
        if (!this.tickTimer) this.tickTimer = setInterval(() => this.tick(), 200)
        break
      case 'peer_joined': {
        const existing = this.legs.get(msg.id)
        if (existing) {
          // The room re-announces receivers after this sender reconnects; a leg that is still fine stays as it is
          return
        }
        const leg = new Leg(msg.id, msg.name || 'Guest', {
          files: () => this.entries,
          signal: (to, data) => this.send({ type: 'signal', to, data }),
          changed: () => this.publish(),
          onHello: (l) => this.adopt(l),
        })
        this.legs.set(msg.id, leg)
        this.awake.start()
        this.publish()
        leg.begin().catch((err: Error) => {
          leg.fail(`Could not start the connection: ${err.message}`)
          this.publish()
        })
        break
      }
      case 'peer_left':
        this.legs.get(msg.id)?.gone(PEER_LEFT_GRACE_MS)
        this.publish()
        break
      case 'signal':
        await this.legs.get(msg.from)?.onSignal(msg.data)
        break
      case 'error':
        this.fail(msg.code === 'expired'
          ? 'This Beam timed out after 10 minutes with nobody connected. Start a new one.'
          : msg.code === 'no_room'
            ? 'This Beam is no longer open (it was held for 10 minutes after the connection dropped). Start a new one.'
            : msg.message || 'Something went wrong.')
        break
      default:
        break
    }
  }

  /** A receiver introduced itself. If it is one that dropped earlier, it takes over that connection's history. */
  private adopt(leg: Leg): void {
    if (!leg.sk) return
    for (const [id, other] of this.legs) {
      if (id === leg.id || other.sk !== leg.sk) continue
      leg.inherit(other.snapshot())
      other.discard()
      this.legs.delete(id)
    }
    this.publish()
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  /** Opens the nearby lobby as a (hidden) sender so receivers on this network show up on the radar. */
  private startLobby(name: string): void {
    const setEntry = (id: string, status: NearbyEntry['status']) =>
      this.update({ nearby: this.state.nearby.map((p) => (p.id === id ? { ...p, status } : p)) })
    this.lobby = new BeamLobbyClient('sender', name, {
      onStatus: (nearbyStatus) => this.update({ nearbyStatus }),
      onPeers: (peers) => {
        const old = new Map(this.state.nearby.map((p) => [p.id, p.status]))
        this.update({ nearby: peers.map((p) => ({ ...p, status: old.get(p.id) ?? 'idle' })) })
      },
      onInviteSent: (to) => setEntry(to, 'invited'),
      onInviteAccepted: (to) => setEntry(to, 'accepted'),
      onInviteClosed: (to, reason) => setEntry(to, reason === 'declined' ? 'declined' : 'idle'),
    })
    this.lobby.connect()
  }

  private tick(): void {
    for (const leg of this.legs.values()) leg.tick()
    this.publish()
  }

  private publish(): void {
    this.update({ legs: [...this.legs.values()].map((l) => l.info) })
  }

  private fail(message: string): void {
    if (this.state.phase === 'error' || this.state.phase === 'stopped') return
    for (const leg of this.legs.values()) leg.fail(message)
    this.publish()
    this.update({ phase: 'error', error: message })
    this.shutdown()
  }

  private shutdown(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.pingTimer = null
    this.tickTimer = null
    this.awake.stop()
    window.removeEventListener('online', this.onOnline)
    this.lobby?.close()
    this.lobby = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      try { ws.close(1000) } catch { /* already closed */ }
    }
  }

  private update(patch: Partial<SenderState>): void {
    this.state = { ...this.state, ...patch }
    if (!this.disposed) this.emit(this.state)
  }
}
