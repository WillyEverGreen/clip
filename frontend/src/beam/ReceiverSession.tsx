import { ArrowDownToLine, Check, File as FileIcon, FolderOpen, RotateCcw, ShieldCheck, TriangleAlert, X } from 'lucide-react'
import { canPickFolder, canStreamToDisk, MEMORY_LIMIT } from './diskWriter'
import { formatBytes, formatDuration } from './beamProtocol'
import { Person, Progress } from './BeamBits'
import type { ReceivedFile, ReceiverState } from './beamReceiver'

export interface ReceiverActions {
  onAccept: () => void
  onDecline: () => void
  onAcceptAll: (on: boolean) => void
  onCancelFile: () => void
  onDisconnect: () => void
  onReconnect: () => void
  onReset: () => void
}

/** The receiver's whole visit: connecting, then files arriving one at a time, until someone ends it. */
export default function ReceiverSession({ state, actions }: { state: ReceiverState; actions: ReceiverActions }) {
  const { phase } = state

  if (phase === 'error') {
    return (
      <div className="beam-result is-error" role="alert">
        <TriangleAlert size={32} />
        <h2>Could not connect</h2>
        <p className="beam-error-text">{state.error}</p>
        <button type="button" className="btn btn-primary" onClick={actions.onReset}><RotateCcw size={16} /> Start over</button>
      </div>
    )
  }

  if (phase === 'ended') {
    const done = state.history.filter(h => h.status === 'done').length
    return (
      <div className="beam-active" data-receiver-session="ended">
        <div className="beam-result">
          <X size={32} />
          <h2>{state.endedBy === 'you' ? 'You ended the connection' : `${state.senderName || 'The sender'} ended the connection`}</h2>
          {state.error && <p className="beam-error-text">{state.error}</p>}
          <p className="beam-muted">{done} {done === 1 ? 'file' : 'files'} received</p>
        </div>
        <History items={state.history} />
        <div className="beam-actions">
          <button type="button" className="btn btn-primary" onClick={actions.onReset}><RotateCcw size={16} /> Start over</button>
        </div>
      </div>
    )
  }

  if (phase === 'interrupted') return <Interrupted state={state} actions={actions} />

  return (
    <div className="beam-session beam-session-narrow" data-receiver-session={phase}>
      <div className="beam-col">
        <section className="beam-panel beam-session-head">
          {state.senderName
            ? <p className="beam-who"><Person name={state.myName} you /> connected to <Person name={state.senderName} /></p>
            : <p className="beam-who">Connecting...</p>}
          {state.route && <span className="beam-route">{state.route}</span>}
          {phase === 'connecting' && (
            <p className="beam-status"><span className="beam-dot" /> {state.senderAway ? 'The sender lost their connection and is reconnecting...' : 'Opening a direct connection...'}</p>
          )}
          {phase === 'connected' && <AcceptAll state={state} onChange={actions.onAcceptAll} />}
        </section>

        {phase === 'connected' && (
          <>
            {state.incoming ? <Incoming state={state} actions={actions} /> : (
              <section className="beam-panel">
                <p className="beam-status" data-testid="beam-waiting">
                  <span className="beam-dot" /> {state.history.length === 0 ? `Waiting for ${state.senderName || 'the sender'} to send files...` : 'Waiting for more files. You can disconnect any time.'}
                </p>
                {state.senderAway && <p className="beam-muted beam-center">The sender lost their own connection and is reconnecting...</p>}
              </section>
            )}
            {state.history.length > 0 && (
              <section className="beam-panel">
                <div className="beam-panel-title"><Check size={15} /> Received files <span className="beam-count">{state.history.length}</span></div>
                <History items={state.history} />
              </section>
            )}
          </>
        )}
        {state.incoming && state.incoming.phase !== 'offered' && <p className="beam-hint beam-center">Keep this tab open until the file finishes.</p>}
      </div>
    </div>
  )
}

// ── Accept all ──────────────────────────────────────────────────────────────

function AcceptAll({ state, onChange }: { state: ReceiverState; onChange: (on: boolean) => void }) {
  const folder = canPickFolder()
  return (
    <div className="beam-nearby-opt beam-acceptall" data-accept-all={state.acceptAll ? 'on' : 'off'}>
      <label className="beam-switch">
        <input type="checkbox" role="switch" checked={state.acceptAll} onChange={(e) => onChange(e.target.checked)} aria-label="Accept all files" />
        <span className="beam-switch-track" aria-hidden="true"><span className="beam-switch-thumb" /></span>
        <span>
          <span className="beam-switch-title">Accept all files from {state.senderName || 'this sender'}</span>
          <span className="beam-hint beam-switch-sub">
            {state.acceptAll
              ? (state.folderName ? `Saving every file into "${state.folderName}". Switch off to be asked each time.` : 'Every file downloads automatically. Switch off to be asked each time.')
              : (folder ? 'Off: you decide about each file. Turning it on asks for one folder to save everything into.' : 'Off: you decide about each file. Turning it on downloads every file automatically.')}
          </span>
        </span>
      </label>
    </div>
  )
}

// ── The file on offer or arriving ───────────────────────────────────────────

