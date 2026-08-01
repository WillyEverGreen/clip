import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, FileText, Upload, Trash2, Check, ArrowRight, FileIcon, X } from 'lucide-react'
import { verifyEditCode, getEntry, updateEntry, deleteEntry, formatBytes, type PublicEntry, type ApiError } from '../lib/api'
import DropZone from '../components/DropZone'

type Step = 'verify' | 'edit'
type Mode  = 'text' | 'file'

export default function EditPage() {
  const { slug }   = useParams<{ slug: string }>()
  const navigate   = useNavigate()

  // Existing Entry Data
  const [existing,   setExisting]   = useState<PublicEntry | null>(null)
  const [loadingDoc, setLoadingDoc] = useState(true)

  // Step 1 — verify
  const [step,      setStep]      = useState<Step>('verify')
  const [code,      setCode]      = useState('')
  const [verifying, setVerifying] = useState(false)
  const [codeError, setCodeError] = useState(false)
  const verifyRef = useRef<HTMLDivElement>(null)

  // Step 2 — edit
  const [mode,       setMode]       = useState<Mode>('text')
  const [content,    setContent]    = useState('')
  const [file,       setFile]       = useState<File | null>(null)
  const [removeFile, setRemoveFile] = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [deleting,   setDeleting]   = useState(false)
  const [editError,  setEditError]  = useState<string | null>(null)

  // Fetch existing document on mount
  useEffect(() => {
    if (!slug) return
    getEntry(slug)
      .then(data => {
        if (data) {
          setExisting(data)
          setMode(data.type)
          if (data.content) {
            setContent(data.content)
          }
        }
      })
      .finally(() => setLoadingDoc(false))
  }, [slug])

  // Verify
  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    if (!slug || !code) return
    setVerifying(true)
    setCodeError(false)
    const valid = await verifyEditCode(slug, code)
    setVerifying(false)
    if (valid) {
      setStep('edit')
    } else {
      setCodeError(true)
      verifyRef.current?.classList.remove('animate-shake')
      void verifyRef.current?.offsetWidth // reflow
      verifyRef.current?.classList.add('animate-shake')
      setTimeout(() => verifyRef.current?.classList.remove('animate-shake'), 500)
    }
  }

  // Save
  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!slug) return
    setEditError(null)

    const form = new FormData()
    form.append('editCode', code)
    form.append('content', content)
    
    if (removeFile) {
      form.append('removeFile', 'true')
    }
    if (file) {
      form.append('file', file)
    }

    setSaving(true)
    try {
      await updateEntry(slug, form)
      navigate(`/${slug}`)
    } catch (err) {
      const e = err as ApiError
      setEditError(e.error ?? 'Failed to save. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  // Delete
  async function handleDelete() {
    if (!slug || !confirm('Are you sure you want to delete this link? This cannot be undone.')) return
    setDeleting(true)
    try {
      await deleteEntry(slug, code)
      navigate('/')
    } catch {
      setDeleting(false)
    }
  }

  // ── Step 1: Verify ──────────────────────────────────────────────────────────
  if (step === 'verify') {
    return (
      <div className="page-wrapper">
        <div className="content-box animate-fade-up" style={{ maxWidth:'480px' }}>
          <div style={{ textAlign:'center', marginBottom:'2rem' }}>
            <Link to={`/${slug}`} style={{ textDecoration:'none', color:'var(--text-muted)', fontSize:'0.8125rem', display:'inline-flex', alignItems:'center', gap:'0.35rem' }}>
              <ArrowLeft size={14} /> Back to /{slug}
            </Link>
            <h1 style={{ fontSize:'1.6rem', marginTop:'0.75rem', color:'#ffffff' }}>Enter edit code</h1>
            <p style={{ color:'var(--text-muted)', fontSize:'0.875rem', marginTop:'0.5rem' }}>
              Only the person who created this link can edit it.
            </p>
          </div>

          <div ref={verifyRef} className="card card-glow" style={{ padding:'2rem' }}>
            <form onSubmit={handleVerify}>
              <div className="field">
                <label className="label">Edit Code</label>
                <input
                  className="input"
                  type="password"
                  autoFocus
                  placeholder="Your secret edit code"
                  value={code}
                  onChange={e => { setCode(e.target.value); setCodeError(false) }}
                  style={{ borderColor: codeError ? '#ffffff' : undefined }}
                />
                {codeError && <p className="error-msg">Incorrect edit code. Please try again.</p>}
              </div>
              <button
                type="submit"
                className="btn btn-primary btn-full"
                disabled={verifying || code.length < 4 || loadingDoc}
                style={{ marginTop:'1.5rem', gap:'0.5rem' }}
              >
                {verifying ? <><div className="spinner"/>Verifying…</> : <>Verify <ArrowRight size={16} /></>}
              </button>
            </form>
          </div>
        </div>
      </div>
    )
  }

  // ── Step 2: Edit ────────────────────────────────────────────────────────────
  const hasExistingFile = existing?.hasFile || existing?.fileName

  return (
    <div className="page-wrapper" style={{ justifyContent:'flex-start', paddingTop:'3rem' }}>
      <div className="content-box animate-fade-up">
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'1.5rem' }}>
          <div>
            <Link to={`/${slug}`} style={{ textDecoration:'none', color:'var(--text-muted)', fontSize:'0.8125rem', display:'inline-flex', alignItems:'center', gap:'0.35rem' }}>
              <ArrowLeft size={14} /> Cancel
            </Link>
            <h1 style={{ fontSize:'1.6rem', marginTop:'0.4rem', color:'#ffffff' }}>Edit /{slug}</h1>
          </div>
          <button
            className="btn btn-danger"
            onClick={handleDelete}
            disabled={deleting}
            style={{ fontSize:'0.8125rem', gap:'0.4rem' }}
          >
            {deleting ? <div className="spinner"/> : <><Trash2 size={14} /> Delete Link</>}
          </button>
        </div>

        <form onSubmit={handleSave} className="card card-glow" style={{ padding:'2.5rem' }}>
          {/* Mode Tabs */}
          <div style={{ display:'flex', gap:'0.5rem', marginBottom:'2rem', padding:'0.3rem', background:'#000000', borderRadius:'10px', border:'1px solid var(--border)' }}>
            <button
              type="button"
              onClick={() => setMode('text')}
              style={{
                flex:1, padding:'0.7rem', borderRadius:'8px', cursor:'pointer',
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
                flex:1, padding:'0.7rem', borderRadius:'8px', cursor:'pointer',
                fontFamily:'var(--font)', fontSize:'0.875rem', fontWeight:600,
                display:'flex', alignItems:'center', justifyContent:'center', gap:'0.5rem',
                transition:'all 150ms ease',
                background: mode === 'file' ? '#52525b' : 'transparent',
                color: mode === 'file' ? '#ffffff' : 'var(--text-muted)',
                border: mode === 'file' ? '1px solid #71717a' : '1px solid transparent',
              }}
            >
              <Upload size={16} /> File {hasExistingFile && !removeFile && '✓'}
            </button>
          </div>

          <div className="field">
            {mode === 'text' ? (
              <>
                <label className="label">Text Content</label>
                <textarea
                  className="input"
                  style={{ minHeight:'250px' }}
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  placeholder="Paste or edit your text here… Markdown supported"
                />
              </>
            ) : (
              <>
                <label className="label">File Attachment</label>

                {/* Existing file display */}
                {hasExistingFile && !removeFile && !file && (
                  <div style={{ marginBottom:'1.25rem', padding:'1rem 1.25rem', background:'#000000', border:'1px solid var(--border)', borderRadius:'10px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:'0.75rem' }}>
                      <FileIcon size={22} color="#ffffff" />
                      <div>
                        <div style={{ fontSize:'0.9375rem', fontWeight:600, color:'#ffffff' }}>{existing.fileName}</div>
                        {existing.fileSize && (
                          <div style={{ fontSize:'0.75rem', color:'var(--text-muted)', marginTop:'2px' }}>{formatBytes(existing.fileSize)}</div>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => setRemoveFile(true)}
                      style={{ fontSize:'0.75rem', padding:'0.4rem 0.75rem', gap:'0.3rem', color:'#ffffff' }}
                    >
                      <X size={14} /> Remove File
                    </button>
                  </div>
                )}

                {/* New file upload or replacement dropzone */}
                <DropZone onFile={f => { setFile(f); setRemoveFile(false) }} />
              </>
            )}
          </div>

          {editError && (
            <div style={{ marginTop:'1rem', padding:'0.75rem 1rem', background:'#18181b', border:'1px solid #52525b', borderRadius:'10px', fontSize:'0.875rem', color:'#ffffff' }}>
              {editError}
            </div>
          )}

          <div style={{ display:'flex', justifyContent:'flex-end', marginTop:'1.75rem' }}>
            <button type="submit" className="btn btn-primary" disabled={saving} style={{ padding:'0.75rem 2rem', fontSize:'0.9375rem', gap:'0.5rem' }}>
              {saving ? <><div className="spinner"/>Saving…</> : <><Check size={18} /> Save Changes</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
