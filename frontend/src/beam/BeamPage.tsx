import { lazy, Suspense, useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowDownToLine, Ban, Check, Copy, File as FileIcon, QrCode, Radio, RotateCcw, Send, ShieldCheck, TriangleAlert, Upload, Users, X } from 'lucide-react'
import Logo from '../components/Logo'
import { useSeo } from '../lib/useSeo'
import { colorForId } from '../lib/cuteNames'
import { copyToClipboard } from '../lib/clipboard'
import { useBeam } from './useBeam'
import { canStreamToDisk, MEMORY_LIMIT } from './diskWriter'
import { avatarFor, formatBytes, formatDuration, formatEta, formatPin, parsePin } from './beamProtocol'
import type { ResumeRecord } from './resumeStore'
import Radar from './Radar'
import type { LobbyInvite } from './beamLobby'
import type { VisibleState } from './useBeam'
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
  if (has('paused')) return 'paused'
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
    ? sender.legs.some(l => l.phase === 'peering' || l.phase === 'transferring' || l.phase === 'verifying' || l.phase === 'paused')
    : role === 'receiver' && ['transferring', 'verifying', 'peering', 'interrupted'].includes(receiver.phase)
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
          <StartPanels onSend={beam.send} onJoin={(pin) => beam.join(pin)} visible={beam.visible} onVisible={beam.setVisible} onRespond={beam.respondInvite} unfinished={beam.unfinished} onResume={beam.resumeUnfinished} onDiscard={beam.discardUnfinished} />
        ) : (
          <section className="beam-card" aria-live="polite">
            {role === 'sender'
              ? <SenderPanel state={sender} onStop={beam.stopSharing} onCancelLeg={beam.cancelLeg} onReset={beam.reset} onInvite={beam.inviteNearby} onReconnect={beam.reconnectSender} />
              : <ReceiverPanel state={receiver} onAccept={beam.accept} onDecline={beam.decline} onCancel={beam.cancelReceive} onReset={beam.reset} onReconnect={beam.reconnectReceive} />}
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

interface StartProps {
  onSend: (f: File) => void
  onJoin: (pin: string) => void
  visible: VisibleState
  onVisible: (on: boolean) => void
  onRespond: (invite: LobbyInvite, accept: boolean, block?: boolean) => void
  unfinished: ResumeRecord[]
  onResume: (record: ResumeRecord) => void
  onDiscard: (rk: string) => void
}

function StartPanels({ onSend, onJoin, visible, onVisible, onRespond, unfinished, onResume, onDiscard }: StartProps) {
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
    <>
    {unfinished.length > 0 && (
      <section className="beam-card beam-unfinished" aria-label="Unfinished transfers">
        <h2><RotateCcw size={18} /> Unfinished transfers</h2>
        <ul className="beam-legs">
          {unfinished.map((r) => (
            <li key={r.rk} className="beam-leg" data-unfinished={r.name}>
              <div className="beam-leg-head">
                <span className="beam-leg-name">{r.name}</span>
                <span className="beam-leg-status">{formatBytes(r.have)} of {formatBytes(r.size)} saved{r.senderName ? ` · from ${r.senderName}` : ''}</span>
              </div>
              <div className="beam-bar"><div className="beam-bar-fill" style={{ width: `${r.size > 0 ? Math.min(100, (r.have / r.size) * 100) : 0}%` }} /></div>
              <div className="beam-actions">
                <button type="button" className="btn btn-primary" onClick={() => onResume(r)}><RotateCcw size={15} /> Reconnect and continue</button>
                <button type="button" className="btn btn-ghost" onClick={() => onDiscard(r.rk)}>Forget it</button>
              </div>
            </li>
          ))}
        </ul>
        <p className="beam-hint">The sender has to still be sharing (their page open). The part you already have stays where you saved it.</p>
      </section>
    )}
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
        <ReceiveMode visible={visible} onVisible={onVisible} onRespond={onRespond} />
      </section>
    </div>
    </>
  )
}

