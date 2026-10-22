/** Smoothed transfer speed (exponential moving average) and time remaining. */
export class SpeedTracker {
  private lastTime = 0
  private lastBytes = 0
  private ema = 0
  private startTime = 0

  constructor(private readonly total: number, private readonly alpha = 0.3) {}

  start(now = performance.now()): void {
    this.startTime = now
    this.lastTime = now
    this.lastBytes = 0
    this.ema = 0
  }

  /** Feed the running byte count; returns bytes/second and seconds left. */
  update(bytes: number, now = performance.now()): { speed: number; eta: number } {
    const dt = (now - this.lastTime) / 1000
    if (dt >= 0.25) {
      const instant = (bytes - this.lastBytes) / dt
      this.ema = this.ema === 0 ? instant : this.alpha * instant + (1 - this.alpha) * this.ema
      this.lastTime = now
      this.lastBytes = bytes
    }
    const eta = this.ema > 0 ? (this.total - bytes) / this.ema : Infinity
    return { speed: this.ema, eta }
  }

  /** Average speed since start(). */
  average(bytes: number, now = performance.now()): number {
    const secs = (now - this.startTime) / 1000
    return secs > 0 ? bytes / secs : 0
  }

  elapsed(now = performance.now()): number {
    return (now - this.startTime) / 1000
  }
}
