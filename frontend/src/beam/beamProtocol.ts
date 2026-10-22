/**
 * Clip Beam wire protocol: signalling messages (WebSocket via the BeamRoom Durable Object)
 * and transfer messages (RTCDataChannel, browser to browser).
 */
import { BASE } from '../lib/api'

export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
  ],
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

export interface FileOffer {
  name: string
  size: number
  type: string
}

export interface SignalData {
  sdp?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

/** Control messages on the DataChannel. File bytes are sent as binary messages in between. */
export type ChannelMessage =
  | { t: 'meta'; name: string; size: number; type: string }
  | { t: 'done'; sha256: string }
  | { t: 'ack'; bytes: number }
  | { t: 'verified'; ok: boolean }
  | { t: 'cancel' }

export function beamWsUrl(pin: string | undefined, name: string): string {
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
  const qs = query.toString()
  return `${base}/api/beam/ws${qs ? `?${qs}` : ''}`
}

export { formatPin, parsePin, formatBytes, formatDuration, formatEta } from './beamFormat'
