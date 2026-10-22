import { lazy, Suspense, useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowDownToLine, Check, Copy, File as FileIcon, QrCode, Radio, RotateCcw, Send, ShieldCheck, TriangleAlert, Upload, Users, X } from 'lucide-react'
import Logo from '../components/Logo'
import { useSeo } from '../lib/useSeo'
import { colorForId } from '../lib/cuteNames'
import { copyToClipboard } from '../lib/clipboard'
import { useBeam } from './useBeam'
import { canStreamToDisk, MEMORY_LIMIT } from './diskWriter'
import { formatBytes, formatDuration, formatEta, formatPin, parsePin } from './beamProtocol'
import type { SenderLeg, SenderState } from './beamSender'
import type { ReceiverState } from './beamReceiver'
import './beam.css'

const QRCodeSVG = lazy(() =>
  import('qrcode.react').then(m => ({ default: m.QRCodeSVG }))
)

/** One word for the whole page that tests and styles can key off. */
function summarisePhase(role: 'sender' | 'receiver' | null, sender: SenderState, receiver: ReceiverState): string {
  if (role === 'receiver') return receiver.phase
  if (role !== 'sender') return 'idle'
  if (sender.phase === 'error' || sender.phase === 'connecting') return sender.phase
  const legs = sender.legs
  if (legs.length === 0) return sender.phase === 'open' ? 'waiting' : sender.phase
  const has = (p: SenderLeg['phase']) => legs.some(l => l.phase === p)
  if (has('transferring')) return 'transferring'
  if (has('verifying')) return 'verifying'
  if (has('peering')) return 'peering'
  if (has('joined')) return 'joined'
  if (legs.every(l => l.phase === 'done')) return 'done'
  if (legs.every(l => l.phase === 'declined')) return 'rejected'
  if (has('error')) return 'error'
  return sender.phase
}

