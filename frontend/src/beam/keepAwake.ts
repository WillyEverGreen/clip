/**
 * Keeps the screen from sleeping while a Beam is connected (best effort).
 *
 * A phone or laptop that dozes off drops its network, which is the most common way a long transfer
 * breaks. Where the browser offers a screen wake lock we hold one while connected, and take it again
 * when the tab comes back to the front (the browser releases it whenever the tab is hidden). Where it
 * does not, this does nothing and the transfer carries on as normal.
 */
interface WakeLockSentinelLike {
  release(): Promise<void>
}

export class KeepAwake {
  private lock: WakeLockSentinelLike | null = null
  private wanted = false

  start(): void {
    if (this.wanted) return
    this.wanted = true
    document.addEventListener('visibilitychange', this.onVisible)
    void this.acquire()
  }

  stop(): void {
    this.wanted = false
    document.removeEventListener('visibilitychange', this.onVisible)
    const lock = this.lock
    this.lock = null
    if (lock) lock.release().catch(() => undefined)
  }

  private onVisible = (): void => {
    if (this.wanted && document.visibilityState === 'visible') void this.acquire()
  }

  private async acquire(): Promise<void> {
    try {
      const nav = navigator as unknown as { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> } }
      if (!nav.wakeLock || this.lock) return
      this.lock = await nav.wakeLock.request('screen')
      if (!this.wanted) await this.lock.release().catch(() => undefined)
    } catch {
      // Not allowed (low battery, no permission, unsupported): carry on without it
      this.lock = null
    }
  }
}
