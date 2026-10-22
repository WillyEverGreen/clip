/**
 * The sending side of Clip Beam, for one file and up to MAX_RECEIVERS receivers at once.
 *
 * The sender opens a room and shares its PIN. Every receiver that joins gets its own "leg": its own
 * WebRTC connection, its own pass over the file, its own progress and hash check. Legs are
 * independent, so one receiver failing, leaving or being slow never affects the others. The room
 * stays open (for more receivers) until the sender stops sharing.
 *
 * The signalling WebSocket only carries the offer, SDP and ICE. File bytes go over each leg's
 * RTCDataChannel with two kinds of backpressure: the channel's own send buffer, and a window of
 * bytes the receiver has not yet confirmed writing to disk.
 */
import { createSHA256 } from 'hash-wasm'
import {
  BUFFER_HIGH, BUFFER_LOW, CONNECT_TIMEOUT_MS, FLOW_WINDOW, MAX_CHUNK, PING_MS, RTC_CONFIG,
  beamWsUrl, type ChannelMessage, type FileOffer, type SignalData,
} from './beamProtocol'
import { SpeedTracker } from './speedTracker'
import { BeamLobbyClient, type LobbyStatus, type NearbyPerson } from './beamLobby'

export type LegPhase = 'joined' | 'peering' | 'transferring' | 'verifying' | 'done' | 'declined' | 'error'

export interface LegResult {
  seconds: number
  avgSpeed: number
  sha256: string
}

export interface SenderLeg {
  id: string
  /** The receiver's display name, e.g. "Mochi" */
  name: string
  phase: LegPhase
  bytes: number
  speed: number
  eta: number
  route: string | null
  error: string | null
  result: LegResult | null
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
  /** This sender's own display name, as the room knows it */
  myName: string
  pin: string | null
  offer: FileOffer | null
  legs: SenderLeg[]
  error: string | null
}

export const INITIAL_SENDER_STATE: SenderState = { phase: 'idle', nearby: [], nearbyStatus: 'connecting', myName: '', pin: null, offer: null, legs: [], error: null }

/** How long a leg with an open data channel waits for its own messages after its socket closes. */
const PEER_LEFT_GRACE_MS = 3000

const LEG_ACTIVE: LegPhase[] = ['peering', 'transferring', 'verifying']
const LEG_FINISHED: LegPhase[] = ['done', 'declined', 'error']

const MSG = {
  connectFailed: 'Could not open a direct connection to this device. It may be behind a strict firewall or mobile carrier NAT. Try both devices on the same Wi-Fi.',
  peerGone: 'This device disconnected before the transfer finished.',
  corrupt: 'This device reported that the file did not match the original (SHA-256 mismatch). Send it again.',
}

/** One receiver's connection and progress. */
class Leg {
  pc: RTCPeerConnection | null = null
  dc: RTCDataChannel | null = null
  info: SenderLeg
  private pendingCandidates: RTCIceCandidateInit[] = []
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private sent = 0
  private acked = 0
  private wake: (() => void) | null = null
  private speed: SpeedTracker

  constructor(
    id: string,
    name: string,
    private readonly file: File,
    private readonly signal: (to: string, data: SignalData) => void,
    private readonly changed: () => void,
  ) {
    this.info = { id, name, phase: 'joined', bytes: 0, speed: 0, eta: Infinity, route: null, error: null, result: null }
    this.speed = new SpeedTracker(file.size)
  }

  get finished(): boolean {
    return LEG_FINISHED.includes(this.info.phase)
  }

  get active(): boolean {
    return LEG_ACTIVE.includes(this.info.phase)
  }

