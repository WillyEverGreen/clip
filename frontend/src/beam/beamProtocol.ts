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

/** Server → client over the signalling WebSocket. */
export type ServerMessage =
  | { type: 'room_created'; pin: string }
  | { type: 'joined'; offer: FileOffer | null }
  | { type: 'peer_joined' }
  | { type: 'peer_left'; role: 'sender' | 'receiver' }
  | { type: 'file_offer'; offer: FileOffer }
  | { type: 'file_accept' }
  | { type: 'file_reject' }
  | { type: 'signal'; data: SignalData }
  | { type: 'transfer_complete' }
  | { type: 'cancel' }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string }

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

export function beamWsUrl(pin?: string): string {
  let base: string
  if (BASE.startsWith('http')) {
    base = BASE.replace(/^http/, 'ws')
  } else {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    base = `${proto}//${window.location.host}`
  }
  return `${base}/api/beam/ws${pin ? `?pin=${pin}` : ''}`
}

export function formatPin(pin: string): string {
  return pin.length === 6 ? `${pin.slice(0, 3)}-${pin.slice(3)}` : pin
}

/** Pulls the six digits out of whatever was typed or pasted ("748 219", "748-219", a /beam?pin= link). */
export function parsePin(input: string): string | null {
  const fromLink = input.match(/[?&]pin=(\d{6})/)
  if (fromLink) return fromLink[1]
  const digits = input.replace(/\D/g, '')
  return digits.length === 6 ? digits : null
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : v < 10 ? 2 : 1)} ${units[i]}`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--'
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
