/**
 * Clip Beam wire protocol: signalling messages (WebSocket via the BeamRoom Durable Object)
 * and transfer messages (RTCDataChannel, browser to browser).
 */
import { BASE } from '../lib/api'

const STUN_ONLY: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
  ],
}

let cachedConfig: { at: number; config: RTCConfiguration } | null = null
const CONFIG_TTL_MS = 10 * 60_000

/**
 * The ICE servers to use: STUN always, plus TURN relay credentials when the server has them (so two devices
 * behind strict NATs can still connect). Fetched with a short timeout and cached; any failure falls back to
 * STUN only, so connecting never waits on or breaks because of this.
 */
export async function getRtcConfig(): Promise<RTCConfiguration> {
  if (cachedConfig && Date.now() - cachedConfig.at < CONFIG_TTL_MS) return cachedConfig.config
  try {
    const res = await fetch(`${BASE}/api/beam/ice`, { signal: AbortSignal.timeout(3000), cache: 'no-store' })
    if (!res.ok) throw new Error(String(res.status))
    const json = await res.json() as { iceServers?: RTCIceServer[] }
    if (!Array.isArray(json.iceServers) || json.iceServers.length === 0) throw new Error('empty')
    cachedConfig = { at: Date.now(), config: { iceServers: json.iceServers } }
    return cachedConfig.config
  } catch {
    return STUN_ONLY
  }
}

/** Largest DataChannel message we send; capped further by what the peer advertises. */
export const MAX_CHUNK = 128 * 1024
/** Pause reading the file while this much is queued in the DataChannel... */
export const BUFFER_HIGH = 8 * 1024 * 1024
/** ...and resume once it drains below this. */
export const BUFFER_LOW = 1024 * 1024
/** Bytes the sender may have in flight beyond what the receiver says it has written to disk. */
export const FLOW_WINDOW = 32 * 1024 * 1024
/** The receiver writes to disk in batches of about this size and acks after each one. */
export const WRITE_BATCH = 4 * 1024 * 1024
/** How long the browsers get to open a direct connection after the receiver accepts. */
export const CONNECT_TIMEOUT_MS = 30_000
/** Keeps the signalling room alive (it closes after 10 idle minutes). */
export const PING_MS = 25_000
/** How often each side pings over the direct connection, and how long silence is tolerated. */
export const HEARTBEAT_MS = 5_000
export const HEARTBEAT_TIMEOUT_MS = 25_000

export interface FileOffer {
  name: string
  size: number
  type: string
}

export interface SignalData {
  sdp?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
  /** The sender is repairing the path of the existing connection (ICE restart), not starting a new one */
  restart?: boolean
}

/**
 * Control messages on the DataChannel, one connection per sender/receiver pair. Files are offered one at a
 * time; `f` is the file's number in the sender's queue. File bytes are binary messages sent between
 * `meta` and `done` and belong to the file named in `meta`.
 */
export type ChannelMessage =
  /** receiver → sender, first message: this receiver's session key, so a returning receiver is recognised */
  | { t: 'hello'; sk: string }
  /** sender → receiver: a file is available. `resume` when it is the one that was interrupted. */
  | { t: 'offer'; f: number; name: string; size: number; type: string; resume?: boolean }
  /** receiver → sender: yes, send it, starting at byte `have` (0 for a fresh file) */
  | { t: 'accept'; f: number; have: number }
  /** receiver → sender: no (declined, or this device cannot save it) */
  | { t: 'reject'; f: number; reason?: string }
  /** sender → receiver: bytes follow, starting at `start` */
  | { t: 'meta'; f: number; start: number }
  | { t: 'done'; f: number; sha256: string }
  | { t: 'ack'; f: number; bytes: number }
  | { t: 'verified'; f: number; ok: boolean }
  /** either side: stop this file, keep the connection */
  | { t: 'cancel_file'; f: number }
  /** either side: end the connection */
  | { t: 'bye' }
  /** either side: still here (answered with pong); a silent connection is treated as lost */
  | { t: 'ping' }
  | { t: 'pong' }

export function beamWsUrl(pin: string | undefined, name: string, token?: string, resume = false): string {
  let base: string
  if (BASE.startsWith('http')) {
    base = BASE.replace(/^http/, 'ws')
  } else {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    base = `${proto}//${window.location.host}`
  }
  const query = new URLSearchParams()
  if (pin) query.set('pin', pin)
  if (name) query.set('name', name)
  if (token) query.set('token', token)
  if (resume) query.set('resume', '1')
  const qs = query.toString()
  return `${base}/api/beam/ws${qs ? `?${qs}` : ''}`
}

export { formatPin, parsePin, formatBytes, formatDuration, formatEta, avatarFor } from './beamFormat'