  async accept(): Promise<void> {
    if (this.info.phase !== 'joined') return
    this.set({ phase: 'peering' })
    this.connectTimer = setTimeout(() => {
      if (this.info.phase === 'peering') this.fail(MSG.connectFailed)
    }, CONNECT_TIMEOUT_MS)
    const pc = new RTCPeerConnection(RTC_CONFIG)
    this.pc = pc
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal(this.info.id, { candidate: e.candidate.toJSON() })
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.fail(this.info.phase === 'peering' ? MSG.connectFailed : MSG.peerGone)
    }
    const dc = pc.createDataChannel('beam', { ordered: true })
    this.dc = dc
    dc.binaryType = 'arraybuffer'
    dc.onopen = () => {
      this.clearTimer()
      this.detectRoute()
      this.run().catch((err: Error) => this.fail(`Sending failed: ${err.message}`))
    }
    dc.onclose = () => {
      if (!this.finished) this.fail(MSG.peerGone)
    }
    dc.onbufferedamountlow = () => this.poke()
    dc.onmessage = (e) => {
      if (typeof e.data !== 'string') return
      try {
        this.onChannelMessage(JSON.parse(e.data) as ChannelMessage)
      } catch {
        // Not for us
      }
    }
    await pc.setLocalDescription(await pc.createOffer())
    this.signal(this.info.id, { sdp: pc.localDescription?.toJSON() })
  }

  async onSignal(data: SignalData): Promise<void> {
    const pc = this.pc
    if (!pc || this.finished) return
    if (data.sdp) {
      if (data.sdp.type === 'answer' && pc.signalingState === 'have-local-offer') {
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

  decline(): void {
    if (this.info.phase === 'joined') this.set({ phase: 'declined' })
  }

  /**
   * The receiver's signalling socket closed or it cancelled. A receiver that has just finished also
   * closes its socket, and that notice can overtake its "verified" message on the direct channel,
   * so a leg with an open channel gets a short grace period before it is counted as lost.
   */
  gone(message: string, graceMs = 0): void {
    if (this.finished) return
    if (this.info.phase === 'joined') {
      this.set({ phase: 'declined' })
    } else if (graceMs > 0 && this.dc?.readyState === 'open') {
      setTimeout(() => this.fail(message), graceMs)
    } else {
      this.fail(message)
    }
  }

  /** Called every tick to refresh numbers. Returns true if anything changed. */
  tick(): void {
    if (this.info.phase !== 'transferring' && this.info.phase !== 'verifying') return
    const bytes = Math.min(this.file.size, Math.max(this.acked, this.sent - (this.dc?.bufferedAmount ?? 0)))
    const { speed, eta } = this.speed.update(bytes)
    this.info = { ...this.info, bytes, speed, eta }
  }

  cancel(): void {
    if (this.finished) return
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify({ t: 'cancel' } satisfies ChannelMessage))
    this.fail('You cancelled this transfer.')
  }

  private async run(): Promise<void> {
    const { file, dc } = this
    if (!dc) return
    const maxMessage = this.pc?.sctp?.maxMessageSize || 64 * 1024
    const chunkSize = Math.min(MAX_CHUNK, maxMessage)
    dc.bufferedAmountLowThreshold = BUFFER_LOW

    dc.send(JSON.stringify({ t: 'meta', name: file.name, size: file.size, type: file.type } satisfies ChannelMessage))
    this.speed.start()
    this.set({ phase: 'transferring' })

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
    const sha256 = hasher.digest('hex')
    this.info = { ...this.info, result: { seconds: 0, avgSpeed: 0, sha256 } }
    if (dc.readyState === 'open') dc.send(JSON.stringify({ t: 'done', sha256 } satisfies ChannelMessage))
    this.set({ phase: 'verifying' })
  }

  private async waitForRoom(dc: RTCDataChannel): Promise<void> {
    while (dc.bufferedAmount > BUFFER_HIGH || this.sent - this.acked > FLOW_WINDOW) {
      if (this.finished) throw new Error('stopped')
      if (dc.readyState !== 'open') throw new Error('connection closed')
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
    if (this.finished) throw new Error('stopped')
  }

  private poke(): void {
    const w = this.wake
    this.wake = null
    w?.()
  }

  private onChannelMessage(msg: ChannelMessage): void {
    if (this.finished) return
    if (msg.t === 'ack') {
      this.acked = Math.max(this.acked, msg.bytes)
      this.poke()
    } else if (msg.t === 'verified') {
      if (msg.ok) this.complete()
      else this.fail(MSG.corrupt)
    } else if (msg.t === 'cancel') {
      this.fail('This device cancelled the transfer.')
    }
  }

  private complete(): void {
    const bytes = this.file.size
    const prev = this.info.result
    this.info = {
      ...this.info,
      bytes,
      speed: 0,
      eta: 0,
      result: { seconds: this.speed.elapsed(), avgSpeed: this.speed.average(bytes), sha256: prev?.sha256 ?? '' },
    }
    this.set({ phase: 'done' })
    this.close()
  }

  fail(message: string): void {
    if (this.finished) return
    this.info = { ...this.info, error: message, speed: 0 }
    this.set({ phase: 'error' })
    this.close()
  }

  close(): void {
    this.clearTimer()
    this.poke()
    const { dc, pc } = this
    // Let a final control message leave before the channel is closed
    setTimeout(() => {
      try { dc?.close() } catch { /* already closed */ }
      try { pc?.close() } catch { /* already closed */ }
    }, 500)
  }

  private clearTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
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
    }).catch(() => undefined)
  }

  private set(patch: Partial<SenderLeg>): void {
    this.info = { ...this.info, ...patch }
    this.changed()
  }
}