/** Receive mode: opt in to be listed to senders on the same network, and answer their requests. */
function ReceiveMode({ visible, onVisible, onRespond }: Pick<StartProps, 'visible' | 'onVisible' | 'onRespond'>) {
  return (
    <div className="beam-nearby-opt" data-receive-mode={visible.on ? 'on' : 'off'}>
      <label className="beam-switch">
        <input
          type="checkbox"
          role="switch"
          checked={visible.on}
          onChange={(e) => onVisible(e.target.checked)}
          aria-label="Show me to nearby senders"
        />
        <span className="beam-switch-track" aria-hidden="true"><span className="beam-switch-thumb" /></span>
        <span>
          <span className="beam-switch-title">Show me to nearby senders</span>
          <span className="beam-hint beam-switch-sub">
            {visible.on
              ? 'Visible only while this page is open. Close the tab or switch this off to disappear.'
              : 'Off by default. Senders on your network can then send you a request, which you can decline.'}
          </span>
        </span>
      </label>

      {visible.on && (
        <div className="beam-visible-card" aria-live="polite">
          <span className="beam-peer-avatar is-me" style={{ background: `${colorForId(visible.name)}33`, borderColor: colorForId(visible.name) }}>
            <span aria-hidden="true">{avatarFor(visible.name)}</span>
          </span>
          <div>
            <div className="beam-visible-name" data-testid="beam-visible-name">{visible.name} <span className="beam-person-you">you</span></div>
            <div className="beam-muted">
              <span className={`beam-dot${visible.status === 'online' ? '' : ' is-off'}`} />{' '}
              {visible.status === 'online' ? 'Waiting for requests...' : visible.status === 'connecting' ? 'Connecting...' : 'Offline. Switch off and on to retry.'}
            </div>
          </div>
        </div>
      )}

      {visible.invites.map((inv) => (
        <div key={inv.inviteId} className="beam-invite" role="alertdialog" aria-label={`${inv.from.name} wants to send you a file`} data-invite-from={inv.from.name}>
          <div className="beam-invite-head">
            <span className="beam-peer-avatar" style={{ background: `${colorForId(inv.from.name)}33`, borderColor: colorForId(inv.from.name) }}>
              <span aria-hidden="true">{avatarFor(inv.from.name)}</span>
            </span>
            <div className="beam-invite-text">
              <strong>{inv.from.name}</strong> wants to send you
              <div className="beam-file-name">{inv.offer.name}</div>
              <div className="beam-muted">{formatBytes(inv.offer.size)}</div>
            </div>
          </div>
          <div className="beam-actions">
            <button type="button" className="btn btn-primary" onClick={() => onRespond(inv, true)}><ArrowDownToLine size={15} /> Accept</button>
            <button type="button" className="btn btn-ghost" onClick={() => onRespond(inv, false)}>Decline</button>
            <button type="button" className="btn btn-ghost" onClick={() => onRespond(inv, false, true)} title="Decline and hide future requests from this sender"><Ban size={15} /> Block</button>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Sender ──────────────────────────────────────────────────────────────────

interface SenderPanelProps {
  state: SenderState
  onStop: () => void
  onCancelLeg: (id: string) => void
  onReset: () => void
  onInvite: (ids: string[]) => void
  onReconnect: () => void
}

function SenderPanel({ state, onStop, onCancelLeg, onReset, onInvite, onReconnect }: SenderPanelProps) {
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

      {state.connection === 'reconnecting' && phase === 'open' && (
        <div className="beam-banner" role="status" data-testid="beam-sender-reconnecting">
          <span><span className="beam-dot" /> Lost the connection to Clip. Reconnecting... Transfers already running keep going.</span>
          <button type="button" className="btn btn-ghost" onClick={onReconnect}><RotateCcw size={15} /> Reconnect now</button>
        </div>
      )}

      {state.myName && phase !== 'connecting' && (
        <p className="beam-who">Sharing as <Person name={state.myName} you /></p>
      )}

      {open && <NearbySection state={state} onInvite={onInvite} />}
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

      {open && legs.length === 0 && <p className="beam-status"><span className="beam-dot" /> Waiting for someone to join. Pick people on the radar, or share the PIN.</p>}

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

/** People on the same network who switched on Receive mode, as a radar. Pick one or several and ask. */
function NearbySection({ state, onInvite }: { state: SenderState; onInvite: (ids: string[]) => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const legNames = new Set(state.legs.map((l) => l.name))
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
    <div className="beam-nearby" data-nearby-count={state.nearby.length}>
      <div className="beam-nearby-head">
        <span className="label">Send to people nearby</span>
        <span className="beam-muted">
          {state.nearbyStatus === 'offline' ? 'Discovery is offline' : state.nearby.length === 0 ? 'Looking...' : `${state.nearby.length} ${state.nearby.length === 1 ? 'person' : 'people'} here`}
        </span>
      </div>
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
    </div>
  )
}

/** A person's cute name with their avatar, the same pairing Live Pad uses for cursors. */
function Person({ name, you }: { name: string; you?: boolean }) {
  return (
    <span className="beam-person" data-person={name}>
      <span className="beam-person-dot" style={{ background: `${colorForId(name)}33`, borderColor: colorForId(name) }} aria-hidden="true">{avatarFor(name)}</span>
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
    case 'paused': return 'Connection lost. Waiting for them to reconnect and carry on...'
    case 'done': return 'Received and verified'
    case 'declined': return 'Declined or left'
    case 'error': return leg.error ?? 'Failed'
  }
}

function LegRow({ leg, size, onCancel }: { leg: SenderLeg; size: number; onCancel: () => void }) {
  const live = leg.phase === 'transferring' || leg.phase === 'verifying'
  const finished = leg.phase === 'done' || leg.phase === 'declined' || leg.phase === 'error'
  const resumedNote = leg.resumedFrom > 0 && (live || leg.phase === 'peering')
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
      {resumedNote && <div className="beam-muted beam-leg-done" data-testid="beam-resumed-note"><RotateCcw size={13} /> Continued from {formatBytes(leg.resumedFrom)} after a dropped connection</div>}
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
      <span className="label">Or share a PIN instead (up to 8 people)</span>
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
  onReconnect: () => void
}

function ReceiverPanel({ state, onAccept, onDecline, onCancel, onReset, onReconnect }: ReceiverPanelProps) {
  const { phase, offer } = state

  if (phase === 'interrupted' && offer) {
    const pct = offer.size > 0 ? Math.min(100, (state.saved / offer.size) * 100) : 0
    return (
      <div className="beam-active beam-interrupted" role="status" data-testid="beam-interrupted">
        <div className="beam-file">
          <FileIcon size={22} />
          <div>
            <div className="beam-file-name">{offer.name}</div>
            <div className="beam-muted">{formatBytes(offer.size)}</div>
          </div>
        </div>
        <div className="beam-result is-warn">
          <TriangleAlert size={28} />
          <h2>Connection lost</h2>
          <p className="beam-error-text">
            {formatBytes(state.saved)} of {formatBytes(offer.size)} ({pct.toFixed(pct < 10 ? 1 : 0)}%) is saved.
            {state.canResume ? ' Reconnect to carry on from there instead of starting again.' : ' This browser could not keep the partial file, so the transfer has to start over.'}
          </p>
        </div>
        <div className="beam-bar" aria-hidden="true"><div className="beam-bar-fill" style={{ width: `${pct}%` }} /></div>
        {state.reason && <p className="beam-hint beam-center">{state.reason}</p>}
        <p className="beam-status" data-testid="beam-reconnect-status">
          <span className="beam-dot" />
          {state.needsClick
            ? 'Press Reconnect to continue. Your browser needs your OK to reopen the saved file.'
            : state.retryIn !== null
              ? `Reconnecting automatically in ${state.retryIn}s${state.attempt > 0 ? ` (attempt ${state.attempt + 1})` : ''}...`
              : state.attempt > 0 ? 'Trying to reconnect...' : 'Waiting to reconnect...'}
        </p>
        <div className="beam-actions">
          {state.canResume
            ? <button type="button" className="btn btn-primary" onClick={onReconnect}><RotateCcw size={16} /> Reconnect</button>
            : <button type="button" className="btn btn-primary" onClick={onReset}><RotateCcw size={16} /> Start over</button>}
          <button type="button" className="btn btn-ghost" onClick={onCancel}><X size={16} /> Cancel transfer</button>
        </div>
        <p className="beam-hint beam-center">The part already saved stays where you saved it. Keep the sender&apos;s page open.</p>
      </div>
    )
  }

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

      {state.resumedFrom > 0 && (phase === 'transferring' || phase === 'peering') && (
        <p className="beam-muted beam-center" data-testid="beam-resumed-note"><RotateCcw size={13} /> Continuing from {formatBytes(state.resumedFrom)} after a dropped connection</p>
      )}
      {state.senderAway && (phase === 'transferring' || phase === 'peering') && (
        <p className="beam-muted beam-center">The sender lost its connection and is reconnecting...</p>
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