export default function BeamPage() {
  useSeo({
    title: 'Clip Beam - Send big files browser to browser',
    description: 'Send files of any size straight from one browser to another over an encrypted peer-to-peer connection. Nothing is uploaded.',
    canonicalUrl: 'https://clip.foo.ng/beam',
  })

  const beam = useBeam()
  const { role, sender, receiver } = beam
  const [searchParams, setSearchParams] = useSearchParams()
  const autoJoined = useRef(false)

  // Opening a /beam?pin=123456 link (from the QR code) joins straight away
  useEffect(() => {
    if (autoJoined.current) return
    const pin = parsePin(searchParams.get('pin') ?? '')
    if (pin) {
      autoJoined.current = true
      beam.join(pin)
      setSearchParams({}, { replace: true })
    }
  }, [searchParams, beam, setSearchParams])

  // Closing the tab kills the transfer, so ask first
  const busy = role === 'sender'
    ? sender.legs.some(l => l.phase === 'peering' || l.phase === 'transferring' || l.phase === 'verifying')
    : role === 'receiver' && ['transferring', 'verifying', 'peering'].includes(receiver.phase)
  useEffect(() => {
    if (!busy) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [busy])

  return (
    <div className="beam-page" data-beam-phase={summarisePhase(role, sender, receiver)} data-beam-role={role ?? ''}>
      <nav className="beam-nav">
        <Logo size="sm" />
        <span className="beam-nav-tag">Beam</span>
        <Link to="/" className="beam-nav-link">Back to Clip</Link>
      </nav>

      <main className="beam-main">
        <header className="beam-header">
          <h1>Clip Beam</h1>
          <p>Send big files straight from one browser to another. Nothing is uploaded: the file streams over an encrypted peer-to-peer connection while both tabs stay open.</p>
        </header>

        {role === null ? (
          <StartPanels onSend={beam.send} onJoin={beam.join} />
        ) : (
          <section className="beam-card" aria-live="polite">
            {role === 'sender'
              ? <SenderPanel state={sender} onStop={beam.stopSharing} onCancelLeg={beam.cancelLeg} onReset={beam.reset} />
              : <ReceiverPanel state={receiver} onAccept={beam.accept} onDecline={beam.decline} onCancel={beam.cancelReceive} onReset={beam.reset} />}
          </section>
        )}

        <ul className="beam-facts">
          <li><Radio size={13} /> Peer to peer, no size cap in Chrome and Edge</li>
          <li><Users size={13} /> Up to 8 receivers per file</li>
          <li><ShieldCheck size={13} /> DTLS encrypted, SHA-256 checked</li>
          <li><X size={13} /> Nothing stored on Clip servers</li>
        </ul>
      </main>
    </div>
  )
}

// ── Landing: send or receive ────────────────────────────────────────────────

function StartPanels({ onSend, onJoin }: { onSend: (f: File) => void; onJoin: (pin: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [pinText, setPinText] = useState('')
  const [pinError, setPinError] = useState('')

  const pick = (files: FileList | null) => {
    const file = files?.[0]
    if (file) onSend(file)
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    pick(e.dataTransfer.files)
  }
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    const pin = parsePin(pinText)
    if (!pin) {
      setPinError('Enter the 6-digit PIN shown on the sending device.')
      return
    }
    onJoin(pin)
  }

  return (
    <div className="beam-start">
      <section className="beam-card">
        <h2><Send size={18} /> Send a file</h2>
        <button
          type="button"
          className={`beam-drop${dragging ? ' is-dragging' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <Upload size={28} />
          <span className="beam-drop-title">Drop a file here</span>
          <span className="beam-drop-sub">or click to choose. Any size.</span>
        </button>
        <input
          ref={inputRef}
          type="file"
          className="beam-hidden-input"
          aria-label="Choose a file to send"
          onChange={(e) => pick(e.target.files)}
        />
      </section>

      <section className="beam-card">
        <h2><ArrowDownToLine size={18} /> Receive a file</h2>
        <form className="beam-join" onSubmit={onSubmit}>
          <label className="label" htmlFor="beam-pin">PIN from the sender</label>
          <input
            id="beam-pin"
            className="input beam-pin-input"
            inputMode="numeric"
            autoComplete="off"
            placeholder="000-000"
            maxLength={40}
            value={pinText}
            onChange={(e) => { setPinText(e.target.value); setPinError('') }}
          />
          {pinError && <p className="error-msg">{pinError}</p>}
          <button type="submit" className="btn btn-primary btn-full">Connect</button>
        </form>
        <p className="beam-hint">
          {canStreamToDisk()
            ? 'Files are written straight to disk as they arrive.'
            : `This browser keeps the file in memory until it finishes, so it can receive up to ${formatBytes(MEMORY_LIMIT)}. Use Chrome or Edge for bigger files.`}
        </p>
      </section>
    </div>
  )
}

// ── Sender ──────────────────────────────────────────────────────────────────

interface SenderPanelProps {
  state: SenderState
  onStop: () => void
  onCancelLeg: (id: string) => void
  onReset: () => void
}

function SenderPanel({ state, onStop, onCancelLeg, onReset }: SenderPanelProps) {
  const { phase, offer, legs } = state

  if (phase === 'error') {
    return (
      <div className="beam-result is-error" role="alert">
        <TriangleAlert size={32} />
        <h2>Transfer failed</h2>
        <p className="beam-error-text">{state.error}</p>
        {offer && <p className="beam-muted">{offer.name} · {formatBytes(offer.size)}</p>}
        <button type="button" className="btn btn-primary" onClick={onReset}><RotateCcw size={16} /> Start over</button>
      </div>
    )
  }

  const open = phase === 'open'
  const done = legs.filter(l => l.phase === 'done').length

  return (
    <div className="beam-active">
      {offer && (
        <div className="beam-file">
          <FileIcon size={22} />
          <div>
            <div className="beam-file-name">{offer.name}</div>
            <div className="beam-muted">{formatBytes(offer.size)}{offer.type ? ` · ${offer.type}` : ''}</div>
          </div>
        </div>
      )}

      {state.myName && phase !== 'connecting' && (
        <p className="beam-who">Sharing as <Person name={state.myName} you /></p>
      )}

      {open && state.pin && <PinShare pin={state.pin} count={legs.length} />}
      {phase === 'connecting' && <p className="beam-status"><span className="beam-dot" /> Opening a Beam room...</p>}
      {phase === 'stopped' && (
        <p className="beam-muted" role="status">
          {state.error ?? 'Sharing stopped.'} {done > 0 && `${done} ${done === 1 ? 'receiver' : 'receivers'} got the file.`}
        </p>
      )}

      {legs.length > 0 && (
        <ul className="beam-legs" aria-label="Receivers">
          {legs.map(leg => <LegRow key={leg.id} leg={leg} size={offer?.size ?? 0} onCancel={() => onCancelLeg(leg.id)} />)}
        </ul>
      )}

      {open && legs.length === 0 && <p className="beam-status"><span className="beam-dot" /> Waiting for a receiver to enter the PIN...</p>}

      <div className="beam-actions">
        {open
          ? <button type="button" className="btn btn-danger" onClick={onStop}><X size={16} /> Stop sharing</button>
          : <button type="button" className="btn btn-primary" onClick={onReset}><RotateCcw size={16} /> Send another file</button>}
      </div>
      {open && legs.some(l => l.phase === 'transferring' || l.phase === 'peering') && (
        <p className="beam-hint">Keep this tab open until every transfer finishes.</p>
      )}
    </div>
  )
}

/** A person's cute name with their colour dot, the same pairing Live Pad uses for cursors. */
function Person({ name, you }: { name: string; you?: boolean }) {
  return (
    <span className="beam-person" data-person={name}>
      <span className="beam-person-dot" style={{ background: colorForId(name) }} aria-hidden="true" />
      <span className="beam-person-name">{name}</span>
      {you && <span className="beam-person-you">you</span>}
    </span>
  )
}

function legStatus(leg: SenderLeg): string {
  switch (leg.phase) {
    case 'joined': return 'Looking at the file...'
    case 'peering': return 'Opening a direct connection...'
    case 'transferring': return 'Sending'
    case 'verifying': return 'Receiver is checking the file...'
    case 'done': return 'Received and verified'
    case 'declined': return 'Declined or left'
    case 'error': return leg.error ?? 'Failed'
  }
}

function LegRow({ leg, size, onCancel }: { leg: SenderLeg; size: number; onCancel: () => void }) {
  const live = leg.phase === 'transferring' || leg.phase === 'verifying'
  const finished = leg.phase === 'done' || leg.phase === 'declined' || leg.phase === 'error'
  return (
    <li className={`beam-leg is-${leg.phase}`} data-leg-phase={leg.phase} data-leg-id={leg.id}>
      <div className="beam-leg-head">
        <span className="beam-leg-name"><Person name={leg.name} /></span>
        <span className="beam-leg-status">{legStatus(leg)}</span>
        {!finished && (
          <button type="button" className="beam-leg-cancel" onClick={onCancel} aria-label={`Cancel transfer to ${leg.name}`}>
            <X size={14} />
          </button>
        )}
      </div>
      {live && <Progress bytes={leg.bytes} total={size} speed={leg.speed} eta={leg.eta} verifying={leg.phase === 'verifying'} route={leg.route} />}
      {leg.phase === 'done' && leg.result && (
        <div className="beam-muted beam-leg-done">
          <ShieldCheck size={14} /> Verified · {formatDuration(leg.result.seconds)} at {formatBytes(leg.result.avgSpeed)}/s average
        </div>
      )}
    </li>
  )
}

function PinShare({ pin, count }: { pin: string; count: number }) {
  const [copied, setCopied] = useState<'pin' | 'link' | null>(null)
  const [showQr, setShowQr] = useState(false)
  const link = `${window.location.origin}/beam?pin=${pin}`
  const copy = async (what: 'pin' | 'link') => {
    if (await copyToClipboard(what === 'pin' ? pin : link)) {
      setCopied(what)
      setTimeout(() => setCopied(null), 1500)
    }
  }
  return (
    <div className="beam-pin-share">
      <span className="label">Share this PIN with up to 8 receivers</span>
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
          ? 'The PIN expires after 10 minutes without a receiver. It stays valid while you keep sharing.'
          : `${count} ${count === 1 ? 'receiver has' : 'receivers have'} joined. The PIN stays valid until you stop sharing.`}
      </p>
    </div>
  )
}

// ── Receiver ────────────────────────────────────────────────────────────────

interface ReceiverPanelProps {
  state: ReceiverState
  onAccept: () => void
  onDecline: () => void
  onCancel: () => void
  onReset: () => void
}

function ReceiverPanel({ state, onAccept, onDecline, onCancel, onReset }: ReceiverPanelProps) {
  const { phase, offer } = state

  if (phase === 'error') {
    return (
      <div className="beam-result is-error" role="alert">
        <TriangleAlert size={32} />
        <h2>Transfer failed</h2>
        <p className="beam-error-text">{state.error}</p>
        {offer && <p className="beam-muted">{offer.name} · {formatBytes(offer.size)}</p>}
        <button type="button" className="btn btn-primary" onClick={onReset}><RotateCcw size={16} /> Start over</button>
      </div>
    )
  }

  if (phase === 'cancelled') {
    return (
      <div className="beam-result">
        <X size={32} />
        <h2>Transfer cancelled</h2>
        <button type="button" className="btn btn-primary" onClick={onReset}><RotateCcw size={16} /> Start over</button>
      </div>
    )
  }

  if (phase === 'done' && offer && state.result) {
    const r = state.result
    return (
      <div className="beam-result is-done">
        <Check size={32} />
        <h2>File received</h2>
        <p className="beam-file-line"><FileIcon size={15} /> {offer.name} · {formatBytes(offer.size)}</p>
        <p className="beam-muted"><ShieldCheck size={14} /> SHA-256 verified on both ends</p>
        <p className="beam-muted">
          {formatDuration(r.seconds)} at {formatBytes(r.avgSpeed)}/s average
          {r.savedAs === 'download' && ' · saved to your downloads'}
        </p>
        <code className="beam-hash" title="SHA-256">{r.sha256}</code>
        <button type="button" className="btn btn-primary" onClick={onReset}><RotateCcw size={16} /> Receive another file</button>
      </div>
    )
  }

  return (
    <div className="beam-active">
      {offer && (
        <div className="beam-file">
          <FileIcon size={22} />
          <div>
            <div className="beam-file-name">{offer.name}</div>
            <div className="beam-muted">{formatBytes(offer.size)}{offer.type ? ` · ${offer.type}` : ''}</div>
          </div>
        </div>
      )}

      {state.myName && state.senderName && (
        <p className="beam-who"><Person name={state.myName} you /> receiving from <Person name={state.senderName} /></p>
      )}

      {phase === 'offered' && offer && (
        <div className="beam-offer">
          <p>{state.senderName || 'The sender'} wants to give you this file.</p>
          {!canStreamToDisk() && offer.size > MEMORY_LIMIT ? (
            <p className="error-msg">This browser can only receive files up to {formatBytes(MEMORY_LIMIT)}. Open this page in Chrome or Edge to receive it.</p>
          ) : (
            <p className="beam-muted">
              {canStreamToDisk() ? 'You will choose where to save it, then it streams straight to disk.' : 'It will be saved to your downloads when it finishes.'}
            </p>
          )}
          <div className="beam-actions">
            <button type="button" className="btn btn-primary" onClick={onAccept}><ArrowDownToLine size={16} /> Accept and save</button>
            <button type="button" className="btn btn-ghost" onClick={onDecline}>Decline</button>
          </div>
        </div>
      )}

      {(phase === 'transferring' || phase === 'verifying') && offer && (
        <Progress bytes={state.bytes} total={offer.size} speed={state.speed} eta={state.eta} verifying={phase === 'verifying'} route={state.route} />
      )}

      {phase !== 'offered' && (
        <p className="beam-status"><span className="beam-dot" /> {receiverStatus(phase)}</p>
      )}

      {phase !== 'offered' && (
        <div className="beam-actions">
          <button type="button" className="btn btn-danger" onClick={onCancel}><X size={16} /> Cancel</button>
        </div>
      )}
      {(phase === 'transferring' || phase === 'peering') && <p className="beam-hint">Keep this tab open until the transfer finishes.</p>}
    </div>
  )
}

function receiverStatus(phase: ReceiverState['phase']): string {
  switch (phase) {
    case 'connecting': return 'Looking for the sender...'
    case 'peering': return 'Opening a direct connection...'
    case 'transferring': return 'Receiving...'
    case 'verifying': return 'Saving the file and checking it...'
    default: return ''
  }
}

// ── Shared progress readout ─────────────────────────────────────────────────

function Progress({ bytes, total, speed, eta, verifying, route }: {
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
