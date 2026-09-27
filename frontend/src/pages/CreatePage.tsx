import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FileText, Upload, Link as LinkIcon, ArrowRight, Info, Lock, Zap, AlertTriangle } from 'lucide-react'

import DropZone from '../components/DropZone'
import { createEntryWithProgress, type ApiError } from '../lib/api'
import { encryptContent } from '../lib/crypto'
import { useSeo } from '../lib/useSeo'

type Mode = 'text' | 'file'

const HOST = window.location.origin + '/'

export default function CreatePage() {
  const navigate = useNavigate()

  useSeo({
    title: 'Clip — Free File Sharing & Text Sharing | Encrypted Pastebin',
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

  const errorLabels: Record<string, string> = {
    slug_taken:          'That URL is already taken. Try another.',
    slug_invalid:        'URL must be 3–50 chars, lowercase letters, numbers, hyphens only.',
    slug_reserved:       'That URL is reserved. Please choose another.',
    missing_edit_code:   'Edit code must be 4–128 characters.',
    view_password_short: 'View password must be at least 4 characters.',
    file_too_large:      'File exceeds 50 MB limit.',
    text_too_large:      'Text exceeds 2 MB limit.',
    no_content:          'Please add some content or upload a file.',
    mime_mismatch:       'File type does not match its content.',
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

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
    <div className="page-wrapper" style={{ height: '100vh', maxHeight: '100vh', overflow: 'hidden', padding: '1rem 1.5rem', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <main className="content-box animate-fade-up" style={{ height: '100%', maxHeight: 'calc(100vh - 2rem)', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>

        {/* ── Header & Main SEO Heading ─────────────────────────────────────── */}
        <header style={{ textAlign: 'center', marginBottom: '0.65rem', flexShrink: 0 }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 0.2rem 0', color: '#ffffff', letterSpacing: '-0.02em' }}>
            Instant File &amp; Text Sharing
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8125rem', margin: 0 }}>
            Share markdown, code, notes, and files with custom links. No account required.
          </p>
        </header>



        {/* ── Card ───────────────────────────────────────────────────────── */}
        <form onSubmit={handleSubmit} className="card card-glow card-content" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, padding: '1.25rem 1.75rem', overflow: 'hidden' }}>

          {/* Toggle */}
          <div style={{ display:'flex', gap:'0.5rem', marginBottom:'0.85rem', padding:'0.25rem', background:'#000000', borderRadius:'10px', border:'1px solid var(--border)', flexShrink: 0 }}>
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
              onClick={() => {
                const randomSlug = Math.random().toString(36).slice(2, 8)
                navigate(`/live/${randomSlug}`)
              }}
              style={{
                flex:1, padding:'0.55rem', borderRadius:'8px', cursor:'pointer',
                fontFamily:'var(--font)', fontSize:'0.875rem', fontWeight:600,
                display:'flex', alignItems:'center', justifyContent:'center', gap:'0.5rem',
                transition:'all 150ms ease',
                background: 'transparent',
                color: 'var(--text-muted)',
                border: '1px solid transparent',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.color = '#ffffff'
                e.currentTarget.style.background = '#18181b'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.color = 'var(--text-muted)'
                e.currentTarget.style.background = 'transparent'
              }}
            >
              <Zap size={16} /> Live Pad
            </button>
          </div>

          {/* Main Content input */}
          <div className="field" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, margin: 0 }}>
            {mode === 'text' ? (
              <>
                <label className="label" style={{ marginBottom: '0.35rem', flexShrink: 0 }}>Content <span style={{color:'var(--text-muted)'}}>*</span></label>
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  <textarea
                    className="input"
                    placeholder="Paste your text here… Markdown is supported"
                    value={content}
                    onChange={e => setContent(e.target.value)}
                    style={{ flex: 1, height: '100%', minHeight: 0, resize: 'none' }}
                  />
                </div>
              </>
            ) : (
              <>
                <label className="label" style={{ marginBottom: '0.35rem', flexShrink: 0 }}>File <span style={{color:'var(--text-muted)'}}>*</span></label>
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                  <DropZone
                    onFiles={setFiles}
                    height="100%"
                    uploadProgress={uploadProgress}
                    uploadingFileNames={files.map(f => f.name)}
                  />
                  <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: '0.4rem', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    <p style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', margin: 0 }}>
                      <AlertTriangle size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                      <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>Files auto-delete after 48 hours, regardless of expiration setting</span>
                    </p>
                    <p style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0, paddingLeft: '1.25rem' }}>
                      <span>Entry metadata and text content persist until the selected expiration time.</span>
                    </p>
                  </div>
                </div>
              </>
            )}

          </div>


          {/* Bottom Controls Row */}
          <div style={{ display:'flex', alignItems:'flex-end', gap:'0.85rem', marginTop:'0.9rem', flexWrap:'wrap', flexShrink: 0 }}>
            {/* Custom URL input */}
            <div className="field" style={{ flex:'2 1 240px', marginTop: 0 }}>
              <label className="label">Custom URL <span style={{color:'var(--text-dim)'}}>(optional)</span></label>
              <div className="url-group" style={{ display:'flex', alignItems:'stretch', height:'42px' }}>
                <span className="url-prefix" style={{ height:'42px', boxSizing:'border-box', padding:'0 0.85rem', background:'#000000', border:'1px solid var(--border)', borderRight:'none', borderRadius:'10px 0 0 10px', color:'var(--text-dim)', fontSize:'0.85rem', whiteSpace:'nowrap', display:'flex', alignItems:'center', gap:'0.35rem', transition:'all 180ms ease' }}>
                  <LinkIcon size={14} /> <span className="url-hostname">{HOST}</span>
                </span>
                <input
                  className="input"
                  style={{ height:'42px', boxSizing:'border-box', borderRadius:'0 10px 10px 0', flex:1 }}
                  placeholder="your-custom-slug"
                  value={slug}
                  onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g,''))}
                  maxLength={50}
                  spellCheck={false}
                />
              </div>
            </div>

            {/* Edit code */}
            <div className="field" style={{ flex:'1 1 150px', marginTop: 0 }}>
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

            {/* Expiration Select */}
            <div className="field" style={{ flex:'1 1 150px', marginTop: 0 }}>
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

            {/* Lock / View Password */}
            {(mode === 'text' || mode === 'file') && (
              <div className="field" style={{ flex:'1.2 1 180px', marginTop: 0 }}>
                <label className="label">Password Lock</label>
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
                        <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Encrypt paste</span>
                      </div>
                    ) : (
                      <input
                        type="password"
                        placeholder="View password..."
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
            )}

            {/* Submit Button */}
            <div className="submit-container" style={{ marginTop: 0, flexGrow: 1 }}>
              <button
                type="submit"
                className="btn btn-primary btn-submit"
                disabled={loading}
                style={{ padding:'0 1.5rem', fontSize:'0.9375rem', height:'42px', minWidth:'130px', width: '100%' }}
              >
                {loading ? <><div className="spinner" />Creating…</> : <>Create Link <ArrowRight size={16} /></>}
              </button>
            </div>
          </div>


          {/* Error Message */}
          {error && (
            <div style={{ marginTop:'0.65rem', padding:'0.5rem 0.85rem', background:'#18181b', border:'1px solid #52525b', borderRadius:'10px', fontSize:'0.85rem', color:'#ffffff', flexShrink: 0 }}>
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
            gap: '1.5rem',
            marginTop: '0.65rem',
            fontSize: '0.75rem',
            color: 'var(--text-dim)',
            flexShrink: 0,
            flexWrap: 'wrap',
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
