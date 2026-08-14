import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Copy, Check, Edit3, Download, FileText, Image as ImageIcon, FileArchive, Film, Music, File, LayoutList, LayoutGrid, Grid, HardDrive, Trash2, Terminal, X } from 'lucide-react'
import { getEntry, fileUrl, rawUrl, zipUrl, formatBytes, formatLocalDate, type PublicEntry } from '../lib/api'
import Countdown         from '../components/Countdown'
import MarkdownRenderer  from '../components/MarkdownRenderer'
import Logo              from '../components/Logo'


export default function ViewPage() {
  const { slug } = useParams<{ slug: string }>()
  const navigate  = useNavigate()
  const [entry,             setEntry]             = useState<PublicEntry | null>(null)
  const [loading,           setLoading]           = useState(true)
  const [copied,            setCopied]            = useState(false)
  const [textCopied,        setTextCopied]        = useState(false)
  const [showCliModal,      setShowCliModal]      = useState(false)
  const [cliOs,             setCliOs]             = useState<'linux' | 'windows'>('linux')
  const [cliCmdCopied,      setCliCmdCopied]      = useState<string | null>(null)

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

  const copyCliCommand = (cmd: string, id: string) => {
    navigator.clipboard.writeText(cmd)
    setCliCmdCopied(id)
    setTimeout(() => setCliCmdCopied(null), 2000)
  }

  if (loading) return <LoadingScreen />
  if (!entry)  return null

  const rawEndpoint  = rawUrl(entry.slug)
  const fileEndpoint = fileUrl(entry.slug)
  const zipEndpoint  = zipUrl(entry.slug)

  const textCurlCmd = cliOs === 'linux' ? `curl -sL ${rawEndpoint}` : `curl.exe -sL ${rawEndpoint}`
  const fileCurlCmd = cliOs === 'linux' ? `curl -fLJO ${fileEndpoint}` : `curl.exe -fLJO ${fileEndpoint}`
  const zipCurlCmd  = cliOs === 'linux' ? `curl -fLO ${zipEndpoint}` : `curl.exe -fLO ${zipEndpoint}`

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
                    : 'Text · Markdown'}
              </span>
              <span style={{ color:'var(--text-dim)', fontSize:'0.75rem' }}>·</span>
              <Countdown expiresAt={entry.expiresAt} />
            </div>
          </div>

          <div style={{ display:'flex', gap:'0.5rem', flexShrink:0, flexWrap:'wrap' }}>
            <button className="btn btn-ghost" onClick={() => setShowCliModal(true)} style={{ fontSize:'0.8125rem', padding:'0.6rem 1rem', gap:'0.4rem' }} title="Terminal Download Commands">
              <Terminal size={14} color="#10b981" /> Terminal CLI
            </button>
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

        {/* ── Terminal CLI Modal ───────────────────────────────────────────── */}
        {showCliModal && (
          <div
            style={{
              position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
              background: 'rgba(0, 0, 0, 0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '1.5rem', zIndex: 1000,
            }}
            onClick={() => setShowCliModal(false)}
          >
            <div
              className="card animate-fade-up"
              style={{
                width: '100%', maxWidth: '640px', background: '#0a0a0a', border: '1px solid #27272a',
                padding: '1.75rem', borderRadius: '14px', position: 'relative',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <Terminal size={20} color="#10b981" />
                  <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#ffffff', margin: 0 }}>Terminal Download Commands</h3>
                </div>
                <button onClick={() => setShowCliModal(false)} className="btn btn-ghost" style={{ padding: '0.35rem 0.5rem', color: '#a1a1aa' }}>
                  <X size={16} />
                </button>
              </div>

              {/* OS Selector Tabs */}
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', background: '#000000', padding: '0.25rem', borderRadius: '8px', border: '1px solid #27272a' }}>
                <button
                  onClick={() => setCliOs('linux')}
                  style={{
                    flex: 1, padding: '0.5rem 0.75rem', borderRadius: '6px', cursor: 'pointer',
                    fontSize: '0.8125rem', fontWeight: 600, border: 'none', transition: 'all 150ms ease',
                    background: cliOs === 'linux' ? '#27272a' : 'transparent',
                    color: cliOs === 'linux' ? '#ffffff' : '#a1a1aa',
                  }}
                >
                  🐧 Linux / macOS (bash / zsh)
                </button>
                <button
                  onClick={() => setCliOs('windows')}
                  style={{
                    flex: 1, padding: '0.5rem 0.75rem', borderRadius: '6px', cursor: 'pointer',
                    fontSize: '0.8125rem', fontWeight: 600, border: 'none', transition: 'all 150ms ease',
                    background: cliOs === 'windows' ? '#27272a' : 'transparent',
                    color: cliOs === 'windows' ? '#ffffff' : '#a1a1aa',
                  }}
                >
                  🪟 Windows (PowerShell / CMD)
                </button>
              </div>

              {/* ── ZIP Bundle: Download Everything ───────────────────── */}
              <div style={{ marginBottom: '1.5rem', background: 'linear-gradient(135deg, rgba(16,185,129,0.08) 0%, rgba(96,165,250,0.08) 100%)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '10px', padding: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem' }}>
                  <FileArchive size={15} color="#10b981" />
                  <label style={{ fontSize: '0.8rem', fontWeight: 700, color: '#10b981', margin: 0 }}>
                    Download Everything (Text + All Files) as ZIP:
                  </label>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#000000', padding: '0.65rem 0.85rem', borderRadius: '8px', border: '1px solid #27272a' }}>
                  <code style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.8125rem', color: '#10b981', overflowX: 'auto', whiteSpace: 'nowrap' }}>
                    {zipCurlCmd}
                  </code>
                  <button
                    onClick={() => copyCliCommand(zipCurlCmd, 'zip_cmd')}
                    className="btn btn-ghost"
                    style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem', gap: '0.3rem', flexShrink: 0 }}
                  >
                    {cliCmdCopied === 'zip_cmd' ? <><Check size={13} color="#10b981" /> Copied</> : <><Copy size={13} /> Copy</>}
                  </button>
                </div>
                <p style={{ fontSize: '0.72rem', color: '#6b7280', margin: '0.5rem 0 0', lineHeight: 1.4 }}>
                  Downloads <strong style={{ color: '#a1a1aa' }}>{entry.slug}.zip</strong> containing text as <code style={{ color: '#d1d5db' }}>{entry.slug}.txt</code>{(entry.hasFile || entry.fileName) ? ' + all attached files' : ''} to your current directory.
                </p>
              </div>

              {/* ── Separator ──────────────────────────────────────────── */}
              <p style={{ fontSize: '0.7rem', fontWeight: 600, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 1rem' }}>Or download individually:</p>

              {/* Text Command Section */}
              {entry.content && (
                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#71717a', display: 'block', marginBottom: '0.4rem' }}>
                    📄 Print text to terminal:
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#000000', padding: '0.55rem 0.75rem', borderRadius: '8px', border: '1px solid #27272a' }}>
                    <code style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.775rem', color: '#a3e635', overflowX: 'auto', whiteSpace: 'nowrap' }}>
                      {textCurlCmd}
                    </code>
                    <button
                      onClick={() => copyCliCommand(textCurlCmd, 'text_cmd')}
                      className="btn btn-ghost"
                      style={{ fontSize: '0.72rem', padding: '0.25rem 0.5rem', gap: '0.3rem', flexShrink: 0 }}
                    >
                      {cliCmdCopied === 'text_cmd' ? <><Check size={12} color="#10b981" /> Copied</> : <><Copy size={12} /> Copy</>}
                    </button>
                  </div>
                </div>
              )}

              {/* File Command Section */}
              {(entry.hasFile || entry.fileName) && (
                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#71717a', display: 'block', marginBottom: '0.4rem' }}>
                    📁 Download file(s) to current folder:
                  </label>
                  {entry.files && entry.files.length > 1 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                      {entry.files.map((f) => {
                        const fCmd = cliOs === 'linux' ? `curl -LO ${fileUrl(entry.slug, f.id)}` : `curl.exe -LO ${fileUrl(entry.slug, f.id)}`
                        const fId = `file_${f.id}`
                        return (
                          <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#000000', padding: '0.45rem 0.75rem', borderRadius: '8px', border: '1px solid #27272a' }}>
                            <span style={{ fontSize: '0.7rem', color: '#60a5fa', whiteSpace: 'nowrap', flexShrink: 0 }}>{f.fileName}</span>
                            <code style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.72rem', color: '#7dd3fc', overflowX: 'auto', whiteSpace: 'nowrap' }}>{fCmd}</code>
                            <button
                              onClick={() => copyCliCommand(fCmd, fId)}
                              className="btn btn-ghost"
                              style={{ fontSize: '0.7rem', padding: '0.2rem 0.45rem', gap: '0.25rem', flexShrink: 0 }}
                            >
                              {cliCmdCopied === fId ? <><Check size={11} color="#10b981" /> Copied</> : <><Copy size={11} /> Copy</>}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#000000', padding: '0.55rem 0.75rem', borderRadius: '8px', border: '1px solid #27272a' }}>
                      <code style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.775rem', color: '#60a5fa', overflowX: 'auto', whiteSpace: 'nowrap' }}>
                        {fileCurlCmd}
                      </code>
                      <button
                        onClick={() => copyCliCommand(fileCurlCmd, 'file_cmd')}
                        className="btn btn-ghost"
                        style={{ fontSize: '0.72rem', padding: '0.25rem 0.5rem', gap: '0.3rem', flexShrink: 0 }}
                      >
                        {cliCmdCopied === 'file_cmd' ? <><Check size={12} color="#10b981" /> Copied</> : <><Copy size={12} /> Copy</>}
                      </button>
                    </div>
                  )}
                </div>
              )}

              <p style={{ fontSize: '0.72rem', color: '#52525b', margin: '0.5rem 0 0', lineHeight: 1.4 }}>
                💡 Commands work in any terminal. Use the ZIP bundle to get everything in one go.
              </p>
            </div>
          </div>
        )}

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
  const [layout, setLayout] = useState<'list' | 'grid' | 'tiles'>(() => {
    return (localStorage.getItem('clip_file_layout') as 'list' | 'grid' | 'tiles') || 'list'
  })

  const changeLayout = (mode: 'list' | 'grid' | 'tiles') => {
    setLayout(mode)
    localStorage.setItem('clip_file_layout', mode)
  }

  const filesList = entry.files && entry.files.length > 0
    ? entry.files
    : [{ id: undefined, fileName: entry.fileName ?? 'file', fileMime: entry.fileMime ?? '', fileSize: entry.fileSize ?? 0 }]

  const fileExpiresAt = entry.expiresAt > entry.createdAt + 365 * 86400 * 1000
    ? entry.createdAt + 172_800_000
    : entry.expiresAt

  const totalSize = filesList.reduce((acc, f) => acc + (f.fileSize || 0), 0)
  const maxStorage = 50 * 1024 * 1024
  const usedPercent = Math.min(100, (totalSize / maxStorage) * 100)

  const getIcon = (mime: string, size = 32) => {
    if (mime.startsWith('image/'))  return <ImageIcon size={size} color="#ffffff" />
    if (mime.startsWith('video/'))  return <Film size={size} color="#ffffff" />
    if (mime.startsWith('audio/'))  return <Music size={size} color="#ffffff" />
    if (mime.includes('zip'))        return <FileArchive size={size} color="#ffffff" />
    if (mime === 'application/pdf') return <FileText size={size} color="#ffffff" />
    return <File size={size} color="#ffffff" />
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
      {/* Attached Files Header & Controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            Attached Files ({filesList.length})
          </div>
          {/* Storage Tracker Text */}
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <HardDrive size={12} color="#a1a1aa" />
            <span>{formatBytes(totalSize)} of 50.0 MB used ({usedPercent.toFixed(1)}%)</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          {/* Layout Mode Switcher */}
          <div style={{ display: 'flex', gap: '2px', background: '#000000', padding: '3px', borderRadius: '8px', border: '1px solid var(--border)' }}>
            <button
              onClick={() => changeLayout('list')}
              className="btn btn-ghost"
              style={{ padding: '0.35rem 0.5rem', borderRadius: '6px', background: layout === 'list' ? '#3f3f46' : 'transparent' }}
              title="List View"
            >
              <LayoutList size={15} color={layout === 'list' ? '#ffffff' : '#a1a1aa'} />
            </button>
            <button
              onClick={() => changeLayout('grid')}
              className="btn btn-ghost"
              style={{ padding: '0.35rem 0.5rem', borderRadius: '6px', background: layout === 'grid' ? '#3f3f46' : 'transparent' }}
              title="Grid View"
            >
              <LayoutGrid size={15} color={layout === 'grid' ? '#ffffff' : '#a1a1aa'} />
            </button>
            <button
              onClick={() => changeLayout('tiles')}
              className="btn btn-ghost"
              style={{ padding: '0.35rem 0.5rem', borderRadius: '6px', background: layout === 'tiles' ? '#3f3f46' : 'transparent' }}
              title="Tiles / Icons View"
            >
              <Grid size={15} color={layout === 'tiles' ? '#ffffff' : '#a1a1aa'} />
            </button>
          </div>


          <button
            onClick={handleDownloadAll}
            className="btn btn-primary"
            style={{ fontSize: '0.8125rem', padding: '0.45rem 0.9rem', gap: '0.4rem' }}
          >
            <Download size={14} /> Download All ({filesList.length})
          </button>
        </div>
      </div>

      {/* Storage Usage Progress Bar */}
      <div style={{ width: '100%', height: '6px', background: '#18181b', borderRadius: '3px', overflow: 'hidden', border: '1px solid #27272a' }}>
        <div
          style={{
            height: '100%',
            width: `${usedPercent}%`,
            background: usedPercent > 90 ? '#ef4444' : usedPercent > 75 ? '#f59e0b' : 'linear-gradient(90deg, #3b82f6, #60a5fa)',
            borderRadius: '3px',
            transition: 'width 300ms ease',
          }}
        />
      </div>

      {/* ── 1. LIST VIEW ───────────────────────────────────────────── */}
      {layout === 'list' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
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
      )}

      {/* ── 2. GRID / CARDS VIEW ───────────────────────────────────────────── */}
      {layout === 'grid' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '1rem' }}>
          {filesList.map((item, i) => {
            const ext = (item.fileName ?? '').split('.').pop()?.toUpperCase() ?? 'FILE'
            const downloadLink = fileUrl(slug, item.id)

            return (
              <div
                key={item.id ?? i}
                style={{
                  display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                  padding: '1.25rem', background: '#000000', border: '1px solid var(--border)', borderRadius: '12px',
                  gap: '1rem', textAlign: 'center', alignItems: 'center'
                }}
              >
                <div style={{ background: '#09090b', border: '1px solid var(--border)', padding: '1rem', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '56px', height: '56px' }}>
                  {getIcon(item.fileMime, 36)}
                </div>
                <div style={{ width: '100%', minWidth: 0 }}>
                  <p style={{ fontWeight: 600, fontSize: '0.95rem', color: '#ffffff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.fileName}>
                    {item.fileName}
                  </p>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.785rem', marginTop: '0.35rem' }}>
                    {ext} · {formatBytes(item.fileSize)}
                  </p>
                  <p style={{ color: '#f87171', fontSize: '0.75rem', marginTop: '0.2rem' }}>
                    <Countdown expiresAt={fileExpiresAt} />
                  </p>
                </div>
                <a
                  href={downloadLink}
                  className="btn btn-ghost"
                  download={item.fileName}
                  style={{ width: '100%', justifyContent: 'center', gap: '0.4rem', padding: '0.45rem 0.75rem', fontSize: '0.8rem' }}
                >
                  <Download size={14} /> Download
                </a>
              </div>
            )
          })}
        </div>
      )}

      {/* ── 3. TILES / COMPACT ICONS VIEW ───────────────────────────────────────────── */}
      {layout === 'tiles' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: '0.75rem' }}>
          {filesList.map((item, i) => {
            const downloadLink = fileUrl(slug, item.id)

            return (
              <a
                key={item.id ?? i}
                href={downloadLink}
                download={item.fileName}
                style={{
                  textDecoration: 'none',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center',
                  padding: '1rem 0.75rem', background: '#000000', border: '1px solid var(--border)', borderRadius: '10px',
                  gap: '0.6rem', transition: 'border-color 150ms ease, background 150ms ease'
                }}
                className="tile-card"
              >
                <div style={{ background: '#09090b', border: '1px solid var(--border)', padding: '0.6rem', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {getIcon(item.fileMime, 26)}
                </div>
                <div style={{ width: '100%', minWidth: 0 }}>
                  <p style={{ fontWeight: 600, fontSize: '0.85rem', color: '#ffffff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.fileName}>
                    {item.fileName}
                  </p>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.725rem', marginTop: '2px' }}>
                    {formatBytes(item.fileSize)}
                  </p>
                </div>
                <span style={{ fontSize: '0.725rem', color: '#60a5fa', display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                  <Download size={12} /> Download
                </span>
              </a>
            )
          })}
        </div>
      )}
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
