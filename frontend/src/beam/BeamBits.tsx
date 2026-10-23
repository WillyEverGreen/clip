import { colorForId } from '../lib/cuteNames'
import { avatarFor, formatBytes, formatEta } from './beamProtocol'

/** A person's cute name with their avatar, the same pairing Live Pad uses for cursors. */
export function Person({ name, you }: { name: string; you?: boolean }) {
  return (
    <span className="beam-person" data-person={name}>
      <span className="beam-person-dot" style={{ background: `${colorForId(name)}33`, borderColor: colorForId(name) }} aria-hidden="true">{avatarFor(name)}</span>
      <span className="beam-person-name">{name}</span>
      {you && <span className="beam-person-you">you</span>}
    </span>
  )
}

/** Progress bar with speed and time left, shared by the sender's rows and the receiver's screen. */
export function Progress({ bytes, total, speed, eta, verifying, route }: {
  bytes: number; total: number; speed: number; eta: number; verifying: boolean; route: string | null
}) {
  const pct = total > 0 ? Math.min(100, (bytes / total) * 100) : 100
  return (
    <div className="beam-progress">
      <div
        className="beam-bar"
        role="progressbar"
        aria-label="Transfer progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.floor(pct)}
      >
        <div className="beam-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="beam-stats">
        <span className="beam-pct">{pct.toFixed(pct < 10 ? 1 : 0)}%</span>
        <span>{formatBytes(bytes)} of {formatBytes(total)}</span>
      </div>
      <div className="beam-stats beam-muted">
        <span data-testid="beam-speed" data-bytes-per-sec={Math.round(speed)}>{speed > 0 ? `${formatBytes(speed)}/s` : 'Measuring speed...'}</span>
        <span data-testid="beam-eta" data-seconds={Number.isFinite(eta) ? eta.toFixed(1) : ''}>{verifying ? 'Checking...' : formatEta(eta)}</span>
      </div>
      {route && <div className="beam-route">{route}</div>}
    </div>
  )
}
