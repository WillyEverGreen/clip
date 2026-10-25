/**
 * Transfer speed and time remaining.
 *
 * - Speed is measured over a sliding window of recent samples, so it follows real throughput and
 *   does not lag like a long average or jitter like a per-tick reading.
 * - Time left is projected from a longer window (steadier), then kept as a countdown: each update
 *   first ticks the previous estimate down by the time that passed, then nudges it toward the new
 *   projection. That way it counts down smoothly, and still corrects itself when speed changes.
 * - Measuring starts when the first byte arrives, not when the connection opens, so the idle
 *   lead-in (hashing set-up, buffers filling) does not drag the early estimates down.
 * - Nothing is reported until enough data has arrived to mean something.
 */

export const SPEED_WINDOW_MS = 3000
export const ETA_WINDOW_MS = 6000
/** Minimum time and bytes before a speed or ETA is shown. */
const MIN_SAMPLE_MS = 1500
/** How strongly each update pulls the countdown toward the fresh projection (0..1). */
const ETA_PULL = 0.25

interface Sample {
  t: number
  bytes: number
}

export class SpeedTracker {
  private samples: Sample[] = []
  private startTime = 0
  private startBytes = 0
  private lastUpdate = 0
  private firstByteAt: number | null = null
  private etaSeconds: number | null = null
  private readonly total: number

  constructor(total: number) {
    this.total = total
  }

  start(now = performance.now(), bytes = 0): void {
    this.startTime = now
    this.startBytes = bytes
    this.lastUpdate = now
    this.samples = [{ t: now, bytes }]
    this.firstByteAt = null
    this.etaSeconds = null
  }

  /** Feed the running byte count; returns bytes/second and seconds left (Infinity while unknown). */
  update(bytes: number, now = performance.now()): { speed: number; eta: number } {
    const last = this.samples[this.samples.length - 1]
    if (this.firstByteAt === null && bytes > this.startBytes) {
      // Drop the idle lead-in: measure from the last sample taken before any data arrived
      this.firstByteAt = last ? last.t : now
      this.samples = last ? [last] : []
    }
    // Never go backwards in time or bytes (a stalled sender can re-report the same count)
    if (!last || now > last.t) this.samples.push({ t: now, bytes: Math.max(bytes, last?.bytes ?? 0) })
    const cutoff = now - ETA_WINDOW_MS
    while (this.samples.length > 2 && this.samples[1].t < cutoff) this.samples.shift()

    const speed = this.rate(now, SPEED_WINDOW_MS)
    const longRate = this.rate(now, ETA_WINDOW_MS)
    const remaining = Math.max(0, this.total - bytes)

    if (remaining === 0) {
      this.etaSeconds = 0
    } else if (longRate > 0 && this.firstByteAt !== null && now - this.firstByteAt >= MIN_SAMPLE_MS) {
      const projected = remaining / longRate
      if (this.etaSeconds === null) {
        this.etaSeconds = projected
      } else {
        const ticked = Math.max(0, this.etaSeconds - (now - this.lastUpdate) / 1000)
        this.etaSeconds = ticked + ETA_PULL * (projected - ticked)
      }
    } else if (longRate === 0 && this.etaSeconds !== null) {
      this.etaSeconds = null // stalled: say so instead of counting down a number that is no longer true
    }
    this.lastUpdate = now
    return { speed, eta: this.etaSeconds ?? Infinity }
  }

  /** Average speed since the first byte arrived. */
  average(bytes: number, now = performance.now()): number {
    const secs = (now - (this.firstByteAt ?? this.startTime)) / 1000
    return secs > 0 ? (bytes - this.startBytes) / secs : 0
  }

  elapsed(now = performance.now()): number {
    return (now - this.startTime) / 1000
  }

  /** Bytes per second across the samples inside `windowMs`. */
  private rate(now: number, windowMs: number): number {
    const newest = this.samples[this.samples.length - 1]
    if (!newest) return 0
    const from = now - windowMs
    let oldest = this.samples[0]
    for (const s of this.samples) {
      if (s.t >= from) {
        oldest = s
        break
      }
      oldest = s
    }
    const dt = (newest.t - oldest.t) / 1000
    if (dt < MIN_SAMPLE_MS / 1000 / 2) return 0
    return Math.max(0, (newest.bytes - oldest.bytes) / dt)
  }
}
