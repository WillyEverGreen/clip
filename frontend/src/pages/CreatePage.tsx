import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FileText, Upload, Link as LinkIcon, ArrowRight, Info } from 'lucide-react'

import DropZone from '../components/DropZone'
import { createEntry, type ApiError } from '../lib/api'

type Mode = 'text' | 'file'

const HOST = window.location.origin + '/'

export default function CreatePage() {
  const navigate = useNavigate()

  const [mode,     setMode]     = useState<Mode>('text')
  const [content,  setContent]  = useState('')
  const [files,    setFiles]    = useState<File[]>([])
  const [slug,     setSlug]     = useState('')
  const [editCode, setEditCode] = useState('')
  const [ttl,      setTtl]      = useState('21600')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  const errorLabels: Record<string, string> = {
    slug_taken:        'That URL is already taken. Try another.',
    slug_invalid:      'URL must be 3–50 chars, lowercase letters, numbers, hyphens only.',
    slug_reserved:     'That URL is reserved. Please choose another.',
    missing_edit_code: 'Edit code must be 4–128 characters.',
    file_too_large:    'File exceeds 50 MB limit.',
    text_too_large:    'Text exceeds 2 MB limit.',
    no_content:        'Please add some content or upload a file.',
    mime_mismatch:     'File type does not match its content.',
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (editCode.length < 4) { setError('missing_edit_code'); return }
    if (mode === 'text' && !content.trim()) { setError('no_content'); return }
    if (mode === 'file' && files.length === 0) { setError('no_content'); return }

    const form = new FormData()
    form.append('type', mode)
    form.append('editCode', editCode)
    form.append('ttl', ttl)
    if (slug.trim()) form.append('slug', slug.trim().toLowerCase())
    if (mode === 'text') form.append('content', content)
    if (mode === 'file') {
      files.forEach((f) => {
        form.append('files', f)
        form.append('file', f)
      })
    }


    setLoading(true)
    try {
      const { slug: newSlug } = await createEntry(form)
      navigate(`/${newSlug}`)
    } catch (err) {
      const e = err as ApiError
      setError(e.error ?? 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page-wrapper">
      <div className="content-box animate-fade-up">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div style={{ textAlign:'center', marginBottom:'2.5rem' }}>
          <p style={{ color:'var(--text-muted)', fontSize:'0.9375rem' }}>
            Share text and files conveniently with custom links.
          </p>
        </div>



        {/* ── Card ───────────────────────────────────────────────────────── */}
        <form onSubmit={handleSubmit} className="card card-glow" style={{ padding:'2.5rem' }}>

          {/* Toggle */}
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
              <Upload size={16} /> File
            </button>
          </div>

          {/* Main Content input */}
          <div className="field">
            {mode === 'text' ? (
              <>
                <label className="label">Content <span style={{color:'var(--text-muted)'}}>*</span></label>
                <div style={{ height: '250px', display: 'flex', flexDirection: 'column' }}>
                  <textarea
                    className="input"
                    placeholder="Paste your text here… Markdown is supported"
                    value={content}
                    onChange={e => setContent(e.target.value)}
                    style={{ flex: 1, minHeight: '250px', resize: 'none' }}
                  />
                </div>
              </>
            ) : (
              <>
                <label className="label">File <span style={{color:'var(--text-muted)'}}>*</span></label>
                <div style={{ height: '250px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                  <DropZone onFiles={setFiles} height="202px" />
                  <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0 }}>
                    <Info size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                    <span>Uploaded files will be automatically deleted after 2 days. Text and your URL remain permanent.</span>
                  </p>
                </div>
              </>
            )}

          </div>


          {/* Bottom Controls Row */}
          <div style={{ display:'flex', alignItems:'flex-end', gap:'1rem', marginTop:'1.75rem', flexWrap:'wrap' }}>
            {/* Custom URL input */}
            <div className="field" style={{ flex:'2 1 240px', marginTop: 0 }}>
              <label className="label">Custom URL <span style={{color:'var(--text-dim)'}}>(optional)</span></label>
              <div className="url-group" style={{ display:'flex', alignItems:'stretch', height:'42px' }}>
                <span className="url-prefix" style={{ height:'42px', boxSizing:'border-box', padding:'0 0.85rem', background:'#000000', border:'1px solid var(--border)', borderRight:'none', borderRadius:'10px 0 0 10px', color:'var(--text-dim)', fontSize:'0.85rem', whiteSpace:'nowrap', display:'flex', alignItems:'center', gap:'0.35rem', transition:'all 180ms ease' }}>
                  <LinkIcon size={14} /> {HOST}
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

            {/* Submit Button */}
            <div style={{ marginTop: 0, flexShrink: 0 }}>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading}
                style={{ padding:'0 1.5rem', fontSize:'0.9375rem', height:'42px', minWidth:'130px' }}
              >
                {loading ? <><div className="spinner" />Creating…</> : <>Create Link <ArrowRight size={16} /></>}
              </button>
            </div>
          </div>


          {/* Error Message */}
          {error && (
            <div style={{ marginTop:'1.25rem', padding:'0.75rem 1rem', background:'#18181b', border:'1px solid #52525b', borderRadius:'10px', fontSize:'0.875rem', color:'#ffffff' }}>
              {errorLabels[error] ?? error}
            </div>
          )}
        </form>
      </div>
    </div>
  )
}
