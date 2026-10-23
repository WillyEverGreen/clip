import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowDownToLine, ArrowLeft, Ban, Radio, RotateCcw, Send, ShieldCheck, Upload, Users, X } from 'lucide-react'
import Logo from '../components/Logo'
import { useSeo } from '../lib/useSeo'
import { colorForId } from '../lib/cuteNames'
import { useBeam } from './useBeam'
import { canStreamToDisk, MEMORY_LIMIT } from './diskWriter'
import { avatarFor, formatBytes, parsePin } from './beamProtocol'
import type { ResumeRecord } from './resumeStore'
import type { LobbyInvite } from './beamLobby'
import type { VisibleState } from './useBeam'
import type { SenderState } from './beamSender'
import type { ReceiverState } from './beamReceiver'
import SenderSession from './SenderSession'
import ReceiverSession from './ReceiverSession'
import './beam.css'

const IN_FLIGHT = ['offered', 'transferring', 'verifying']

/** One word for the whole page that tests and styles can key off. */
function summarisePhase(role: 'sender' | 'receiver' | null, sender: SenderState, receiver: ReceiverState): string {
  if (role === 'receiver') {
    const inc = receiver.incoming
    if (inc) return inc.phase === 'starting' ? 'peering' : inc.phase
    if (receiver.phase === 'connected') return receiver.history[receiver.history.length - 1]?.status === 'done' ? 'done' : 'connected'
    return receiver.phase
  }
  if (role !== 'sender') return 'idle'
  if (sender.phase === 'error' || sender.phase === 'connecting' || sender.phase === 'stopped') return sender.phase
  const legs = sender.legs
  if (legs.length === 0) return 'waiting'
  const transfers = legs.flatMap(l => l.transfers)
  if (transfers.some(t => t.status === 'transferring')) return 'transferring'
  if (transfers.some(t => t.status === 'verifying')) return 'verifying'
  if (transfers.some(t => t.status === 'offered')) return 'offered'
  if (legs.some(l => l.phase === 'connecting')) return 'peering'
  if (legs.some(l => l.phase === 'paused')) return 'paused'
  const live = legs.filter(l => l.phase === 'connected')
  if (live.length === 0) return legs.every(l => l.phase === 'ended') ? 'ended' : 'error'
  if (live.every(l => l.transfers.length > 0 && l.transfers.every(t => t.status === 'done'))) return 'done'
  return 'connected'
}

