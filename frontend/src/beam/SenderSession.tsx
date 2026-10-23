import { lazy, Suspense, useEffect, useRef, useState, type DragEvent } from 'react'
import { Check, ChevronDown, Copy, File as FileIcon, Plus, QrCode, RotateCcw, Send, ShieldCheck, TriangleAlert, Users, X } from 'lucide-react'
import { copyToClipboard } from '../lib/clipboard'
import { formatBytes, formatDuration, formatPin } from './beamProtocol'
import { Person, Progress } from './BeamBits'
import Radar from './Radar'
import type { LegTransfer, SenderLeg, SenderState } from './beamSender'

const QRCodeSVG = lazy(() =>
  import('qrcode.react').then(m => ({ default: m.QRCodeSVG }))
)

export interface SenderActions {
  onAddFiles: (files: File[]) => void
  onStop: () => void
  onCancelFile: (legId: string, f: number) => void
  onDisconnect: (legId: string) => void
  onDismiss: (legId: string) => void
  onReset: () => void
  onInvite: (ids: string[]) => void
  onReconnect: () => void
}

const IN_FLIGHT: LegTransfer['status'][] = ['offered', 'transferring', 'verifying']

/** The sender's whole session: files queued, people nearby, the PIN, and every connected receiver. */
export default function SenderSession({ state, actions }: { state: SenderState; actions: SenderActions }) {
  const { phase, legs, files } = state

  if (phase === 'error') {
    return (
      <div className="beam-result is-error" role="alert">
        <TriangleAlert size={32} />
        <h2>Beam closed</h2>
        <p className="beam-error-text">{state.error}</p>
        <button type="button" className="btn btn-primary" onClick={actions.onReset}><RotateCcw size={16} /> Start over</button>
      </div>
    )
  }

  const open = phase === 'open'
  const sentCount = legs.reduce((n, l) => n + l.transfers.filter(t => t.status === 'done').length, 0)

  return (
    <div className="beam-session" data-sender-session={phase}>
      <div className="beam-grid">
        <div className="beam-col">
          <FileQueue state={state} canAdd={open || phase === 'connecting'} onAdd={actions.onAddFiles} />

          {state.connection === 'reconnecting' && open && (
            <div className="beam-banner" role="status" data-testid="beam-sender-reconnecting">
              <span><span className="beam-dot" /> Lost the connection to Clip. Reconnecting... Connections already open keep going.</span>
              <button type="button" className="btn btn-ghost" onClick={actions.onReconnect}><RotateCcw size={15} /> Reconnect now</button>
            </div>
          )}

          {phase === 'connecting' && <p className="beam-status"><span className="beam-dot" /> Opening a Beam room...</p>}

          {phase === 'stopped' && (
            <div className="beam-panel beam-stopped" role="status">
              <p className="beam-muted beam-center">
                {state.error ?? 'Sharing stopped.'} {sentCount > 0 && `${sentCount} ${sentCount === 1 ? 'file was' : 'files were'} delivered.`}
              </p>
              <div className="beam-actions">
                <button type="button" className="btn btn-primary" onClick={actions.onReset}><RotateCcw size={16} /> Send another file</button>
              </div>
            </div>
          )}

          <section className="beam-panel" aria-label="Receivers">
            <div className="beam-panel-title">
              <Users size={15} /> Receivers <span className="beam-count">{legs.length}</span>
              {legs.length > 0 && <span className="beam-muted beam-panel-note">{legs.filter(l => l.phase === 'connected').length} online</span>}
            </div>
            {legs.length > 0 ? (
              <ul className="beam-legs">
                {legs.map(leg => <LegCard key={leg.id} leg={leg} actions={actions} />)}
              </ul>
            ) : (
              open && <p className="beam-status"><span className="beam-dot" /> Waiting for someone to connect. Pick people on the radar, or share the PIN.</p>
            )}
          </section>
        </div>

        {(open || phase === 'connecting') && (
          <div className="beam-col">
            {state.myName && phase !== 'connecting' && (
              <p className="beam-who">Sharing as <Person name={state.myName} you /></p>
            )}
            {open && state.pin && <PinShare pin={state.pin} count={legs.length} />}
            {open && <NearbySection state={state} onInvite={actions.onInvite} />}
            {open && files.length > 0 && legs.some(l => l.transfers.some(t => IN_FLIGHT.includes(t.status))) && (
              <p className="beam-hint beam-center">Keep this tab open while files are sending. You can add more files at any time.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── The queue of files ──────────────────────────────────────────────────────

function FileQueue({ state, canAdd, onAdd }: { state: SenderState; canAdd: boolean; onAdd: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const total = state.files.reduce((n, f) => n + f.size, 0)

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (canAdd) onAdd([...e.dataTransfer.files])
  }

  return (
    <div
      className={`beam-panel beam-queue${dragging ? ' is-dragging' : ''}`}
      data-file-count={state.files.length}
      onDragOver={(e) => { if (canAdd) { e.preventDefault(); setDragging(true) } }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="beam-queue-head">
        <span className="beam-panel-title"><FileIcon size={15} /> Files to send <span className="beam-count">{state.files.length}</span><span className="beam-muted beam-panel-note">{formatBytes(total)}</span></span>
        {canAdd && (
          <button type="button" className="btn btn-ghost beam-add" onClick={() => inputRef.current?.click()}>
            <Plus size={15} /> Add files
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          multiple
          className="beam-hidden-input"
          aria-label="Add more files to send"
          data-testid="beam-add-input"
          onChange={(e) => { onAdd([...(e.target.files ?? [])]); e.target.value = '' }}
        />
      </div>
      <ul className="beam-queue-list">
        {state.files.map((f) => {
          const done = state.legs.filter(l => l.transfers.some(t => t.f === f.id && t.status === 'done')).length
          return (
            <li key={f.id} className="beam-queue-item" data-file={f.name}>
              <FileIcon size={16} />
              <span className="beam-file-name">{f.name}</span>
              <span className="beam-muted">{formatBytes(f.size)}</span>
              {done > 0 && <span className="beam-tag">Sent to {done}</span>}
            </li>
          )
        })}
      </ul>
      {canAdd && <p className="beam-hint beam-center">Drop more files here at any time. They are offered to everyone connected.</p>}
    </div>
  )
}

// ── One receiver ────────────────────────────────────────────────────────────

function legLabel(leg: SenderLeg): string {
  switch (leg.phase) {
    case 'connecting': return 'Connecting...'
    case 'connected': return leg.transfers.length === 0 ? 'Connected' : 'Connected'
    case 'paused': return 'Connection lost. Waiting for them to reconnect and carry on...'
    case 'ended': return leg.endedBy === 'you' ? 'You ended the connection' : 'They ended the connection'
    case 'error': return leg.error ?? 'Failed'
  }
}

function LegCard({ leg, actions }: { leg: SenderLeg; actions: SenderActions }) {
  const active = leg.transfers.find(t => IN_FLIGHT.includes(t.status))
  const past = leg.transfers.filter(t => !IN_FLIGHT.includes(t.status))
  const live = leg.phase === 'connected' || leg.phase === 'paused' || leg.phase === 'connecting'
  return (
    <li className={`beam-leg is-${leg.phase}`} data-leg-phase={leg.phase} data-leg-id={leg.id}>
      <div className="beam-leg-head">
        <span className="beam-leg-name"><Person name={leg.name} /></span>
        <span className="beam-leg-status">{legLabel(leg)}</span>
        {leg.route && leg.phase === 'connected' && <span className="beam-tag">{leg.route}</span>}
        {live ? (
          <button type="button" className="beam-leg-cancel" onClick={() => actions.onDisconnect(leg.id)} aria-label={`Disconnect ${leg.name}`} title="End the connection with this person">
            <X size={14} />
          </button>
        ) : (
          <button type="button" className="beam-leg-cancel" onClick={() => actions.onDismiss(leg.id)} aria-label={`Dismiss ${leg.name}`} title="Remove this row">
            <X size={14} />
          </button>
        )}
      </div>

      {active && (
        <div className="beam-active-file" data-transfer-status={active.status} data-transfer-file={active.name}>
          <div className="beam-active-file-head">
            <span className="beam-file-name">{active.name}</span>
            <span className="beam-muted">{formatBytes(active.size)}</span>
            {leg.phase !== 'paused' && (
              <button type="button" className="beam-leg-cancel" onClick={() => actions.onCancelFile(leg.id, active.f)} aria-label={`Cancel ${active.name} for ${leg.name}`} title="Stop this file; the connection stays open">
                <X size={14} />
              </button>
            )}
          </div>
          {active.status === 'offered' && <p className="beam-muted">{leg.phase === 'paused' ? 'Will continue when they reconnect.' : `Waiting for ${leg.name} to accept...`}</p>}
          {active.resumedFrom > 0 && (
            <div className="beam-muted beam-leg-done" data-testid="beam-resumed-note"><RotateCcw size={13} /> Continued from {formatBytes(active.resumedFrom)} after a dropped connection</div>
          )}
          {(active.status === 'transferring' || active.status === 'verifying') && (
            <Progress bytes={active.bytes} total={active.size} speed={active.speed} eta={active.eta} verifying={active.status === 'verifying'} route={null} />
          )}
        </div>
      )}

      {past.length > 0 && (
        <ul className="beam-hist" aria-label={`Files for ${leg.name}`}>
          {past.map(t => <HistoryRow key={t.f} t={t} />)}
        </ul>
      )}

      {leg.phase === 'connected' && !active && leg.transfers.length > 0 && past.every(t => t.status === 'done') && (
        <p className="beam-muted beam-leg-done"><ShieldCheck size={13} /> All sent and verified. Add more files any time.</p>
      )}
    </li>
  )
}

function HistoryRow({ t }: { t: LegTransfer }) {
  const text = t.status === 'done'
    ? `Delivered and verified${t.result ? ` · ${formatDuration(t.result.seconds)} at ${formatBytes(t.result.avgSpeed)}/s` : ''}`
    : t.status === 'declined' ? 'Declined'
    : t.status === 'cancelled' ? (t.error ?? 'Cancelled')
    : (t.error ?? 'Failed')
  return (
    <li className={`beam-hist-row is-${t.status}`} data-hist-status={t.status} data-hist-file={t.name}>
      {t.status === 'done' ? <Check size={13} /> : <X size={13} />}
      <span className="beam-hist-name">{t.name}</span>
      <span className="beam-muted beam-hist-text">{text}</span>
    </li>
  )
}

// ── People nearby and the PIN ───────────────────────────────────────────────

/** People on the same network who switched on Receive mode, as a radar. Pick one or several and ask. */
function NearbySection({ state, onInvite }: { state: SenderState; onInvite: (ids: string[]) => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const legNames = new Set(state.legs.filter(l => l.phase !== 'ended' && l.phase !== 'error').map((l) => l.name))
  const connected = new Set(state.nearby.filter((p) => legNames.has(p.name)).map((p) => p.id))
  // Forget selections for people who left the radar
  useEffect(() => {
    setSelected((cur) => {
      const ids = new Set(state.nearby.map((p) => p.id))
      const next = new Set([...cur].filter((id) => ids.has(id)))
      return next.size === cur.size ? cur : next
    })
  }, [state.nearby])

  const pickable = state.nearby.filter((p) => !connected.has(p.id) && p.status !== 'invited' && p.status !== 'accepted')
  const toggle = (id: string) => setSelected((cur) => {
    const next = new Set(cur)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const send = () => {
    onInvite([...selected])
    setSelected(new Set())
  }

  return (
    <details className="beam-panel beam-nearby" data-nearby-count={state.nearby.length} open>
      <summary className="beam-nearby-head">
        <span className="beam-panel-title"><Send size={15} /> Connect to people nearby <span className="beam-lan">Same network</span></span>
        <span className="beam-muted">
          {state.nearbyStatus === 'offline' ? 'Discovery is offline' : state.nearby.length === 0 ? 'Looking...' : `${state.nearby.length} ${state.nearby.length === 1 ? 'person' : 'people'} here`}
        </span>
        <ChevronDown size={16} className="beam-chevron" aria-hidden="true" />
      </summary>
      <p className="beam-hint">For people on the same Wi-Fi or LAN as you. They show up here on their own, and you can use the PIN or QR code too. Anywhere else, share the PIN or QR code above.</p>
      <Radar people={state.nearby} selected={selected} connected={connected} onToggle={toggle} />
      {state.nearby.length === 0 ? (
        <p className="beam-hint beam-center">Nobody yet. Ask people on your network to open clip.foo.ng/beam and switch on &quot;Show me to nearby senders&quot;. They never need a PIN: you pick them, they tap Accept.</p>
      ) : (
        <div className="beam-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setSelected(new Set(pickable.map((p) => p.id)))} disabled={pickable.length === 0}>Select all</button>
          <button type="button" className="btn btn-primary" onClick={send} disabled={selected.size === 0}>
            <Send size={15} /> Send to {selected.size || ''} {selected.size === 1 ? 'person' : selected.size > 1 ? 'people' : 'selected'}
          </button>
        </div>
      )}
    </details>
  )
}

function PinShare({ pin, count }: { pin: string; count: number }) {
  const [copied, setCopied] = useState<'pin' | 'link' | null>(null)
  const [showQr, setShowQr] = useState(true)
  const link = `${window.location.origin}/beam?pin=${pin}`
  const copy = async (what: 'pin' | 'link') => {
    if (await copyToClipboard(what === 'pin' ? pin : link)) {
      setCopied(what)
      setTimeout(() => setCopied(null), 1500)
    }
  }
  return (
    <div className="beam-panel beam-pin-share">
      <span className="beam-panel-title"><QrCode size={15} /> Share a PIN or QR code (up to 8 people, anywhere)</span>
      <div className="beam-pin" data-testid="beam-pin" aria-label={`PIN ${pin.split('').join(' ')}`}>{formatPin(pin)}</div>
      <div className="beam-actions">
        <button type="button" className="btn btn-ghost" onClick={() => copy('pin')}>
          {copied === 'pin' ? <Check size={15} /> : <Copy size={15} />} Copy PIN
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => copy('link')}>
          {copied === 'link' ? <Check size={15} /> : <Copy size={15} />} Copy link
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setShowQr(v => !v)} aria-expanded={showQr}>
          <QrCode size={15} /> QR code
        </button>
      </div>
      {showQr && (
        <div className="beam-qr">
          <Suspense fallback={<div className="spinner" />}>
            <QRCodeSVG value={link} size={168} level="M" />
          </Suspense>
        </div>
      )}
      <p className="beam-hint">
        {count === 0
          ? 'The PIN expires after 10 minutes without anyone connecting. It stays valid while you keep sharing.'
          : `${count} ${count === 1 ? 'person has' : 'people have'} connected. The PIN stays valid until you stop sharing.`}
      </p>
    </div>
  )
}