type SenderMessage =
  | { type: 'room_created'; pin: string; name: string }
  | { type: 'peer_joined'; id: string; name: string }
  | { type: 'peer_left'; role: 'receiver'; id: string }
  | { type: 'file_accept'; from: string }
  | { type: 'file_reject'; from: string }
  | { type: 'signal'; from: string; data: SignalData }
  | { type: 'cancel'; from: string }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string }

export class BeamSender {
  private state: SenderState = { ...INITIAL_SENDER_STATE }
  private ws: WebSocket | null = null
  private legs = new Map<string, Leg>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private file: File | null = null
  private lobby: BeamLobbyClient | null = null

  constructor(private readonly emit: (state: SenderState) => void) {}

  start(file: File, name: string): void {
    this.file = file
    this.update({ phase: 'connecting', myName: name, offer: { name: file.name || 'file', size: file.size, type: file.type } })
    let ws: WebSocket
    try {
      ws = new WebSocket(beamWsUrl(undefined, name))
    } catch {
      this.fail('Could not reach Clip Beam.')
      return
    }
    this.ws = ws
    ws.onopen = () => {
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
      this.ws = null
      if (this.state.phase === 'stopped' || this.state.phase === 'error') return
      const busy = [...this.legs.values()].some((l) => l.active)
      if (this.state.phase === 'connecting' || !busy) {
        this.fail(this.state.phase === 'connecting'
          ? 'Could not reach Clip Beam. Check your connection and try again.'
          : 'Lost the connection to Clip. No new receivers can join. Start a new Beam to share again.')
      } else {
        // Transfers already running are direct, so they carry on; only new joins are lost
        this.update({ phase: 'stopped', error: 'Lost the connection to Clip. Running transfers will finish, but nobody new can join.' })
      }
    }
  }

  /** Asks these nearby receivers to take the file. */
  invite(ids: string[]): void {
    const { offer, pin } = this.state
    if (!this.lobby || !offer || !pin || ids.length === 0) return
    this.lobby.invite(ids, offer, pin)
  }

  /** Stops sharing: cancels unfinished transfers and closes the room. */
  stop(): void {
    if (this.state.phase === 'stopped' || this.state.phase === 'error') return
    this.lobby?.cancelInvites()
    this.send({ type: 'cancel' })
    for (const leg of this.legs.values()) leg.cancel()
    this.publish()
    this.update({ phase: 'stopped' })
    this.shutdown()
  }

  cancelLeg(id: string): void {
    this.send({ type: 'cancel', to: id })
    this.legs.get(id)?.cancel()
    this.publish()
  }

  dispose(): void {
    this.disposed = true
    this.lobby?.close()
    this.lobby = null
    this.shutdown()
    for (const leg of this.legs.values()) leg.close()
  }

  private async onMessage(msg: SenderMessage): Promise<void> {
    if (this.state.phase === 'stopped' || this.state.phase === 'error') return
    switch (msg.type) {
      case 'room_created':
        this.update({ phase: 'open', pin: msg.pin, myName: msg.name || this.state.myName })
        this.startLobby(msg.name || this.state.myName)
        this.send({ type: 'file_offer', offer: this.state.offer })
        this.tickTimer = setInterval(() => this.tick(), 200)
        break
      case 'peer_joined': {
        const file = this.file
        if (!file) return
        const leg = new Leg(
          msg.id, msg.name || 'Guest', file,
          (to, data) => this.send({ type: 'signal', to, data }),
          () => this.publish(),
        )
        this.legs.set(msg.id, leg)
        this.publish()
        break
      }
      case 'peer_left':
        {
          // Gone while still connecting means the direct connection never opened, not that they dropped mid-transfer
          const leg = this.legs.get(msg.id)
          leg?.gone(leg.info.phase === 'peering' ? MSG.connectFailed : MSG.peerGone, PEER_LEFT_GRACE_MS)
        }
        this.publish()
        break
      case 'file_accept':
        await this.legs.get(msg.from)?.accept()
        break
      case 'file_reject':
        this.legs.get(msg.from)?.decline()
        break
      case 'signal':
        await this.legs.get(msg.from)?.onSignal(msg.data)
        break
      case 'cancel':
        this.legs.get(msg.from)?.gone('This device cancelled the transfer.')
        this.publish()
        break
      case 'error':
        this.fail(msg.code === 'expired'
          ? 'This Beam timed out after 10 minutes with nobody receiving. Start a new one.'
          : msg.message || 'Something went wrong.')
        break
    }
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
    const legs = [...this.legs.values()].map((l) => l.info)
    this.update({ legs })
  }

  private fail(message: string): void {
    if (this.state.phase === 'error' || this.state.phase === 'stopped') return
    for (const leg of this.legs.values()) leg.fail(message)
    this.update({ phase: 'error', error: message })
    this.shutdown()
  }

  private shutdown(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.pingTimer = null
    this.tickTimer = null
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
