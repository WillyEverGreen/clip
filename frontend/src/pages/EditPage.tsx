import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, FileText, Upload, Trash2, Check, ArrowRight, FileIcon, X, Lock, Unlock } from 'lucide-react'
import { verifyEditCode, getEntry, updateEntryWithProgress, deleteEntry, formatBytes, type PublicEntry, type ApiError } from '../lib/api'
import { isEncrypted, decryptContent, encryptContent } from '../lib/crypto'
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
  const [mode,              setMode]              = useState<Mode>('text')
  const [content,           setContent]           = useState('')
  const [keptExistingFiles, setKeptExistingFiles] = useState<any[]>([])
  const [newFiles,          setNewFiles]          = useState<File[]>([])
  const [saving,            setSaving]            = useState(false)
  const [deleting,          setDeleting]          = useState(false)
  const [editError,         setEditError]         = useState<string | null>(null)
  const [uploadProgress,    setUploadProgress]    = useState<number | null>(null)

  // Encryption states
  const [viewPassword,         setViewPassword]         = useState('')
  const [originalPassword,     setOriginalPassword]     = useState('') // Store original password for validation
  const [isLocked,             setIsLocked]             = useState(false)
  const [decryptPasswordInput, setDecryptPasswordInput] = useState('')
  const [decryptError,         setDecryptError]         = useState(false)

  // Fetch existing document on mount
  useEffect(() => {
    if (!slug) return
    getEntry(slug)
      .then(async data => {
        if (data) {
          setExisting(data)
          setMode(data.type)
          if (data.files && data.files.length > 0) {
            setKeptExistingFiles(data.files)
          } else if (data.fileName) {
            setKeptExistingFiles([{ id: 'f_1', fileName: data.fileName, fileSize: data.fileSize }])
          }

          if (data.content) {
            if (isEncrypted(data.content)) {
              // Try auto-decryption using cached sessionStorage password
              const sessionPass = sessionStorage.getItem('clip_decrypt_' + slug)
              if (sessionPass) {
                const decrypted = await decryptContent(data.content, sessionPass)
                if (decrypted !== null) {
                  setContent(decrypted === '{"file_lock":true}' ? '' : decrypted)
                  setViewPassword(sessionPass)
                  setOriginalPassword(sessionPass) // Store original password
                } else {
                  setIsLocked(true)
                }
              } else {
                setIsLocked(true)
              }
            } else {
              setContent(data.content)
            }
          }
        }
      })
      .finally(() => setLoadingDoc(false))
  }, [slug])

  // Unlock encrypted paste in editor
  async function handleDecryptEdit() {
    if (!existing?.content || !slug) return
    setDecryptError(false)
    const decrypted = await decryptContent(existing.content, decryptPasswordInput)
    if (decrypted !== null) {
      setContent(decrypted === '{"file_lock":true}' ? '' : decrypted)
      setViewPassword(decryptPasswordInput)
      setOriginalPassword(decryptPasswordInput) // Store original password
      setIsLocked(false)
      sessionStorage.setItem('clip_decrypt_' + slug, decryptPasswordInput)
    } else {
      setDecryptError(true)
    }
  }

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

    // Validate password hasn't changed if content was originally encrypted
    if (originalPassword && viewPassword && viewPassword !== originalPassword) {
      const confirmed = confirm(
        '⚠️ Warning: The password has changed.\n\n' +
        'Re-encrypting with a different password will make the paste inaccessible with the old password.\n\n' +
        'Are you sure you want to continue?'
      )
      if (!confirmed) return
    }

    setSaving(true)
    try {
      let finalContent = content
      if (viewPassword) {
        finalContent = await encryptContent(content || '{"file_lock":true}', viewPassword)
      }

      const form = new FormData()
      form.append('editCode', code)
      form.append('content', finalContent)
      
      if (keptExistingFiles.length > 0) {
        keptExistingFiles.forEach((f) => {
          if (f.id) form.append('keepFileIds', f.id)
        })
      } else if (newFiles.length === 0) {
        form.append('removeFile', 'true')
      }

      if (newFiles.length > 0) {
        newFiles.forEach((f) => {
          form.append('files', f)
          form.append('file', f)
        })
      }

      const hasNewFiles = newFiles.length > 0
      await updateEntryWithProgress(slug, form, (pct) => {
        if (hasNewFiles) setUploadProgress(pct)
      })
      if (hasNewFiles) {
        setUploadProgress(100)
        await new Promise((r) => setTimeout(r, 800))
      }
      navigate(`/${slug}`)
    } catch (err) {
      const e = err as ApiError
      setEditError(e.error ?? 'Failed to save. Please try again.')
    } finally {
      setSaving(false)
      setUploadProgress(null)
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
  const hasExistingFile = keptExistingFiles.length > 0

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

        <div className="card card-glow card-content">
          {isLocked ? (
            <div style={{ textAlign:'center', padding:'2.5rem 1rem' }}>
              <div style={{ width:54, height:54, borderRadius:'50%', background:'#121212', border:'1px solid #3f3f46', display:'inline-flex', alignItems:'center', justifyContent:'center', marginBottom:'1.25rem' }}>
                <Lock size={24} color="#ffffff" />
              </div>
              <h3 style={{ fontSize:'1.2rem', fontWeight:700, color:'#ffffff', marginBottom:'0.5rem' }}>Paste is Encrypted</h3>
              <p style={{ fontSize:'0.85rem', color:'var(--text-muted)', marginBottom:'1.75rem', maxWidth:'360px', margin:'0 auto 1.75rem', lineHeight:1.6 }}>
                Enter the view password to decrypt and edit this paste.
              </p>
              <div style={{ display:'flex', gap:'0.6rem', maxWidth:'320px', margin:'0 auto' }}>
                <input
                  className="input"
                  type="password"
                  placeholder="Enter view password…"
                  value={decryptPasswordInput}
                  onChange={e => { setDecryptPasswordInput(e.target.value); setDecryptError(false) }}
                  onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), handleDecryptEdit())}
                  style={{ flex:1 }}
                  autoFocus
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleDecryptEdit}
                  style={{ flexShrink:0, padding:'0 1.25rem' }}
                >
                  <Unlock size={15} />
                </button>
              </div>
              {decryptError && (
                <p style={{ marginTop:'0.75rem', fontSize:'0.8125rem', color:'#f87171' }}>❌ Wrong password — please try again.</p>
              )}
            </div>
          ) : (
            <form onSubmit={handleSave}>
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
                  <Upload size={16} /> File {hasExistingFile && '✓'}
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

                    {/* Existing files list */}
                    {keptExistingFiles.length > 0 && (
                      <div style={{ marginBottom:'1.25rem', display:'flex', flexDirection:'column', gap:'0.75rem' }}>
                        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                          <span style={{ fontSize:'0.85rem', fontWeight:600, color:'var(--text-muted)' }}>
                            Existing Attached Files ({keptExistingFiles.length})
                          </span>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => setKeptExistingFiles([])}
                            style={{ fontSize:'0.75rem', padding:'0.35rem 0.65rem', gap:'0.3rem', color:'#f87171' }}
                          >
                            <X size={14} /> Remove All Existing Files
                          </button>
                        </div>

                        {keptExistingFiles.map((item, idx) => (
                          <div key={item.id ?? idx} style={{ padding:'0.85rem 1.1rem', background:'#000000', border:'1px solid var(--border)', borderRadius:'10px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                            <div style={{ display:'flex', alignItems:'center', gap:'0.75rem' }}>
                              <FileIcon size={20} color="#ffffff" />
                              <div>
                                <div style={{ fontSize:'0.9rem', fontWeight:600, color:'#ffffff' }}>{item.fileName}</div>
                                {item.fileSize && (
                                  <div style={{ fontSize:'0.75rem', color:'var(--text-muted)', marginTop:'2px' }}>{formatBytes(item.fileSize)}</div>
                                )}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => setKeptExistingFiles(prev => prev.filter((_, i) => i !== idx))}
                              style={{ padding:'0.25rem 0.5rem', color:'var(--text-muted)', borderRadius:'6px' }}
                              title="Remove file"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Add new / additional files dropzone */}
                    <div>
                      {keptExistingFiles.length > 0 && (
                        <div style={{ fontSize:'0.85rem', fontWeight:600, color:'var(--text-muted)', marginBottom:'0.5rem' }}>
                          + Add More Files
                        </div>
                      )}
                      <DropZone
                        onFiles={fs => setNewFiles(fs)}
                        height="202px"
                        uploadProgress={uploadProgress}
                        uploadingFileNames={newFiles.map(f => f.name)}
                      />
                      <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        <p style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0 }}>
                          <span style={{ color: '#fbbf24', fontWeight: 500 }}>⚠️ Files auto-delete after 48 hours</span>
                        </p>
                        <p style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.75rem' }}>
                          Entry metadata and text content persist until expiration time.
                        </p>
                      </div>
                    </div>


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
          )}
        </div>
      </div>
    </div>
  )
}