function Incoming({ state, actions }: { state: ReceiverState; actions: ReceiverActions }) {
  const inc = state.incoming
  if (!inc) return null
  const tooBig = !canStreamToDisk() && inc.size > MEMORY_LIMIT
  return (
    <div className="beam-panel beam-incoming" data-incoming-phase={inc.phase} data-incoming-file={inc.name}>
      <div className="beam-file">
        <FileIcon size={22} />
        <div>
          <div className="beam-file-name">{inc.name}</div>
          <div className="beam-muted">{formatBytes(inc.size)}{inc.type ? ` · ${inc.type}` : ''}</div>
        </div>
      </div>

      {inc.phase === 'offered' && (
        <div className="beam-offer">
          <p>{state.senderName || 'The sender'} wants to send you this file.</p>
          {tooBig ? (
            <p className="error-msg">This browser can only receive files up to {formatBytes(MEMORY_LIMIT)}. Open this page in Chrome or Edge to receive it.</p>
          ) : (
            <p className="beam-muted">
              {state.acceptAll ? 'Accepting automatically...' : canStreamToDisk() ? 'You will choose where to save it, then it streams straight to disk.' : 'It will be saved to your downloads when it finishes.'}
            </p>
          )}
          <div className="beam-actions">
            <button type="button" className="btn btn-primary" onClick={actions.onAccept} disabled={tooBig}><ArrowDownToLine size={16} /> {canStreamToDisk() ? 'Accept and save' : 'Accept and download'}</button>
            <button type="button" className="btn btn-ghost" onClick={actions.onDecline}>Decline</button>
          </div>
        </div>
      )}

      {inc.phase === 'starting' && <p className="beam-status"><span className="beam-dot" /> Starting...</p>}

      {(inc.phase === 'transferring' || inc.phase === 'verifying') && (
        <>
          {inc.resumedFrom > 0 && (
            <p className="beam-muted beam-center" data-testid="beam-resumed-note"><RotateCcw size={13} /> Continuing from {formatBytes(inc.resumedFrom)} after a dropped connection</p>
          )}
          <Progress bytes={inc.bytes} total={inc.size} speed={inc.speed} eta={inc.eta} verifying={inc.phase === 'verifying'} route={null} />
          <p className="beam-status"><span className="beam-dot" /> {inc.phase === 'verifying' ? 'Saving the file and checking it...' : 'Receiving...'}</p>
        </>
      )}

      {inc.phase !== 'offered' && (
        <div className="beam-actions">
          <button type="button" className="btn btn-ghost" onClick={actions.onCancelFile} data-testid="beam-cancel-file"><X size={15} /> Cancel this file</button>
        </div>
      )}
    </div>
  )
}

// ── Received files ──────────────────────────────────────────────────────────

function History({ items }: { items: ReceivedFile[] }) {
  if (items.length === 0) return null
  return (
    <ul className="beam-hist" aria-label="Files">
      {[...items].reverse().map((h, i) => <HistoryRow key={`${h.f}-${i}`} h={h} />)}
    </ul>
  )
}

function HistoryRow({ h }: { h: ReceivedFile }) {
  const where = h.savedAs === 'folder' ? 'saved to your folder' : h.savedAs === 'download' ? 'saved to your downloads' : 'saved'
  const text = h.status === 'done'
    ? `${formatBytes(h.size)} · ${where} · ${formatDuration(h.seconds)} at ${formatBytes(h.avgSpeed)}/s · SHA-256 verified`
    : h.status === 'declined' ? 'Declined'
    : (h.error ?? (h.status === 'cancelled' ? 'Cancelled' : 'Failed'))
  return (
    <li className={`beam-hist-row is-${h.status}`} data-hist-status={h.status} data-hist-file={h.name} data-hist-saved-as={h.savedName}>
      {h.status === 'done' ? <Check size={13} /> : <X size={13} />}
      <span className="beam-hist-name">{h.savedName || h.name}</span>
      <span className="beam-muted beam-hist-text">{text}</span>
      {h.status === 'done' && h.sha256 && <code className="beam-hash" title="SHA-256">{h.sha256}</code>}
    </li>
  )
}

// ── Connection lost ─────────────────────────────────────────────────────────

function Interrupted({ state, actions }: { state: ReceiverState; actions: ReceiverActions }) {
  const p = state.partial
  const pct = p && p.size > 0 ? Math.min(100, (p.saved / p.size) * 100) : 0
  return (
    <div className="beam-active beam-interrupted" role="status" data-testid="beam-interrupted">
      {state.senderName && <p className="beam-who">Connection to <Person name={state.senderName} /></p>}
      <div className="beam-result is-warn">
        <TriangleAlert size={28} />
        <h2>Connection lost</h2>
        <p className="beam-error-text">
          {p
            ? <>{p.name}: {formatBytes(p.saved)} of {formatBytes(p.size)} ({pct.toFixed(pct < 10 ? 1 : 0)}%) is saved. Reconnect to carry on from there instead of starting again.</>
            : 'No file was in progress. Reconnect to carry on.'}
        </p>
      </div>
      {p && <div className="beam-bar" aria-hidden="true"><div className="beam-bar-fill" style={{ width: `${pct}%` }} /></div>}
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
        <button type="button" className="btn btn-primary" onClick={actions.onReconnect}><RotateCcw size={16} /> Reconnect</button>
        <button type="button" className="btn btn-ghost" onClick={actions.onDisconnect} data-testid="beam-disconnect"><FolderOpen size={15} /> End connection</button>
      </div>
      <p className="beam-hint beam-center"><ShieldCheck size={12} /> Anything already saved stays where you saved it. Keep the sender&apos;s page open.</p>
    </div>
  )
}
