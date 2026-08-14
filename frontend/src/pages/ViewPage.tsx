import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Copy, Check, Edit3, Download, FileText, Image as ImageIcon, FileArchive, Film, Music, File, LayoutList, LayoutGrid, Grid, HardDrive, Terminal, X, QrCode, Lock, Unlock, Upload, Monitor, Sparkles, Folder } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { getEntry, fileUrl, rawUrl, zipUrl, formatBytes, formatLocalDate, type PublicEntry } from '../lib/api'
import { isEncrypted, decryptContent } from '../lib/crypto'
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
  const [showQrModal,       setShowQrModal]       = useState(false)
  const [cliOs,             setCliOs]             = useState<'linux' | 'windows'>('linux')
  const [cliTab,            setCliTab]            = useState<'download' | 'upload'>('download')
  const [cliCmdCopied,      setCliCmdCopied]      = useState<string | null>(null)
  // Encryption state
  const [decryptPassword,   setDecryptPassword]   = useState('')
  const [decryptedContent,  setDecryptedContent]  = useState<string | null>(null)
  const [decryptError,      setDecryptError]      = useState(false)
  const [decrypting,        setDecrypting]        = useState(false)

  useEffect(() => {
    if (!slug) return
    getEntry(slug)
      .then(async e => {
        if (!e || Date.now() > e.expiresAt) {
          navigate('/404')
          return
        }
        setEntry(e)
        if (e.content && isEncrypted(e.content)) {
          const sessionPass = sessionStorage.getItem('clip_decrypt_' + slug)
          if (sessionPass) {
            const result = await decryptContent(e.content, sessionPass)
            if (result !== null) {
              setDecryptedContent(result)
            }
          }
        }
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

  const handleDecrypt = async () => {
    if (!entry?.content || decryptPassword.length < 4) return
    setDecrypting(true)
    setDecryptError(false)
    const result = await decryptContent(entry.content, decryptPassword)
    setDecrypting(false)
    if (result === null) {
      setDecryptError(true)
    } else {
      setDecryptedContent(result)
      sessionStorage.setItem('clip_decrypt_' + slug, decryptPassword)
    }
  }

  if (loading) return <LoadingScreen />
  if (!entry)  return null

  const rawEndpoint  = rawUrl(entry.slug)
  const fileEndpoint = fileUrl(entry.slug)
  const zipEndpoint  = zipUrl(entry.slug)
  const pageUrl      = window.location.href
  const uploadOrigin = window.location.origin

  const contentIsEncrypted = entry.content ? isEncrypted(entry.content) : false
  const displayContent     = contentIsEncrypted ? decryptedContent : entry.content
  const hasActualText      = entry.content && displayContent !== '{"file_lock":true}'

  const activePass = contentIsEncrypted
    ? (decryptPassword || (slug ? sessionStorage.getItem('clip_decrypt_' + slug) : null) || '<password>')
    : null

  const rawUrlWithPass = activePass ? `${rawEndpoint}?pass=${activePass}` : rawEndpoint
  const zipUrlWithPass = activePass ? `${zipEndpoint}?pass=${activePass}` : zipEndpoint
  const fileUrlWithPass = activePass ? `${fileEndpoint}?pass=${activePass}` : fileEndpoint

  const textCurlCmd = cliOs === 'linux' ? `curl -sL "${rawUrlWithPass}"` : `curl.exe -sL "${rawUrlWithPass}"`
  const fileCurlCmd = cliOs === 'linux' ? `curl -fLJO "${fileUrlWithPass}"` : `curl.exe -fLJO "${fileUrlWithPass}"`
  const zipCurlCmd  = cliOs === 'linux' ? `curl -fLO "${zipUrlWithPass}"` : `curl.exe -fLO "${zipUrlWithPass}"`

  // CLI Upload commands
  const uploadCurlText = cliOs === 'linux'
    ? `curl -X POST ${uploadOrigin}/api/entry \\
  -F "type=text" \\
  -F "content=@yourfile.txt" \\
  -F "editCode=YourSecret" \\
  -F "ttl=86400"`
    : `curl.exe -X POST ${uploadOrigin}/api/entry ^
  -F "type=text" ^
  -F "content=@yourfile.txt" ^
  -F "editCode=YourSecret" ^
  -F "ttl=86400"`

  const uploadCurlFile = cliOs === 'linux'
    ? `curl -X POST ${uploadOrigin}/api/entry \\
  -F "type=file" \\
  -F "files=@photo.jpg" \\
  -F "editCode=YourSecret"`
    : `curl.exe -X POST ${uploadOrigin}/api/entry ^
  -F "type=file" ^
  -F "files=@photo.jpg" ^
  -F "editCode=YourSecret"`

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

          <div className="top-bar-actions">
            <button className="btn btn-ghost btn-compact-mobile" onClick={() => setShowCliModal(true)} title="Terminal Commands">
              <Terminal size={14} color="#10b981" /> Terminal CLI
            </button>
            <button className="btn btn-ghost btn-compact-mobile" onClick={() => setShowQrModal(true)} title="Share via QR Code">
              <QrCode size={14} /> QR Code
            </button>
            {entry.content && (
              <button className="btn btn-ghost btn-compact-mobile" onClick={copyTextContent}>
                {textCopied ? <><Check size={14} color="#10b981" /> Copied text</> : <><Copy size={14} /> Copy text</>}
              </button>
            )}
            <button className="btn btn-ghost btn-compact-mobile" onClick={copyLink}>
              {copied ? <><Check size={14} /> Copied link</> : <><Copy size={14} /> Copy link</>}
            </button>
            <Link to={`/${slug}/edit`} className="btn btn-ghost btn-compact-mobile">
              <Edit3 size={14} /> Edit
            </Link>
          </div>
        </div>

        {/* ── Terminal CLI Modal ───────────────────────────────────────────── */}
        {showCliModal && createPortal(
          <div className="modal-backdrop" onClick={() => setShowCliModal(false)}>
            <div className="modal-card card animate-fade-up" onClick={(e) => e.stopPropagation()}>
              {/* Modal Header */}
              <div className="modal-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <Terminal size={18} color="#10b981" />
                  <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#ffffff', margin: 0 }}>Terminal CLI</h3>
                </div>
                <button onClick={() => setShowCliModal(false)} className="btn btn-ghost" style={{ padding: '0.35rem 0.5rem', color: '#a1a1aa' }}>
                  <X size={16} />
                </button>
              </div>

              {/* Modal Body with Custom Scrollbar */}
              <div className="modal-body">
                {/* Download / Upload Tabs */}
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', background: '#000000', padding: '0.25rem', borderRadius: '8px', border: '1px solid #27272a' }}>
                  <button onClick={() => setCliTab('download')} style={{ flex:1, padding:'0.5rem 0.75rem', borderRadius:'6px', cursor:'pointer', fontSize:'0.8125rem', fontWeight:600, border:'none', transition:'all 150ms ease', background: cliTab==='download' ? '#27272a' : 'transparent', color: cliTab==='download' ? '#ffffff' : '#a1a1aa', display:'flex', alignItems:'center', justifyContent:'center', gap:'0.4rem' }}>
                    <Download size={14} /> Download
                  </button>
                  <button onClick={() => setCliTab('upload')} style={{ flex:1, padding:'0.5rem 0.75rem', borderRadius:'6px', cursor:'pointer', fontSize:'0.8125rem', fontWeight:600, border:'none', transition:'all 150ms ease', background: cliTab==='upload' ? '#27272a' : 'transparent', color: cliTab==='upload' ? '#ffffff' : '#a1a1aa', display:'flex', alignItems:'center', justifyContent:'center', gap:'0.4rem' }}>
                    <Upload size={14} /> Upload
                  </button>
                </div>
                {/* OS Selector */}
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', background: '#000000', padding: '0.25rem', borderRadius: '8px', border: '1px solid #27272a' }}>
                  <button onClick={() => setCliOs('linux')} style={{ flex: 1, padding: '0.5rem 0.75rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 600, border: 'none', transition: 'all 150ms ease', background: cliOs === 'linux' ? '#27272a' : 'transparent', color: cliOs === 'linux' ? '#ffffff' : '#a1a1aa', display:'flex', alignItems:'center', justifyContent:'center', gap:'0.4rem' }}>
                    <Terminal size={14} /> Linux / macOS
                  </button>
                  <button onClick={() => setCliOs('windows')} style={{ flex: 1, padding: '0.5rem 0.75rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 600, border: 'none', transition: 'all 150ms ease', background: cliOs === 'windows' ? '#27272a' : 'transparent', color: cliOs === 'windows' ? '#ffffff' : '#a1a1aa', display:'flex', alignItems:'center', justifyContent:'center', gap:'0.4rem' }}>
                    <Monitor size={14} /> Windows (PowerShell)
                  </button>
                </div>

                {/* Encrypted link notification & password statement */}
                {contentIsEncrypted && (
                  <div style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.25)', borderRadius: '8px', padding: '0.65rem 0.85rem', marginBottom: '1.15rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Lock size={14} color="#eab308" style={{ flexShrink: 0 }} />
                    <span style={{ fontSize: '0.75rem', color: '#e4e4e7', lineHeight: 1.45 }}>
                      {activePass && activePass !== '<password>' ? (
                        <>🔒 <strong>Encrypted Link</strong>: Password <strong style={{ color: '#facc15' }}>"{activePass}"</strong> is automatically pre-filled in your commands.</>
                      ) : (
                        <>🔒 <strong>Encrypted Link</strong>: Replace <code style={{ color: '#facc15', background:'rgba(255,255,255,0.08)', padding:'0.1rem 0.35rem', borderRadius:'4px' }}>&lt;password&gt;</code> in the commands with your actual encryption password.</>
                      )}
                    </span>
                  </div>
                )}

                {/* ── DOWNLOAD TAB ──────────────────────────────────────── */}
                {cliTab === 'download' && (<>
                {/* ZIP Bundle */}
                <div style={{ marginBottom: '1.25rem', background: 'linear-gradient(135deg, rgba(16,185,129,0.08) 0%, rgba(96,165,250,0.08) 100%)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '10px', padding: '0.85rem 1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem' }}>
                    <FileArchive size={15} color="#10b981" />
                    <label style={{ fontSize: '0.8rem', fontWeight: 700, color: '#10b981', margin: 0 }}>Download Everything as ZIP:</label>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#000000', padding: '0.65rem 0.85rem', borderRadius: '8px', border: '1px solid #27272a' }}>
                    <code style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.8125rem', color: '#10b981', overflowX: 'auto', whiteSpace: 'nowrap' }}>{zipCurlCmd}</code>
                    <button onClick={() => copyCliCommand(zipCurlCmd, 'zip_cmd')} className="btn btn-ghost" style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem', gap: '0.3rem', flexShrink: 0 }}>
                      {cliCmdCopied === 'zip_cmd' ? <><Check size={13} color="#10b981" /> Copied</> : <><Copy size={13} /> Copy</>}
                    </button>
                  </div>
                  <p style={{ fontSize: '0.72rem', color: '#6b7280', margin: '0.5rem 0 0', lineHeight: 1.4 }}>Downloads <strong style={{ color: '#a1a1aa' }}>{entry.slug}.zip</strong>{(entry.hasFile || entry.fileName) ? ' · text + all files' : ' · text as txt'}.</p>
                </div>

                <p style={{ fontSize: '0.7rem', fontWeight: 600, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 0.85rem' }}>Or download individually:</p>

                {entry.content && (
                  <div style={{ marginBottom: '1.25rem' }}>
                    <div className="modal-inner-card">
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                        <div style={{ display:'flex', alignItems:'center', gap:'0.4rem' }}>
                          <FileText size={14} color="#a3e635" />
                          <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#a3e635' }}>Print text to terminal</span>
                        </div>
                        <button onClick={() => copyCliCommand(textCurlCmd, 'text_cmd')} className="btn btn-ghost" style={{ fontSize: '0.72rem', padding: '0.2rem 0.5rem', gap: '0.3rem' }}>
                          {cliCmdCopied === 'text_cmd' ? <><Check size={12} color="#10b981" /> Copied</> : <><Copy size={12} /> Copy</>}
                        </button>
                      </div>
                      <div style={{ background: '#09090b', padding: '0.5rem 0.75rem', borderRadius: '6px', border: '1px solid #1f1f23' }}>
                        <code style={{ fontFamily: 'monospace', fontSize: '0.775rem', color: '#a3e635', overflowX: 'auto', whiteSpace: 'nowrap', display: 'block' }}>{textCurlCmd}</code>
                      </div>
                    </div>
                  </div>
                )}

                {(entry.hasFile || entry.fileName) && (
                  <div style={{ marginBottom: '1rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:'0.4rem' }}>
                        <Folder size={14} color="#60a5fa" />
                        <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#60a5fa', margin:0 }}>Attached Files ({(entry.files && entry.files.length > 0) ? entry.files.length : 1}):</label>
                      </div>
                    </div>
                    {entry.files && entry.files.length > 1 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', maxHeight: '250px', overflowY: 'auto', paddingRight: '4px' }}>
                        {entry.files.map((f) => {
                          const singleFileUrl = activePass ? `${fileUrl(entry.slug, f.id)}?pass=${activePass}` : fileUrl(entry.slug, f.id)
                          const fCmd = cliOs === 'linux' ? `curl -LO "${singleFileUrl}"` : `curl.exe -LO "${singleFileUrl}"`
                          const fId = `file_${f.id}`
                          return (
                            <div key={f.id} className="modal-inner-card" style={{ padding:'0.65rem 0.85rem' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                                <div style={{ display:'flex', alignItems:'center', gap:'0.35rem', overflow:'hidden' }}>
                                  <FileText size={13} color="#93c5fa" style={{ flexShrink:0 }} />
                                  <span style={{ fontSize: '0.785rem', fontWeight: 600, color: '#e4e4e7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '360px' }} title={f.fileName}>
                                    {f.fileName}
                                  </span>
                                </div>
                                <button onClick={() => copyCliCommand(fCmd, fId)} className="btn btn-ghost" style={{ fontSize: '0.72rem', padding: '0.2rem 0.5rem', gap: '0.25rem', flexShrink: 0 }}>
                                  {cliCmdCopied === fId ? <><Check size={11} color="#10b981" /> Copied</> : <><Copy size={11} /> Copy</>}
                                </button>
                              </div>
                              <div style={{ background: '#09090b', padding: '0.4rem 0.6rem', borderRadius: '6px', border: '1px solid #1f1f23' }}>
                                <code style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.72rem', color: '#7dd3fc', overflowX: 'auto', whiteSpace: 'nowrap', display: 'block' }}>{fCmd}</code>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="modal-inner-card" style={{ padding:'0.65rem 0.85rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:'0.35rem' }}>
                            <FileText size={13} color="#93c5fa" />
                            <span style={{ fontSize: '0.785rem', fontWeight: 600, color: '#e4e4e7' }}>
                              {entry.fileName || 'file'}
                            </span>
                          </div>
                          <button onClick={() => copyCliCommand(fileCurlCmd, 'file_cmd')} className="btn btn-ghost" style={{ fontSize: '0.72rem', padding: '0.2rem 0.5rem', gap: '0.3rem' }}>
                            {cliCmdCopied === 'file_cmd' ? <><Check size={12} color="#10b981" /> Copied</> : <><Copy size={12} /> Copy</>}
                          </button>
                        </div>
                        <div style={{ background: '#09090b', padding: '0.4rem 0.6rem', borderRadius: '6px', border: '1px solid #1f1f23' }}>
                          <code style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#60a5fa', overflowX: 'auto', whiteSpace: 'nowrap', display: 'block' }}>{fileCurlCmd}</code>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div style={{ display:'flex', alignItems:'center', gap:'0.4rem', marginTop:'0.75rem' }}>
                  <Sparkles size={12} color="#71717a" />
                  <p style={{ fontSize: '0.72rem', color: '#71717a', margin: 0, lineHeight: 1.4 }}>Use the ZIP bundle to get everything in one command.</p>
                </div>
                </>)}

                {/* ── UPLOAD TAB ────────────────────────────────────────── */}
                {cliTab === 'upload' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                    <div style={{ background: 'rgba(96,165,250,0.06)', border: '1px solid rgba(96,165,250,0.2)', borderRadius: '10px', padding: '1rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                        <Upload size={15} color="#60a5fa" />
                        <label style={{ fontSize: '0.8rem', fontWeight: 700, color: '#60a5fa', margin: 0 }}>Upload a text paste:</label>
                      </div>
                      <div style={{ background: '#000000', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid #27272a', position: 'relative' }}>
                        <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: '0.775rem', color: '#a3e635', lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{uploadCurlText}</pre>
                        <button onClick={() => copyCliCommand(uploadCurlText, 'upload_text')} className="btn btn-ghost" style={{ position: 'absolute', top: '0.5rem', right: '0.5rem', fontSize: '0.72rem', padding: '0.2rem 0.5rem', gap: '0.25rem' }}>
                          {cliCmdCopied === 'upload_text' ? <><Check size={11} color="#10b981" /> Copied</> : <><Copy size={11} /> Copy</>}
                        </button>
                      </div>
                      <p style={{ fontSize: '0.72rem', color: '#6b7280', margin: '0.6rem 0 0', lineHeight: 1.4 }}>Replace <code style={{ color: '#d1d5db' }}>yourfile.txt</code> with your file path. The JSON response contains the <code style={{ color: '#d1d5db' }}>slug</code> of the new link.</p>
                    </div>

                    <div style={{ background: 'rgba(96,165,250,0.06)', border: '1px solid rgba(96,165,250,0.2)', borderRadius: '10px', padding: '1rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                        <Upload size={15} color="#60a5fa" />
                        <label style={{ fontSize: '0.8rem', fontWeight: 700, color: '#60a5fa', margin: 0 }}>Upload a file:</label>
                      </div>
                      <div style={{ background: '#000000', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid #27272a', position: 'relative' }}>
                        <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: '0.775rem', color: '#7dd3fc', lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{uploadCurlFile}</pre>
                        <button onClick={() => copyCliCommand(uploadCurlFile, 'upload_file')} className="btn btn-ghost" style={{ position: 'absolute', top: '0.5rem', right: '0.5rem', fontSize: '0.72rem', padding: '0.2rem 0.5rem', gap: '0.25rem' }}>
                          {cliCmdCopied === 'upload_file' ? <><Check size={11} color="#10b981" /> Copied</> : <><Copy size={11} /> Copy</>}
                        </button>
                      </div>
                      <p style={{ fontSize: '0.72rem', color: '#6b7280', margin: '0.6rem 0 0', lineHeight: 1.4 }}>Supports images, PDFs, archives, and any file up to 50 MB.</p>
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:'0.4rem' }}>
                      <Sparkles size={12} color="#71717a" />
                      <p style={{ fontSize: '0.72rem', color: '#71717a', margin:0, lineHeight: 1.4 }}>Set <code style={{ color: '#d1d5db' }}>ttl=permanent</code> for a link that never expires.</p>
                    </div>
                  </div>
                )}
              </div>

            </div>
          </div>,
          document.body
        )}

        {/* ── QR Code Modal ──────────────────────────────────────────────────── */}
        {showQrModal && createPortal(
          <div className="modal-backdrop" onClick={() => setShowQrModal(false)}>
            <div className="modal-card-qr card animate-fade-up" onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', width: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <QrCode size={18} />
                  <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#ffffff' }}>Scan to Open</h3>
                </div>
                <button onClick={() => setShowQrModal(false)} className="btn btn-ghost" style={{ padding: '0.35rem 0.5rem', color: '#a1a1aa' }}><X size={16} /></button>
              </div>
              <div style={{ background: '#ffffff', borderRadius: '12px', padding: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.25rem', boxShadow: '0 8px 30px rgba(0,0,0,0.5)', width: 'fit-content' }}>
                <QRCodeSVG
                  value={pageUrl}
                  size={190}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  level="H"
                  includeMargin={false}
                  style={{ display: 'block' }}
                />
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', wordBreak: 'break-all', lineHeight: 1.5, fontFamily: 'var(--font-mono)', margin: '0 0 1rem', textAlign: 'center', width: '100%' }}>{pageUrl}</p>
              <button
                onClick={() => copyCliCommand(pageUrl, 'qr_link')}
                className="btn btn-ghost"
                style={{ width: '100%', fontSize: '0.8125rem', padding: '0.65rem 1rem' }}
              >
                {cliCmdCopied === 'qr_link' ? <><Check size={14} color="#10b981" /> Link Copied!</> : <><Copy size={14} /> Copy Link</>}
              </button>
            </div>
          </div>,
          document.body
        )}

        {/* ── Content ────────────────────────────────────────────────────── */}
        <div className="card card-glow card-content">
          {contentIsEncrypted && !decryptedContent ? (
            <div style={{ textAlign: 'center', padding: '2.5rem 1rem' }}>
              <div style={{ width:60, height:60, borderRadius:'50%', background:'#0a0a0a', border:'1px solid #3f3f46', display:'inline-flex', alignItems:'center', justifyContent:'center', marginBottom:'1.25rem' }}>
                <Lock size={26} color="#ffffff" />
              </div>
              <h2 style={{ fontSize:'1.2rem', fontWeight:700, color:'#ffffff', marginBottom:'0.5rem' }}>This page is password protected</h2>
              <p style={{ fontSize:'0.875rem', color:'var(--text-muted)', marginBottom:'1.5rem', lineHeight:1.6 }}>Enter the view password to decrypt and access the content.<br/>The decryption happens entirely in your browser.</p>
              <div style={{ display:'flex', gap:'0.6rem', maxWidth:'360px', margin:'0 auto' }}>
                <input
                  className="input"
                  type="password"
                  placeholder="Enter password…"
                  value={decryptPassword}
                  onChange={e => { setDecryptPassword(e.target.value); setDecryptError(false) }}
                  onKeyDown={e => e.key === 'Enter' && handleDecrypt()}
                  style={{ flex:1 }}
                  autoFocus
                />
                <button
                  className="btn btn-primary"
                  onClick={handleDecrypt}
                  disabled={decrypting}
                  style={{ flexShrink:0, padding:'0 1.25rem' }}
                >
                  {decrypting ? <div className="spinner" /> : <Unlock size={15} />}
                </button>
              </div>
              {decryptError && (
                <p style={{ marginTop:'0.75rem', fontSize:'0.8125rem', color:'#f87171' }}>❌ Wrong password — please try again.</p>
              )}
            </div>
          ) : (
            <>
              {/* Text content section */}
              {hasActualText && (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', paddingBottom: '0.75rem', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                      <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)' }}>Text Content</span>
                      {decryptedContent && (
                        <span style={{ display:'inline-flex', alignItems:'center', gap:'0.3rem', color:'#4ade80', fontSize:'0.72rem', fontWeight:700 }}><Unlock size={10} /> Decrypted</span>
                      )}
                    </div>
                    <button onClick={copyTextContent} className="btn btn-ghost" style={{ fontSize: '0.785rem', padding: '0.35rem 0.75rem', gap: '0.35rem' }}>
                      {textCopied ? <><Check size={13} color="#10b981" /> Copied</> : <><Copy size={13} /> Copy Text</>}
                    </button>
                  </div>
                  <MarkdownRenderer content={displayContent ?? ''} />
                </div>
              )}

              {/* File card section */}
              {(entry.hasFile || entry.fileName) && (
                <div style={{ marginTop: hasActualText ? '2rem' : 0, paddingTop: hasActualText ? '2rem' : 0, borderTop: hasActualText ? '1px solid var(--border)' : 'none' }}>
                  <FileCard entry={entry} slug={slug!} />
                </div>
              )}
            </>
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
                <strong style={{ color:'#ffffff' }}>File Expires:</strong> <Countdown expiresAt={entry.fileExpiresAt ?? entry.expiresAt} />
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

  const fileExpiresAt = entry.fileExpiresAt ?? entry.expiresAt

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
            background: usedPercent > 90 ? '#ef4444' : usedPercent > 75 ? '#71717a' : 'linear-gradient(90deg, #3b82f6, #60a5fa)',
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