export default function BeamPage() {
  useSeo({
    title: 'Clip Beam - Send big files browser to browser',
    description: 'Send big files straight from one browser to another over an encrypted peer-to-peer connection. Nothing is uploaded, no account needed.',
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

  // Closing the tab ends the connection, so ask first whenever something is in progress or paused
  const busy = role === 'sender'
    ? sender.legs.some(l => l.phase === 'paused' || l.transfers.some(t => IN_FLIGHT.includes(t.status) && t.status !== 'offered'))
    : role === 'receiver' && (receiver.phase === 'interrupted' || (receiver.incoming !== null && receiver.incoming.phase !== 'offered'))
  useEffect(() => {
    if (!busy) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [busy])

  const senderOpen = role === 'sender' && sender.phase === 'open'
  const live = sender.legs.filter(l => l.phase === 'connected').length
  const showDisconnect = role === 'receiver' && (receiver.phase === 'connected' || receiver.phase === 'connecting')

  return (
    <div className="beam-page" data-beam-phase={summarisePhase(role, sender, receiver)} data-beam-role={role ?? ''}>
      {/* Same top bar as Live Pad: Home, logo with a mode pill, status chip and actions on the right */}
      <header className="beam-topbar">
        <div className="beam-topbar-left">
          <Link to="/" className="btn btn-ghost beam-home"><ArrowLeft size={16} /><span>Home</span></Link>
          <Logo />
          <span className="beam-pill"><Radio size={13} /> Beam</span>
        </div>
        <div className="beam-topbar-right">
          {role === 'sender' && sender.phase !== 'connecting' && (
            <span className="beam-chip" data-testid="beam-chip" title="People connected right now">
              <span className={`beam-chip-dot${live > 0 ? ' is-on' : ''}`} /> {live} connected
            </span>
          )}
          {role === 'receiver' && receiver.senderName && (
            <span className="beam-chip" data-testid="beam-chip">
              <span className={`beam-chip-dot${receiver.phase === 'connected' ? ' is-on' : ''}`} /> {receiver.phase === 'connected' ? 'Connected' : receiver.phase === 'interrupted' ? 'Reconnecting' : 'Connecting'}
            </span>
          )}
          {senderOpen && (
            <button type="button" className="btn btn-danger beam-top-btn" onClick={beam.stopSharing}><X size={15} /> Stop sharing</button>
          )}
          {showDisconnect && (
            <button type="button" className="btn btn-danger beam-top-btn" onClick={beam.disconnectReceiver} data-testid="beam-disconnect"><X size={15} /> Disconnect</button>
          )}
        </div>
      </header>

      <h1 className="beam-sr-only">Clip Beam: send big files from one browser to another</h1>
      <section className="card card-glow card-content beam-card" aria-live="polite">
        {role === null ? (
          <StartPanels onSend={beam.send} onJoin={(pin) => beam.join(pin)} visible={beam.visible} onVisible={beam.setVisible} onRespond={beam.respondInvite} unfinished={beam.unfinished} onResume={beam.resumeUnfinished} onDiscard={beam.discardUnfinished} />
        ) : role === 'sender' ? (
          <SenderSession state={sender} actions={{
            onAddFiles: beam.addFiles, onStop: beam.stopSharing, onCancelFile: beam.cancelSendFile, onDisconnect: beam.disconnectLeg, onDismiss: beam.dismissLeg,
            onReset: beam.reset, onInvite: beam.inviteNearby, onReconnect: beam.reconnectSender,
          }} />
        ) : (
          <ReceiverSession state={receiver} actions={{
            onAccept: beam.acceptOffer, onDecline: beam.declineOffer, onAcceptAll: beam.setAcceptAll, onCancelFile: beam.cancelReceiveFile,
            onDisconnect: beam.disconnectReceiver, onReconnect: beam.reconnectReceive, onReset: beam.reset,
          }} />
        )}
      </section>

      <ul className="beam-facts">
        <li><Radio size={13} /> Peer to peer, no size cap in Chrome and Edge</li>
        <li><Users size={13} /> Up to 8 people at once, any number of files</li>
        <li><ShieldCheck size={13} /> DTLS encrypted, SHA-256 checked</li>
        <li><X size={13} /> Nothing stored on Clip servers</li>
      </ul>
    </div>
  )
}

// ── Landing: send or receive ────────────────────────────────────────────────

interface StartProps {
  onSend: (files: File[]) => void
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

  const pick = (list: FileList | null) => {
    const files = [...(list ?? [])]
    if (files.length > 0) onSend(files)
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
    <div className="beam-start-wrap">
      <div className="beam-scroll">
        <div className="beam-start-inner">
          {unfinished.length > 0 && (
            <section className="beam-panel beam-unfinished" aria-label="Unfinished transfers">
              <div className="beam-panel-title"><RotateCcw size={15} /> Unfinished transfers <span className="beam-count">{unfinished.length}</span></div>
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

          <div className="beam-start-grid">
          <section className="beam-panel beam-start-panel">
            <h2 className="beam-card-title"><Send size={18} /> Send files</h2>
            <button
              type="button"
              className={`beam-drop${dragging ? ' is-dragging' : ''}`}
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <Upload size={30} />
              <span className="beam-drop-title">Drop files here</span>
              <span className="beam-drop-sub">or click to choose. Big files are fine, and you can add more later.</span>
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="beam-hidden-input"
              aria-label="Choose files to send"
              onChange={(e) => { pick(e.target.files); e.target.value = '' }}
            />
            <p className="beam-hint beam-center">You will get a PIN, a QR code and a radar of people nearby. Add more files whenever you like.</p>
          </section>

          <section className="beam-panel beam-start-panel">
            <h2 className="beam-card-title"><ArrowDownToLine size={18} /> Receive files</h2>
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
                ? 'You choose where each file is saved, or one folder for all of them.'
                : `This browser keeps each file in memory until it finishes, so it can receive files up to ${formatBytes(MEMORY_LIMIT)} each. Use Chrome or Edge for bigger files.`}
            </p>
            <ReceiveMode visible={visible} onVisible={onVisible} onRespond={onRespond} />
            <ol className="beam-steps" aria-label="How receiving works">
              <li><b>1</b><span>Enter the sender's PIN, or switch on nearby so they can find you.</span></li>
              <li><b>2</b><span>Accept each file when it appears, or accept all.</span></li>
              <li><b>3</b><span>Pick where it is saved. It is checked when it arrives.</span></li>
            </ol>
          </section>
          </div>
        </div>
      </div>
    </div>
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
              : 'Off by default. Senders on your network can then ask to connect, which you can decline.'}
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
        <div key={inv.inviteId} className="beam-invite" role="alertdialog" aria-label={`${inv.from.name} wants to connect`} data-invite-from={inv.from.name}>
          <div className="beam-invite-head">
            <span className="beam-peer-avatar" style={{ background: `${colorForId(inv.from.name)}33`, borderColor: colorForId(inv.from.name) }}>
              <span aria-hidden="true">{avatarFor(inv.from.name)}</span>
            </span>
            <div className="beam-invite-text">
              <strong>{inv.from.name}</strong> wants to connect and send you
              <div className="beam-file-name">{inv.offer.name}</div>
              <div className="beam-muted">{formatBytes(inv.offer.size)}. You still choose whether to accept each file.</div>
            </div>
          </div>
          <div className="beam-actions">
            <button type="button" className="btn btn-primary" onClick={() => onRespond(inv, true)}><ArrowDownToLine size={15} /> Connect</button>
            <button type="button" className="btn btn-ghost" onClick={() => onRespond(inv, false)}>Decline</button>
            <button type="button" className="btn btn-ghost" onClick={() => onRespond(inv, false, true)} title="Decline and hide future requests from this sender"><Ban size={15} /> Block</button>
          </div>
        </div>
      ))}
    </div>
  )
}
