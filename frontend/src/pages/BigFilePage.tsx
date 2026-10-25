import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Check, Copy, Download, File as FileIcon, Link2Off, Plus, Trash2 } from 'lucide-react'
import Logo from '../components/Logo'
import Countdown from '../components/Countdown'
import { useSeo } from '../lib/useSeo'
import { formatBytes } from '../lib/api'
import { copyToClipboard } from '../lib/clipboard'
import { requestBigDownload, deleteBig, forgetBigToken, getBigInfo, recallBigToken, type BigFileInfo } from '../lib/bigUpload'

type View = { kind: 'loading' } | { kind: 'ready'; info: BigFileInfo } | { kind: 'gone' } | { kind: 'error' } | { kind: 'deleted' }

/** The page for a large file: details, a download button, and (for the person who sent it) a way to delete it now. */
export default function BigFilePage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [notice, setNotice] = useState('')
  const token = recallBigToken(slug)

  useSeo({ title: 'Large file - Clip', description: 'A file shared with Clip. It is deleted automatically.', canonicalUrl: 'https://clip.foo.ng/', noindex: true })

  useEffect(() => {
    let alive = true
    getBigInfo(slug).then(({ info, state }) => {
      if (!alive) return
      if (state === 'ok' && info) setView({ kind: 'ready', info })
      else setView({ kind: state === 'gone' ? 'gone' : 'error' })
    })
    return () => { alive = false }
  }, [slug])

  // When the countdown reaches zero the file is gone: say so instead of offering a dead download
  useEffect(() => {
    if (view.kind !== 'ready' || !view.info.expiresAt) return
    const wait = Math.max(0, view.info.expiresAt - Date.now()) + 500
    const t = setTimeout(() => setView({ kind: 'gone' }), Math.min(wait, 2_000_000_000))
    return () => clearTimeout(t)
  }, [view])

  const download = async () => {
    if (downloading) return
    setDownloading(true)
    setNotice('')
    const r = await requestBigDownload(slug)
    setDownloading(false)
    if ('url' in r) { window.location.href = r.url; return }
    if (r.error === 'gone') { setView({ kind: 'gone' }); return }
    setNotice(r.error === 'download_limit' ? 'Large-file downloads are paused for today because the daily download limit was reached. Please try again tomorrow, or ask the sender to use Clip Beam.'
      : r.error === 'rate_limited' ? 'Too many download attempts. Please wait a couple of minutes and try again.'
      : 'Could not start the download. Check your connection and try again.')
  }

  const copy = async () => {
    if (await copyToClipboard(window.location.href)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  const remove = async () => {
    if (!token || busy) return
    if (!window.confirm('Delete this file now? The link stops working straight away.')) return
    setBusy(true)
    const ok = await deleteBig(slug, token)
    setBusy(false)
    if (ok) { forgetBigToken(slug); setView({ kind: 'deleted' }) }
  }

  return (
    <div className="page-wrapper">
      <main className="content-box animate-fade-up" style={{ maxWidth: 560 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem' }}>
          <Link to="/" className="btn btn-ghost" aria-label="Home" style={{ padding: '0.4rem 0.65rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <ArrowLeft size={16} /><span>Home</span>
          </Link>
          <Logo />
        </div>

        {view.kind === 'loading' && (
          <div className="card card-content" style={{ textAlign: 'center', padding: '3rem 1rem' }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
        )}

        {view.kind === 'ready' && (
          <section className="card card-glow card-content" data-testid="big-file" style={{ display: 'grid', gap: '1.25rem' }}>
            <div style={{ display: 'flex', gap: '0.9rem', alignItems: 'center' }}>
              <div style={{ width: 52, height: 52, borderRadius: 14, background: '#0a0a0a', border: '1px solid var(--border)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                <FileIcon size={24} color="#a1a1aa" />
              </div>
              <div style={{ minWidth: 0 }}>
                <h1 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0, overflowWrap: 'anywhere' }} data-testid="big-name">{view.info.name}</h1>
                <p style={{ margin: '0.2rem 0 0', color: 'var(--text-muted)', fontSize: '0.9rem' }}>{formatBytes(view.info.size)}</p>
              </div>
            </div>

            <button type="button" className="btn btn-primary" onClick={download} disabled={downloading} style={{ padding: '0.95rem 1.5rem', fontSize: '1.05rem', gap: '0.55rem', justifyContent: 'center' }} data-testid="big-download">
              {downloading ? <div className="spinner" /> : <Download size={18} />} Download
            </button>
            {notice && <p role="alert" data-testid="big-notice" style={{ margin: 0, color: '#fbbf24', fontSize: '0.88rem', lineHeight: 1.5 }}>{notice}</p>}

            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '0.6rem' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                Deleted in {view.info.expiresAt && <Countdown expiresAt={view.info.expiresAt} />}
              </span>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-ghost" onClick={copy} style={{ gap: '0.4rem' }}>
                  {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy link'}
                </button>
                {token && (
                  <button type="button" className="btn btn-ghost" onClick={remove} disabled={busy} data-testid="big-delete" style={{ gap: '0.4rem' }}>
                    <Trash2 size={15} /> Delete now
                  </button>
                )}
              </div>
            </div>
            <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: '0.8rem', lineHeight: 1.5 }}>
              Anyone with this link can download the file until it is deleted. Large files are stored for a short time only.
            </p>
          </section>
        )}

        {(view.kind === 'gone' || view.kind === 'deleted' || view.kind === 'error') && (
          <section className="card card-content" role="status" style={{ textAlign: 'center', display: 'grid', gap: '1rem', justifyItems: 'center', padding: '2.5rem 1.25rem' }}>
            <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#0a0a0a', border: '1px solid var(--border)', display: 'grid', placeItems: 'center' }}>
              <Link2Off size={28} color="#a1a1aa" />
            </div>
            <h1 style={{ fontSize: '1.4rem', margin: 0 }}>
              {view.kind === 'deleted' ? 'File deleted' : view.kind === 'error' ? 'Could not load this file' : 'This file is gone'}
            </h1>
            <p style={{ margin: 0, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              {view.kind === 'deleted' ? 'It has been removed and the link no longer works.'
                : view.kind === 'error' ? 'Check your connection and reload the page.'
                : 'Large files are deleted automatically after the time the sender chose, or when the sender removes them.'}
            </p>
            <Link to="/" className="btn btn-primary" style={{ gap: '0.5rem' }}><Plus size={16} /> Share a file</Link>
          </section>
        )}
      </main>
    </div>
  )
}
