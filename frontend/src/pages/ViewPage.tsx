import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Copy, Check, Edit3, Download, FileText, Image as ImageIcon, FileArchive, Film, Music, File } from 'lucide-react'
import { getEntry, fileUrl, formatBytes, formatLocalDate, type PublicEntry } from '../lib/api'
import Countdown         from '../components/Countdown'
import MarkdownRenderer  from '../components/MarkdownRenderer'
import Logo              from '../components/Logo'

export default function ViewPage() {
  const { slug } = useParams<{ slug: string }>()
  const navigate  = useNavigate()
  const [entry,   setEntry]   = useState<PublicEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied,  setCopied]  = useState(false)

  useEffect(() => {
    if (!slug) return
    getEntry(slug)
      .then(e => {
        if (!e || Date.now() > e.expiresAt) navigate('/404')
        else setEntry(e)
      })
      .catch(() => navigate('/404'))
      .finally(() => setLoading(false))
  }, [slug, navigate])

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (loading) return <LoadingScreen />
  if (!entry)  return null

  return (
    <div className="page-wrapper" style={{ justifyContent:'flex-start', paddingTop:'2.5rem' }}>
      <div className="content-box animate-fade-up">

        {/* ── Top bar ────────────────────────────────────────────────────── */}
        <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'1rem', marginBottom:'1.5rem', flexWrap:'wrap' }}>
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:'1rem', marginBottom:'0.6rem' }}>
              <Logo size="sm" />
              <span style={{ color:'var(--text-dim)', fontSize:'0.8rem' }}>/</span>
              <Link to="/" style={{ textDecoration:'none', color:'var(--text-muted)', fontSize:'0.8125rem', display:'inline-flex', alignItems:'center', gap:'0.3rem' }}>
                <ArrowLeft size={13} /> New link
              </Link>
            </div>
            <h1 style={{ fontSize:'1.75rem', fontWeight:700, letterSpacing:'-0.02em', color:'#ffffff' }}>
              /{entry.slug}
            </h1>

            {/* Countdown & Type */}
            <div style={{ display:'flex', alignItems:'center', gap:'0.75rem', marginTop:'0.4rem', flexWrap:'wrap' }}>
              <Countdown expiresAt={entry.expiresAt} />
              <span style={{ color:'var(--text-dim)', fontSize:'0.75rem' }}>·</span>
              <span style={{ fontSize:'0.75rem', color:'var(--text-dim)' }}>
                {entry.content && (entry.hasFile || entry.fileName)
                  ? `Text & File · ${formatBytes(entry.fileSize ?? 0)}`
                  : (entry.hasFile || entry.fileName)
                    ? `File · ${formatBytes(entry.fileSize ?? 0)}`
                    : 'Text · Markdown'}
              </span>
            </div>
          </div>

          <div style={{ display:'flex', gap:'0.5rem', flexShrink:0 }}>
            <button className="btn btn-ghost" onClick={copyLink} style={{ fontSize:'0.8125rem', padding:'0.6rem 1rem' }}>
              {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy link</>}
            </button>
            <Link to={`/${slug}/edit`} className="btn btn-ghost" style={{ fontSize:'0.8125rem', padding:'0.6rem 1rem' }}>
              <Edit3 size={14} /> Edit
            </Link>
          </div>
        </div>

        {/* ── Content ────────────────────────────────────────────────────── */}
        <div className="card card-glow" style={{ padding:'2.5rem' }}>
          {entry.content && (
            <MarkdownRenderer content={entry.content} />
          )}

          {(entry.hasFile || entry.fileName) && (
            <div style={{ marginTop: entry.content ? '2rem' : 0, paddingTop: entry.content ? '2rem' : 0, borderTop: entry.content ? '1px solid var(--border)' : 'none' }}>
              <FileCard entry={entry} slug={slug!} />
            </div>
          )}
        </div>

        {/* ── Metadata & Expiry Footer (at the end) ────────────────────────────────── */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:'0.75rem', marginTop:'1.75rem', flexWrap:'wrap', fontSize:'0.8125rem', color:'var(--text-muted)' }}>
          <span><strong style={{ color:'#ffffff' }}>Pub:</strong> {formatLocalDate(entry.createdAt)}</span>
          {entry.updatedAt && (
            <>
              <span style={{ color:'var(--text-dim)' }}>·</span>
              <span><strong style={{ color:'#ffffff' }}>Edit:</strong> {formatLocalDate(entry.updatedAt)}</span>
            </>
          )}
          <span style={{ color:'var(--text-dim)' }}>·</span>
          <span><strong style={{ color:'#ffffff' }}>Views:</strong> {entry.views ?? 1}</span>
          <span style={{ color:'var(--text-dim)' }}>·</span>
          <span style={{ display:'inline-flex', alignItems:'center', gap:'0.35rem' }}>
            <strong style={{ color:'#ffffff' }}>Expires:</strong> <Countdown expiresAt={entry.expiresAt} />
          </span>
        </div>
      </div>
    </div>
  )
}

function FileCard({ entry, slug }: { entry: PublicEntry; slug: string }) {
  const ext = (entry.fileName ?? '').split('.').pop()?.toUpperCase() ?? 'FILE'

  const renderIcon = () => {
    const mime = entry.fileMime ?? ''
    if (mime.startsWith('image/'))  return <ImageIcon size={40} color="#ffffff" />
    if (mime.startsWith('video/'))  return <Film size={40} color="#ffffff" />
    if (mime.startsWith('audio/'))  return <Music size={40} color="#ffffff" />
    if (mime.includes('zip'))        return <FileArchive size={40} color="#ffffff" />
    if (mime === 'application/pdf') return <FileText size={40} color="#ffffff" />
    return <File size={40} color="#ffffff" />
  }

  return (
    <div style={{ display:'flex', alignItems:'center', gap:'1.5rem', flexWrap:'wrap' }}>
      <div style={{ background:'#000000', border:'1px solid var(--border)', padding:'1rem', borderRadius:'12px', display:'flex', alignItems:'center', justifyContent:'center' }}>
        {renderIcon()}
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <p style={{ fontWeight:600, fontSize:'1.1rem', color:'#ffffff', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          {entry.fileName}
        </p>
        <p style={{ color:'var(--text-muted)', fontSize:'0.85rem', marginTop:'0.25rem' }}>
          {ext} · {formatBytes(entry.fileSize ?? 0)}
        </p>
      </div>
      <a
        href={fileUrl(slug)}
        className="btn btn-primary"
        download={entry.fileName}
        style={{ flexShrink:0, gap:'0.5rem' }}
      >
        <Download size={16} /> Download File
      </a>
    </div>
  )
}

function LoadingScreen() {
  return (
    <div className="page-wrapper">
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:'1rem' }}>
        <div className="spinner" style={{ width:32, height:32, borderWidth:3 }} />
        <p style={{ color:'var(--text-muted)', fontSize:'0.9rem' }}>Loading…</p>
      </div>
    </div>
  )
}
