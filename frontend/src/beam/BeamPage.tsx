import { lazy, Suspense, useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowDownToLine, Check, Copy, File as FileIcon, QrCode, Radio, RotateCcw, Send, ShieldCheck, TriangleAlert, Upload, X } from 'lucide-react'
import Logo from '../components/Logo'
import { useSeo } from '../lib/useSeo'
import { copyToClipboard } from '../lib/clipboard'
import { useBeam } from './useBeam'
import { canStreamToDisk, MEMORY_LIMIT } from './diskWriter'
import { formatBytes, formatDuration, formatPin, parsePin } from './beamProtocol'
import type { BeamState } from './beamSession'
import './beam.css'

const QRCodeSVG = lazy(() =>
  import('qrcode.react').then(m => ({ default: m.QRCodeSVG }))
)

export default function BeamPage() {
  useSeo({
    title: 'Clip Beam - Send big files browser to browser',
    description: 'Send files of any size straight from one browser to another over an encrypted peer-to-peer connection. Nothing is uploaded.',
    canonicalUrl: 'https://clip.foo.ng/beam',
  })

  const { state, send, join, accept, decline, cancel, reset } = useBeam()
  const [searchParams, setSearchParams] = useSearchParams()
  const autoJoined = useRef(false)

  // Opening a /beam?pin=123456 link (from the QR code) joins straight away
  useEffect(() => {
    if (autoJoined.current) return
    const pin = parsePin(searchParams.get('pin') ?? '')
    if (pin) {
      autoJoined.current = true
      join(pin)
      setSearchParams({}, { replace: true })
    }
  }, [searchParams, join, setSearchParams])

  // Closing the tab kills the transfer, so ask first
  const busy = state.phase === 'transferring' || state.phase === 'verifying' || state.phase === 'peering'
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
    <div className="beam-page" data-beam-phase={state.phase} data-beam-role={state.role ?? ''}>
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

        {state.phase === 'idle' ? (
          <StartPanels onSend={send} onJoin={join} />
        ) : (
          <section className="beam-card" aria-live="polite">
            <TransferPanel state={state} onAccept={accept} onDecline={decline} onCancel={cancel} onReset={reset} />
          </section>
        )}

        <ul className="beam-facts">
          <li><Radio size={13} /> Peer to peer, no size cap in Chrome and Edge</li>
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

// ── Everything after the first click ────────────────────────────────────────

interface PanelProps {
  state: BeamState
  onAccept: () => void
  onDecline: () => void
  onCancel: () => void
  onReset: () => void
}

function TransferPanel({ state, onAccept, onDecline, onCancel, onReset }: PanelProps) {
  const { phase, role, offer } = state
  const sending = role === 'sender'

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

  if (phase === 'cancelled' || phase === 'rejected') {
    return (
      <div className="beam-result">
        <X size={32} />
        <h2>{phase === 'rejected' ? 'The receiver declined the file' : 'Transfer cancelled'}</h2>
        <button type="button" className="btn btn-primary" onClick={onReset}><RotateCcw size={16} /> Start over</button>
      </div>
    )
  }

  if (phase === 'done' && offer && state.result) {
    const r = state.result
    return (
      <div className="beam-result is-done">
        <Check size={32} />
        <h2>{sending ? 'File sent' : 'File received'}</h2>
        <p className="beam-file-line"><FileIcon size={15} /> {offer.name} · {formatBytes(offer.size)}</p>
        <p className="beam-muted"><ShieldCheck size={14} /> SHA-256 verified on both ends</p>
        <p className="beam-muted">
          {formatDuration(r.seconds)} at {formatBytes(r.avgSpeed)}/s average
          {r.savedAs === 'download' && ' · saved to your downloads'}
        </p>
        <code className="beam-hash" title="SHA-256">{r.sha256}</code>
        <button type="button" className="btn btn-primary" onClick={onReset}>
          <RotateCcw size={16} /> {sending ? 'Send another file' : 'Receive another file'}
        </button>
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

      {sending && (phase === 'waiting' || phase === 'joined') && state.pin && <PinShare pin={state.pin} />}

      {phase === 'offered' && offer && (
        <div className="beam-offer">
          <p>The sender wants to give you this file.</p>
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

      {(phase === 'transferring' || phase === 'verifying') && offer && <Progress state={state} />}

      {phase !== 'offered' && <p className="beam-status"><span className="beam-dot" /> {statusText(state)}</p>}

      {phase !== 'offered' && (
        <div className="beam-actions">
          <button type="button" className="btn btn-danger" onClick={onCancel}><X size={16} /> Cancel</button>
        </div>
      )}
      {(phase === 'transferring' || phase === 'peering') && <p className="beam-hint">Keep this tab open until the transfer finishes.</p>}
    </div>
  )
}

function statusText({ phase, role }: BeamState): string {
  const sending = role === 'sender'
  switch (phase) {
    case 'connecting': return sending ? 'Opening a Beam room...' : 'Looking for the sender...'
    case 'waiting': return 'Waiting for the receiver to enter the PIN...'
    case 'joined': return 'Receiver connected. Waiting for them to accept...'
    case 'peering': return 'Opening a direct connection...'
    case 'transferring': return sending ? 'Sending...' : 'Receiving...'
    case 'verifying': return sending ? 'Waiting for the receiver to check the file...' : 'Finishing and checking the file...'
    default: return ''
  }
}

function PinShare({ pin }: { pin: string }) {
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
      <span className="label">Share this PIN with the receiver</span>
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
      <p className="beam-hint">The PIN works once and expires after 10 minutes without a receiver.</p>
    </div>
  )
}

function Progress({ state }: { state: BeamState }) {
  const total = state.offer?.size ?? 0
  const pct = total > 0 ? Math.min(100, (state.bytes / total) * 100) : 100
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
        <span>{formatBytes(state.bytes)} of {formatBytes(total)}</span>
      </div>
      <div className="beam-stats beam-muted">
        <span>{state.speed > 0 ? `${formatBytes(state.speed)}/s` : 'Measuring speed...'}</span>
        <span>{state.phase === 'verifying' ? 'Checking...' : `${formatDuration(state.eta)} left`}</span>
      </div>
      {state.route && <div className="beam-route">{state.route}</div>}
    </div>
  )
}
