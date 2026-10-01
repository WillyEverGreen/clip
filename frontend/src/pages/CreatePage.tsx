import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { FileText, Upload, Link as LinkIcon, ArrowRight, Lock, Zap, AlertTriangle, Check, File as FileIcon, X, Plus } from 'lucide-react'

import DropZone from '../components/DropZone'
import { createEntryWithProgress, getUniqueLiveSlug, setLiveSecurity, seedLiveRoom, uploadLiveFile, formatBytes, type ApiError } from '../lib/api'
import { encryptContent, computeAuthHash, generateSalt } from '../lib/crypto'
import { extractFilesFromDataTransfer } from '../lib/fileDrop'
import { getMimeType } from '../lib/fileTypes'
import { useSeo } from '../lib/useSeo'

type Mode = 'text' | 'file' | 'live'

const HOST = window.location.origin + '/'

export default function CreatePage() {
  const navigate = useNavigate()

  useSeo({
    title: 'Clip - Free File Sharing & Text Sharing | Encrypted Pastebin',
    description: 'Share text, code, markdown, and files instantly with custom links. Zero account required, client-side encryption, and real-time live pad collaboration.',
    canonicalUrl: 'https://clip.foo.ng/',
  })

  const [mode,          setMode]          = useState<Mode>('text')
  const [content,       setContent]       = useState('')
  const [files,         setFiles]         = useState<File[]>([])
  const [slug,          setSlug]          = useState('')
  const [editCode,      setEditCode]      = useState('')
  const [ttl,           setTtl]           = useState('21600')
  const [lockContent,   setLockContent]   = useState(false)
  const [viewPassword,  setViewPassword]  = useState('')
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [toast,         setToast]         = useState<{ message: string; type: 'success' | 'info' | 'error' } | null>(null)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(t)
  }, [toast])

  // Clipboard paste listener: paste images or files anywhere (Ctrl+V / Cmd+V)
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      if (!e.clipboardData) return
      const items = Array.from(e.clipboardData.items || [])
      const fileItems = items.filter(item => item.kind === 'file')

      if (fileItems.length > 0) {
        e.preventDefault()
        const extracted = await extractFilesFromDataTransfer(e.clipboardData)
        if (extracted.length > 0) {
          const renamed = extracted.map(file => {
            const name = file.name === 'image.png' || !file.name
              ? `screenshot_${new Date().toISOString().replace(/[:.]/g, '-')}.png`
              : file.name
            return new File([file], name, { type: file.type || getMimeType(name) })
          })

          setFiles(prev => {
            const deduped = renamed.filter(
              nf => !prev.some(pf => pf.name === nf.name && pf.size === nf.size)
            )
            return [...prev, ...deduped]
          })
          if (mode !== 'file' && mode !== 'live') {
            setMode('file')
          }
          setToast({ message: `Pasted ${renamed.length} file(s) from clipboard!`, type: 'success' })
        }
      }
    }

    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [mode])

  const errorLabels: Record<string, string> = {
    slug_taken:          'That URL is already taken. Try another.',
    slug_invalid:        'URL must be 3–50 chars, lowercase letters, numbers, hyphens only.',
    slug_reserved:       'That URL is reserved. Please choose another.',
    missing_edit_code:   'Edit code must be 4–128 characters.',
    view_password_short: 'Password must be at least 4 characters.',
    file_too_large:      'File exceeds 50 MB limit.',
    text_too_large:      'Text exceeds 2 MB limit.',
    no_content:          'Please add some content or upload a file.',
    mime_mismatch:       'File type does not match its content.',
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    // ── Live Pad Hosting flow ────────────────────────────────────────────────
    if (mode === 'live') {
      if (lockContent && viewPassword.length < 4) { setError('view_password_short'); return }
      setLoading(true)
      try {
        let targetSlug = slug.trim().toLowerCase()
        if (!targetSlug) {
          targetSlug = await getUniqueLiveSlug()
        }
        if (lockContent && viewPassword) {
          const salt = generateSalt()
          const authHash = await computeAuthHash(viewPassword, salt)
          await setLiveSecurity(targetSlug, true, authHash, salt)
          sessionStorage.setItem('clip_live_pass_' + targetSlug, viewPassword)
        }
        if (content.trim()) {
          await seedLiveRoom(targetSlug, content.trim())
        }
        if (files && files.length > 0) {
          for (const f of files) {
            await uploadLiveFile(targetSlug, f)
          }
        }
        navigate(`/live/${targetSlug}`)
      } catch (err) {
        const e = err as ApiError
        setError(e.error ?? 'Failed to initialize Live Pad room.')
      } finally {
        setLoading(false)
      }
      return
    }

    // ── Standard Clip creation flow ──────────────────────────────────────────
    if (editCode.length < 4) { setError('missing_edit_code'); return }
    if (mode === 'text' && !content.trim()) { setError('no_content'); return }
    if (mode === 'file' && files.length === 0) { setError('no_content'); return }
    if (lockContent && viewPassword.length < 4) { setError('view_password_short'); return }

    const form = new FormData()
    form.append('type', mode)
    form.append('editCode', editCode)
    form.append('ttl', ttl)
    if (slug.trim()) form.append('slug', slug.trim().toLowerCase())
    if (mode === 'text') {
      const finalContent = lockContent && viewPassword
        ? await encryptContent(content, viewPassword)
        : content
      form.append('content', finalContent)
    }
    if (mode === 'file') {
      files.forEach((f) => {
        form.append('files', f)
        form.append('file', f)
      })
      if (lockContent && viewPassword) {
        const placeholder = await encryptContent('{"file_lock":true}', viewPassword)
        form.append('content', placeholder)
      }
    }

    setLoading(true)
    try {
      const isFileMode = mode === 'file' && files.length > 0
      const { slug: newSlug } = await createEntryWithProgress(form, (pct) => {
        if (isFileMode) setUploadProgress(pct)
      })
      // Hold the 100% 'complete' state for 800ms so users see the green tick
      if (isFileMode) {
        setUploadProgress(100)
        await new Promise((r) => setTimeout(r, 800))
      }
      navigate(`/${newSlug}`)
    } catch (err) {
      const e = err as ApiError
      setError(e.error ?? 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
      setUploadProgress(null)
    }
  }

  return (
    <div className="page-wrapper create-page-wrapper">
      <main className="content-box animate-fade-up create-content-box">

        {/* ── Toast Notification ───────────────────────────────────────────── */}
        {toast && (
          <div style={{
            position: 'fixed',
            top: '1.5rem',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 9999,
            background: '#18181b',
            border: '1px solid #3f3f46',
            color: '#ffffff',
            padding: '0.6rem 1.25rem',
            borderRadius: '10px',
            fontSize: '0.85rem',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            boxShadow: '0 8px 30px rgba(0,0,0,0.6)',
          }}>
            <Check size={14} color="#10b981" />
            <span>{toast.message}</span>
          </div>
        )}

        {/* ── Header & Main SEO Heading ─────────────────────────────────────── */}
        <header style={{ textAlign: 'center', marginBottom: '1rem', flexShrink: 0 }}>
          <h1 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '0 0 0.25rem 0', color: '#ffffff', letterSpacing: '-0.02em' }}>
            Instant File &amp; Text Sharing
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0, lineHeight: 1.4 }}>
            Share markdown, code, notes, and files with custom links. No account required.
          </p>
        </header>

        {/* ── Card ───────────────────────────────────────────────────────── */}
        <form onSubmit={handleSubmit} className="card card-glow card-content create-card">

          {/* Toggle */}
          <div className="toggle-pill" style={{ display:'flex', gap:'0.4rem', marginBottom:'1rem', padding:'0.25rem', background:'#000000', borderRadius:'10px', border:'1px solid var(--border)', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setMode('text')}
              style={{
                flex:1, padding:'0.55rem', borderRadius:'8px', cursor:'pointer',
                fontFamily:'var(--font)', fontSize:'0.875rem', fontWeight:600,
                display:'flex', alignItems:'center', justifyContent:'center', gap:'0.5rem',
                transition:'all 150ms ease',
                background: mode === 'text' ? '#52525b' : 'transparent',
                color: mode === 'text' ? '#ffffff' : 'var(--text-muted)',
                border: mode === 'text' ? '1px solid #71717a' : '1px solid transparent',
              }}
            >
              <FileText size={16} /> Text
            </button>
            <button
              type="button"
              onClick={() => setMode('file')}
              style={{
                flex:1, padding:'0.55rem', borderRadius:'8px', cursor:'pointer',
                fontFamily:'var(--font)', fontSize:'0.875rem', fontWeight:600,
                display:'flex', alignItems:'center', justifyContent:'center', gap:'0.5rem',
                transition:'all 150ms ease',
                background: mode === 'file' ? '#52525b' : 'transparent',
                color: mode === 'file' ? '#ffffff' : 'var(--text-muted)',
                border: mode === 'file' ? '1px solid #71717a' : '1px solid transparent',
              }}
            >
              <Upload size={16} /> File
            </button>
            <button
              type="button"
              onClick={() => setMode('live')}
              style={{
                flex:1, padding:'0.55rem', borderRadius:'8px', cursor:'pointer',
                fontFamily:'var(--font)', fontSize:'0.875rem', fontWeight:600,
                display:'flex', alignItems:'center', justifyContent:'center', gap:'0.5rem',
                transition:'all 150ms ease',
                background: mode === 'live' ? '#52525b' : 'transparent',
                color: mode === 'live' ? '#ffffff' : 'var(--text-muted)',
                border: mode === 'live' ? '1px solid #71717a' : '1px solid transparent',
              }}
            >
              <Zap size={16} /> Live Pad
            </button>
          </div>

          {/* Main Content input */}
          <div className="field" style={{ margin: 0, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {mode === 'text' && (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                <label className="label" style={{ marginBottom: '0.4rem', flexShrink: 0 }}>Content <span style={{color:'var(--text-muted)'}}>*</span></label>
                <textarea
                  className="input create-textarea"
                  placeholder="Paste your text here… Markdown is supported (or press Ctrl+V to paste files/images)"
                  value={content}
                  onChange={e => setContent(e.target.value)}
                />
              </div>
            )}

            {mode === 'file' && (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                <label className="label" style={{ marginBottom: '0.4rem', flexShrink: 0 }}>File <span style={{color:'var(--text-muted)'}}>*</span></label>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                  <DropZone
                    files={files}
                    onFiles={setFiles}
                    height="100%"
                    uploadProgress={uploadProgress}
                    uploadingFileNames={files.map(f => f.name)}
                  />
                </div>
                <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: '0.45rem', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                  <p style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', margin: 0 }}>
                    <AlertTriangle size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                    <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>Files auto-delete after 48 hours, regardless of expiration setting</span>
                  </p>
                  <p style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0, paddingLeft: '1.15rem' }}>
                    <span>Tip: Press Ctrl+V anywhere on the page to paste screenshots or files directly.</span>
                  </p>
                </div>
              </div>
            )}

            {mode === 'live' && (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem', flexShrink: 0 }}>
                  <label className="label" style={{ margin: 0 }}>
                    Initial Room Text <span style={{ color: 'var(--text-dim)' }}>(optional)</span>
                  </label>
                  <label
                    className="btn btn-secondary"
                    style={{
                      padding: '0.2rem 0.55rem',
                      fontSize: '0.75rem',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      cursor: 'pointer',
                      margin: 0,
                    }}
                    title="Attach files to this LivePad"
                  >
                    <Plus size={13} /> Attach Files
                    <input
                      type="file"
                      multiple
                      style={{ display: 'none' }}
                      onChange={e => {
                        if (e.target.files && e.target.files.length > 0) {
                          const newFiles = Array.from(e.target.files)
                          setFiles(prev => {
                            const deduped = newFiles.filter(
                              nf => !prev.some(pf => pf.name === nf.name && pf.size === nf.size)
                            )
                            return [...prev, ...deduped]
                          })
                          e.target.value = ''
                        }
                      }}
                    />
                  </label>
                </div>

                <textarea
                  className="input create-textarea"
                  placeholder="Enter starting notes, code, or agenda (participants can collaborate in real time)..."
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  style={{ minHeight: files.length > 0 ? '110px' : '0' }}
                />

                {/* Attached Files List in Live Pad mode */}
                {files.length > 0 && (
                  <div style={{ marginTop: '0.5rem', flexShrink: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                        Attached Files ({files.length}) · {formatBytes(files.reduce((a, f) => a + f.size, 0))}
                      </span>
                      <button
                        type="button"
                        onClick={() => setFiles([])}
                        className="btn btn-ghost"
                        style={{ padding: '0.15rem 0.4rem', fontSize: '0.7rem', color: 'var(--text-dim)' }}
                      >
                        Clear All
                      </button>
                    </div>
                    <div style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '0.35rem',
                      maxHeight: '100px',
                      overflowY: 'auto',
                      padding: '0.35rem',
                      background: '#050505',
                      border: '1px solid var(--border)',
                      borderRadius: '8px'
                    }}>
                      {files.map((file, idx) => (
                        <div
                          key={idx}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.35rem',
                            padding: '0.25rem 0.5rem',
                            background: '#121214',
                            border: '1px solid #27272a',
                            borderRadius: '6px',
                            fontSize: '0.75rem',
                            maxWidth: '240px'
                          }}
                        >
                          <FileIcon size={12} style={{ color: '#a1a1aa', flexShrink: 0 }} />
                          <span
                            style={{
                              color: '#ffffff',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              flex: 1
                            }}
                            title={file.name}
                          >
                            {file.name}
                          </span>
                          <span style={{ color: 'var(--text-dim)', fontSize: '0.7rem', flexShrink: 0 }}>
                            {formatBytes(file.size)}
                          </span>
                          <button
                            type="button"
                            onClick={() => setFiles(prev => prev.filter((_, i) => i !== idx))}
                            className="btn btn-ghost"
                            style={{ padding: '0.1rem 0.2rem', color: 'var(--text-dim)', marginLeft: '0.2rem' }}
                            title="Remove file"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <p style={{ fontSize: '0.785rem', color: 'var(--text-dim)', marginTop: '0.4rem', marginBottom: 0, flexShrink: 0, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <Zap size={13} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
                  <span>Live Pad supports real-time collaborative typing, instant file sharing, and cross-device phone pairing via QR code.</span>
                </p>
              </div>
            )}
          </div>

          {/* Bottom Controls Grid */}
          <div className={`create-controls-grid ${mode === 'live' ? 'create-controls-grid--live' : ''}`}>
            {/* Custom URL input */}
            <div className="field field-custom-url">
              <label className="label">Custom URL <span style={{color:'var(--text-dim)'}}>(optional)</span></label>
              <div className="url-group" style={{ display:'flex', alignItems:'stretch', height:'42px' }}>
                <span className="url-prefix" style={{ height:'42px', boxSizing:'border-box', padding:'0 0.85rem', background:'#000000', border:'1px solid var(--border)', borderRight:'none', borderRadius:'10px 0 0 10px', color:'var(--text-dim)', fontSize:'0.85rem', whiteSpace:'nowrap', display:'flex', alignItems:'center', gap:'0.35rem', transition:'all 180ms ease' }}>
                  <LinkIcon size={14} /> <span className="url-hostname">{mode === 'live' ? HOST + 'live/' : HOST}</span>
                </span>
                <input
                  className="input"
                  style={{ height:'42px', boxSizing:'border-box', borderRadius:'0 10px 10px 0', flex:1 }}
                  placeholder={mode === 'live' ? 'my-live-room' : 'your-custom-slug'}
                  value={slug}
                  onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g,''))}
                  maxLength={50}
                  spellCheck={false}
                />
              </div>
            </div>

            {/* Edit code (only for text/file modes) */}
            {mode !== 'live' && (
              <div className="field field-edit-code">
                <label className="label">Edit Code <span style={{color:'var(--text-muted)'}}>*</span></label>
                <input
                  className="input"
                  type="password"
                  placeholder="Secret edit code"
                  value={editCode}
                  onChange={e => setEditCode(e.target.value)}
                  minLength={4}
                  maxLength={128}
                  style={{ height:'42px', boxSizing:'border-box' }}
                />
              </div>
            )}

            {/* Expiration Select (only for text/file modes) */}
            {mode !== 'live' && (
              <div className="field field-expiration">
                <label className="label">Expiration <span style={{color:'var(--text-muted)'}}>*</span></label>
                <select
                  className="input"
                  value={ttl}
                  onChange={e => setTtl(e.target.value)}
                  style={{ height:'42px', boxSizing:'border-box', padding: '0 0.75rem', cursor: 'pointer', background: '#000000', color: '#ffffff', border: '1px solid var(--border)' }}
                >
                  <option value="600">10 Minutes</option>
                  <option value="3600">1 Hour</option>
                  <option value="21600">6 Hours (Default)</option>
                  <option value="86400">1 Day</option>
                  <option value="604800">7 Days</option>
                  <option value="2592000">30 Days</option>
                  <option value="permanent">Permanent</option>
                </select>
              </div>
            )}

            {/* Lock / View Password */}
            <div className="field field-password-lock">
              <label className="label">{mode === 'live' ? 'Room Security' : 'Password Lock'}</label>
              <div style={{ display:'flex', flexDirection:'column', gap:'0.4rem' }}>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    cursor: 'pointer',
                    userSelect: 'none',
                    height: '42px',
                    padding: '0 0.75rem',
                    background: '#000000',
                    border: lockContent ? '1px solid var(--border-active)' : '1px solid var(--border)',
                    borderRadius: '10px',
                    width: '100%',
                    boxSizing: 'border-box'
                  }}
                >
                  <input
                    type="checkbox"
                    checked={lockContent}
                    onChange={e => {
                      setLockContent(e.target.checked)
                      if (!e.target.checked) setViewPassword('')
                    }}
                    style={{ accentColor: '#71717a', width: 15, height: 15, cursor: 'pointer' }}
                  />
                  {!lockContent ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flex: 1 }}>
                      <Lock size={13} style={{ color: 'var(--text-dim)' }} />
                      <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                        {mode === 'live' ? 'Password protect room' : 'Encrypt paste'}
                      </span>
                    </div>
                  ) : (
                    <input
                      type="password"
                      placeholder={mode === 'live' ? 'Room password (min 4 chars)...' : 'View password...'}
                      value={viewPassword}
                      onChange={e => setViewPassword(e.target.value)}
                      minLength={4}
                      maxLength={128}
                      onClick={e => e.stopPropagation()}
                      style={{
                        flex: 1,
                        height: '32px',
                        background: 'transparent',
                        border: 'none',
                        padding: '0 4px',
                        fontSize: '0.8125rem',
                        color: '#ffffff',
                        outline: 'none',
                        boxShadow: 'none'
                      }}
                      autoFocus
                    />
                  )}
                </label>
                
                {/* Warning for file-only pastes with encryption */}
                {lockContent && mode === 'file' && files.length > 0 && (
                  <div style={{ 
                    fontSize: '0.75rem', 
                    color: 'var(--text-muted)', 
                    padding: '0.5rem 0.65rem',
                    background: '#141414',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.45rem',
                    marginTop: '0.35rem'
                  }}>
                    <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: '2px', color: '#ffffff' }} />
                    <span>Only text is encrypted. File binaries remain unencrypted in storage.</span>
                  </div>
                )}
              </div>
            </div>

            {/* Submit Button */}
            <div className="field field-submit">
              <button
                type="submit"
                className="btn btn-primary btn-submit"
                disabled={loading}
                style={{ padding:'0 1.5rem', fontSize:'0.9375rem', height:'42px', width: '100%', gap: '0.5rem' }}
              >
                {loading ? (
                  <><div className="spinner" />{mode === 'live' ? 'Opening Room…' : 'Creating…'}</>
                ) : mode === 'live' ? (
                  <><Zap size={16} /> Host LivePad <ArrowRight size={16} /></>
                ) : (
                  <>Create Link <ArrowRight size={16} /></>
                )}
              </button>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div style={{ marginTop:'0.75rem', padding:'0.55rem 0.85rem', background:'#18181b', border:'1px solid #52525b', borderRadius:'10px', fontSize:'0.85rem', color:'#ffffff' }}>
              {errorLabels[error] ?? error}
            </div>
          )}
        </form>

        {/* ── Semantic SEO Feature Highlights (Crawlable) ──────────────────── */}
        <aside
          aria-label="Features and capabilities"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '1.25rem',
            marginTop: '1rem',
            marginBottom: '0.75rem',
            fontSize: '0.75rem',
            color: 'var(--text-dim)',
            flexShrink: 0,
            flexWrap: 'wrap',
            padding: '0 0.5rem',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <Zap size={13} style={{ color: 'var(--text-muted)' }} /> Real-Time Live Sync
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <Lock size={13} style={{ color: 'var(--text-muted)' }} /> AES-256 Client-Side Encryption
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <Upload size={13} style={{ color: 'var(--text-muted)' }} /> Up to 25 MB File Uploads
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <LinkIcon size={13} style={{ color: 'var(--text-muted)' }} /> Custom Slugs &amp; CLI Access
          </span>
        </aside>
      </main>
    </div>
  )
}
