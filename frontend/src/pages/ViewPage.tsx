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
  const [entry,      setEntry]      = useState<PublicEntry | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [copied,     setCopied]     = useState(false)
  const [textCopied, setTextCopied] = useState(false)

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

  const copyTextContent = () => {
    if (!entry?.content) return
    navigator.clipboard.writeText(entry.content)
    setTextCopied(true)
    setTimeout(() => setTextCopied(false), 2000)
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

            {/* Subtitle & Type */}
            <div style={{ display:'flex', alignItems:'center', gap:'0.75rem', marginTop:'0.4rem', flexWrap:'wrap' }}>
              <span style={{ fontSize:'0.75rem', color:'var(--text-dim)' }}>
                {entry.content && (entry.hasFile || entry.fileName)
                  ? `Text & File · ${formatBytes(entry.fileSize ?? 0)}`
                  : (entry.hasFile || entry.fileName)
                    ? `File · ${formatBytes(entry.fileSize ?? 0)}`
                    : 'Text · Markdown · Permanent Link'}
              </span>
            </div>
          </div>

          <div style={{ display:'flex', gap:'0.5rem', flexShrink:0 }}>
            {entry.content && (
              <button className="btn btn-ghost" onClick={copyTextContent} style={{ fontSize:'0.8125rem', padding:'0.6rem 1rem', gap:'0.4rem' }}>
                {textCopied ? <><Check size={14} color="#10b981" /> Copied text</> : <><Copy size={14} /> Copy text</>}
              </button>
            )}
            <button className="btn btn-ghost" onClick={copyLink} style={{ fontSize:'0.8125rem', padding:'0.6rem 1rem' }}>
              {copied ? <><Check size={14} /> Copied link</> : <><Copy size={14} /> Copy link</>}
            </button>
            <Link to={`/${slug}/edit`} className="btn btn-ghost" style={{ fontSize:'0.8125rem', padding:'0.6rem 1rem' }}>
              <Edit3 size={14} /> Edit
            </Link>
          </div>
        </div>

        {/* ── Content ────────────────────────────────────────────────────── */}
        <div className="card card-glow" style={{ padding:'2.5rem' }}>
          {entry.content && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', paddingBottom: '0.75rem', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)' }}>Text Content</span>
                <button
                  onClick={copyTextContent}
                  className="btn btn-ghost"
                  style={{ fontSize: '0.785rem', padding: '0.35rem 0.75rem', gap: '0.35rem' }}
                >
                  {textCopied ? <><Check size={13} color="#10b981" /> Copied Text</> : <><Copy size={13} /> Copy Text</>}
                </button>
              </div>
              <MarkdownRenderer content={entry.content} />
            </div>
          )}

          {(entry.hasFile || entry.fileName) && (
            <div style={{ marginTop: entry.content ? '2rem' : 0, paddingTop: entry.content ? '2rem' : 0, borderTop: entry.content ? '1px solid var(--border)' : 'none' }}>
              <FileCard entry={entry} slug={slug!} />
            </div>
          )}
        </div>

        {/* ── Metadata Footer ────────────────────────────────── */}
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
          {(entry.hasFile || entry.fileName) && (
            <>
              <span style={{ color:'var(--text-dim)' }}>·</span>
              <span style={{ display:'inline-flex', alignItems:'center', gap:'0.35rem' }}>
                <strong style={{ color:'#ffffff' }}>File Expires:</strong> <Countdown expiresAt={entry.expiresAt > entry.createdAt + 365 * 86400 * 1000 ? entry.createdAt + 172_800_000 : entry.expiresAt} />
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function FileCard({ entry, slug }: { entry: PublicEntry; slug: string }) {
  const filesList = entry.files && entry.files.length > 0
    ? entry.files
    : [{ id: undefined, fileName: entry.fileName ?? 'file', fileMime: entry.fileMime ?? '', fileSize: entry.fileSize ?? 0 }]

  const fileExpiresAt = entry.expiresAt > entry.createdAt + 365 * 86400 * 1000
    ? entry.createdAt + 172_800_000 // 48 hours from creation if stored as permanent
    : entry.expiresAt

  const getIcon = (mime: string) => {
    if (mime.startsWith('image/'))  return <ImageIcon size={32} color="#ffffff" />
    if (mime.startsWith('video/'))  return <Film size={32} color="#ffffff" />
    if (mime.startsWith('audio/'))  return <Music size={32} color="#ffffff" />
    if (mime.includes('zip'))        return <FileArchive size={32} color="#ffffff" />
    if (mime === 'application/pdf') return <FileText size={32} color="#ffffff" />
    return <File size={32} color="#ffffff" />
  }

  const handleDownloadAll = () => {
    filesList.forEach((file, idx) => {
      setTimeout(() => {
        const a = document.createElement('a')
        a.href = fileUrl(slug, file.id)
        a.download = file.fileName
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
      }, idx * 300)
    })
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-muted)' }}>
          Attached Files ({filesList.length})
        </div>
        <button
          onClick={handleDownloadAll}
          className="btn btn-primary"
          style={{ fontSize: '0.8125rem', padding: '0.45rem 0.9rem', gap: '0.4rem' }}
        >
          <Download size={14} /> Download All ({filesList.length})
        </button>
      </div>

      {filesList.map((item, i) => {
        const ext = (item.fileName ?? '').split('.').pop()?.toUpperCase() ?? 'FILE'
        const downloadLink = fileUrl(slug, item.id)

        return (
          <div
            key={item.id ?? i}
            style={{
              display:'flex', alignItems:'center', gap:'1.25rem', flexWrap:'wrap',
              padding:'1rem 1.25rem', background:'#000000', border:'1px solid var(--border)', borderRadius:'12px',
            }}
          >
            <div style={{ background:'#09090b', border:'1px solid var(--border)', padding:'0.75rem', borderRadius:'10px', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              {getIcon(item.fileMime)}
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <p style={{ fontWeight:600, fontSize:'1.05rem', color:'#ffffff', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {item.fileName}
              </p>
              <p style={{ color:'var(--text-muted)', fontSize:'0.8125rem', marginTop:'0.25rem', display:'flex', alignItems:'center', gap:'0.5rem', flexWrap:'wrap' }}>
                <span>{ext} · {formatBytes(item.fileSize)}</span>
                <span style={{ color:'var(--text-dim)' }}>·</span>
                <span style={{ color:'#f87171', display:'inline-flex', alignItems:'center', gap:'0.25rem' }}>
                  Auto-deletes in: <Countdown expiresAt={fileExpiresAt} />
                </span>
              </p>
            </div>
            <a
              href={downloadLink}
              className="btn btn-ghost"
              download={item.fileName}
              style={{ flexShrink:0, gap:'0.5rem', padding:'0.5rem 0.9rem', fontSize:'0.8125rem' }}
            >
              <Download size={14} /> Download
            </a>
          </div>
        )
      })}
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
