import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  Zap, ArrowLeft, ArrowRight, Copy, Check, QrCode, Upload, Download, Trash2,
  File as FileIcon, FileText, Image as ImageIcon, Film, Music, FileArchive,
  ExternalLink, Eye, X, Lock, CheckCircle2, AlertCircle, Share2, Folder
} from 'lucide-react'
import { useLiveSocket } from '../lib/useLiveSocket'
import {
  liveFileDownloadUrl,
  uploadLiveFile,
  deleteLiveFile,
  createEntryWithProgress,
  formatBytes,
  type FileItem
} from '../lib/api'
import { encryptContent } from '../lib/crypto'
import Logo from '../components/Logo'
import { useSeo } from '../lib/useSeo'

const QRCodeSVG = lazy(() =>
  import('qrcode.react').then(m => ({ default: m.QRCodeSVG }))
)

export default function LivePage() {
  const { slug: rawSlug } = useParams<{ slug: string }>()
  const navigate = useNavigate()

  // Generate a random slug if visiting /live directly
  const slug = rawSlug || ''
  useEffect(() => {
    if (!rawSlug) {
      const generated = Math.random().toString(36).slice(2, 8)
      navigate(`/live/${generated}`, { replace: true })
    }
  }, [rawSlug, navigate])

  useSeo({
    title: slug ? `Live Pad /${slug} — Real-Time Text & File Sync | Clip` : 'Live Pad — Real-Time Collaborative Sync | Clip',
    description: 'Instant collaborative notepad and live file sharing room. Type and drop files with real-time WebSocket synchronization across devices.',
    canonicalUrl: slug ? `https://clip.foo.ng/live/${slug}` : 'https://clip.foo.ng/live',
  })

  const {
    status,
    text,
    files,
    peers,
    remoteUpdateTrigger,
    sendText,
    addLocalFile,
    removeLocalFile,
  } = useLiveSocket(slug)

  const [copiedLink, setCopiedLink] = useState(false)
  const [showQrModal, setShowQrModal] = useState(false)
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [lightboxName, setLightboxName] = useState<string>('')
  const [isDragging, setIsDragging] = useState(false)
  const [uploadingFiles, setUploadingFiles] = useState<{ id: string; name: string; pct: number }[]>([])

  const [showFilesPanel, setShowFilesPanel] = useState(true)
  const [mobileTab, setMobileTab] = useState<'editor' | 'files'>('editor')
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' ? window.innerWidth < 768 : false)

  // In-app notifications/toasts (replaces browser alerts)
  const [toast, setToast] = useState<{ message: string; type: 'error' | 'info' | 'success' } | null>(null)
  const showToast = useCallback((message: string, type: 'error' | 'info' | 'success' = 'info') => {
    setToast({ message, type })
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(t)
  }, [toast])

  // Track window resize for responsive layout
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // "Save as Clip" form states
  const [saveEditCode, setSaveEditCode] = useState(() => Math.random().toString(36).slice(2, 8))
  const [saveTtl, setSaveTtl] = useState('21600')
  const [savePassword, setSavePassword] = useState('')
  const [saveSlugChoice, setSaveSlugChoice] = useState<'room' | 'custom' | 'random'>('room')
  const [saveCustomSlug, setSaveCustomSlug] = useState('')
  const [saveSaving, setSaveSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dragCounterRef = useRef(0)
  const cursorRef = useRef<{ start: number; end: number } | null>(null)

  // Track cursor position to prevent cursor jump on remote incoming changes
  const handleCursorTrack = useCallback(() => {
    const el = textareaRef.current
    if (el) {
      cursorRef.current = { start: el.selectionStart, end: el.selectionEnd }
    }
  }, [])

  // Restore cursor position after remote incoming text changes
  useEffect(() => {
    const el = textareaRef.current
    if (!el || document.activeElement !== el || !cursorRef.current) return
    const { start, end } = cursorRef.current
    requestAnimationFrame(() => {
      try {
        el.setSelectionRange(start, end)
      } catch {}
    })
  }, [remoteUpdateTrigger])

  // Local text typing with fast debounce for real-time propagation
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    handleCursorTrack()
    sendText(e.target.value)
  }

  // Copy link
  const copyLiveLink = () => {
    navigator.clipboard.writeText(window.location.href)
    setCopiedLink(true)
    showToast('Live Pad URL copied to clipboard!', 'success')
    setTimeout(() => setCopiedLink(false), 2000)
  }

  // Handle uploading a file to this Live Pad
  const handleUpload = useCallback(async (fileList: FileList | File[]) => {
    if (!slug) return
    const queue = Array.from(fileList)

    for (const f of queue) {
      if (f.size > 25 * 1024 * 1024) {
        showToast(`"${f.name}" exceeds the 25 MB limit.`, 'error')
        continue
      }

      const tempId = `temp_${Date.now()}_${Math.random()}`
      setUploadingFiles(prev => [...prev, { id: tempId, name: f.name, pct: 0 }])

      try {
        const uploaded = await uploadLiveFile(slug, f, (pct) => {
          setUploadingFiles(prev =>
            prev.map(item => item.id === tempId ? { ...item, pct } : item)
          )
        })
        addLocalFile(uploaded)
        showToast(`Uploaded ${f.name}`, 'success')
      } catch (err) {
        console.error('Upload failed:', err)
        showToast(`Failed to upload ${f.name}. Please try again.`, 'error')
      } finally {
        setUploadingFiles(prev => prev.filter(item => item.id !== tempId))
      }
    }
  }, [slug, addLocalFile, showToast])

  // Drag & drop listener across the entire window
  useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault()
      dragCounterRef.current++
      if (e.dataTransfer?.types?.includes('Files')) {
        setIsDragging(true)
      }
    }

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault()
      dragCounterRef.current--
      if (dragCounterRef.current <= 0) {
        setIsDragging(false)
        dragCounterRef.current = 0
      }
    }

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
    }

    const handleDrop = (e: DragEvent) => {
      e.preventDefault()
      dragCounterRef.current = 0
      setIsDragging(false)
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        handleUpload(e.dataTransfer.files)
      }
    }

    window.addEventListener('dragenter', handleDragEnter)
    window.addEventListener('dragleave', handleDragLeave)
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('drop', handleDrop)

    return () => {
      window.removeEventListener('dragenter', handleDragEnter)
      window.removeEventListener('dragleave', handleDragLeave)
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('drop', handleDrop)
    }
  }, [handleUpload])

  // Clipboard paste listener: paste images or files directly from clipboard (Ctrl+V / Cmd+V)
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (!e.clipboardData) return
      const items = Array.from(e.clipboardData.items)
      const fileItems = items.filter(item => item.kind === 'file')

      if (fileItems.length > 0) {
        e.preventDefault()
        const filesToUpload: File[] = []
        for (const item of fileItems) {
          const file = item.getAsFile()
          if (file) {
            // Generate clean name for pasted screenshots/images if unnamed
            const name = file.name === 'image.png'
              ? `screenshot_${new Date().toISOString().replace(/[:.]/g, '-')}.png`
              : file.name
            const renamed = new File([file], name, { type: file.type })
            filesToUpload.push(renamed)
          }
        }
        if (filesToUpload.length > 0) {
          handleUpload(filesToUpload)
        }
      }
    }

    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [handleUpload])

  // Global keyboard shortcuts (Ctrl+S to save clip, Escape to close modals)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        setShowSaveModal(true)
      } else if (e.key === 'Escape') {
        setShowQrModal(false)
        setShowSaveModal(false)
        setLightboxUrl(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Delete live file
  const handleDeleteFile = async (fileId: string) => {
    if (!slug) return
    try {
      removeLocalFile(fileId)
      await deleteLiveFile(slug, fileId)
      showToast('File removed', 'info')
    } catch (err) {
      console.error('Delete failed:', err)
      showToast('Failed to delete file', 'error')
    }
  }

  // Save as permanent / custom clip
  const handleSaveAsClip = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!slug) return
    setSaveSaving(true)
    setSaveError(null)

    try {
      let finalContent = text
      if (savePassword && savePassword.length >= 4) {
        finalContent = await encryptContent(text, savePassword)
      }

      const form = new FormData()
      form.append('type', files.length > 0 ? 'file' : 'text')
      form.append('content', finalContent)
      form.append('editCode', saveEditCode)
      form.append('ttl', saveTtl)

      let targetSlug = ''
      if (saveSlugChoice === 'room') {
        targetSlug = slug
      } else if (saveSlugChoice === 'custom' && saveCustomSlug.trim()) {
        targetSlug = saveCustomSlug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
      }
      if (targetSlug) {
        form.append('slug', targetSlug)
      }

      // Fetch file blobs and attach them to the creation form
      for (const f of files) {
        const url = liveFileDownloadUrl(slug, f.id, f.fileMime, f.fileName)
        try {
          const res = await fetch(url)
          if (res.ok) {
            const blob = await res.blob()
            const fileObj = new File([blob], f.fileName, { type: f.fileMime })
            form.append('files', fileObj)
            form.append('file', fileObj)
          }
        } catch (e) {
          console.warn('Failed to attach file for clip conversion:', e)
        }
      }

      const created = await createEntryWithProgress(form, () => {})
      navigate(`/${created.slug}`)
    } catch (err: any) {
      setSaveError(err?.error ?? 'Failed to save clip. Please try again.')
    } finally {
      setSaveSaving(false)
    }
  }

  // File icon helper
  const getFileIcon = (mime: string) => {
    if (mime.startsWith('image/')) return <ImageIcon size={18} style={{ color: '#ffffff' }} />
    if (mime.startsWith('video/')) return <Film size={18} style={{ color: '#ffffff' }} />
    if (mime.startsWith('audio/')) return <Music size={18} style={{ color: '#ffffff' }} />
    if (mime.includes('zip') || mime.includes('tar') || mime.includes('rar')) return <FileArchive size={18} style={{ color: '#ffffff' }} />
    if (mime.includes('text') || mime.includes('json') || mime.includes('javascript') || mime.includes('typescript')) return <FileText size={18} style={{ color: '#ffffff' }} />
    return <FileIcon size={18} style={{ color: '#a1a1aa' }} />
  }

  // Word & character stats
  const charCount = text.length
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0
  const lineCount = text ? text.split('\n').length : 1

  return (
    <div className="page-wrapper" style={{ height: '100vh', maxHeight: '100vh', overflow: 'hidden', padding: '1rem 1.5rem', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      {/* ── Drag & Drop Screen Overlay ────────────────────────────────────── */}
      {isDragging && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.9)',
            backdropFilter: 'blur(8px)',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            border: '2px dashed #ffffff',
            pointerEvents: 'none',
            animation: 'fadeIn 150ms ease-out',
          }}
        >
          <Upload size={56} style={{ color: '#ffffff', marginBottom: '1.25rem' }} />
          <h2 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#ffffff', marginBottom: '0.5rem' }}>
            Drop files to share in real time
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem' }}>
            All devices in this Live Pad will receive them instantly
          </p>
        </div>
      )}

      <main className="content-box animate-fade-up" style={{ height: '100%', maxHeight: 'calc(100vh - 2rem)', display: 'flex', flexDirection: 'column' }}>
        <h1 style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', border: 0 }}>
          Live Pad — Real-Time Collaborative Text and File Sharing
        </h1>
        {/* ── Top Header Navigation ────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.65rem', flexWrap: 'wrap', gap: '0.5rem', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Link
              to="/"
              className="btn btn-ghost"
              style={{ padding: '0.4rem 0.65rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
            >
              <ArrowLeft size={16} /> {!isMobile && 'Home'}
            </Link>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Logo />
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.2rem 0.55rem',
                  background: '#141414',
                  border: '1px solid var(--border)',
                  borderRadius: '20px',
                  color: '#ffffff',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                }}
              >
                <Zap size={13} style={{ color: '#ffffff' }} /> Live Pad
              </span>
            </div>
          </div>

          {/* Right Action Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            {/* Status Indicator */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.45rem',
                padding: '0.35rem 0.65rem',
                background: '#0a0a0a',
                border: '1px solid var(--border)',
                borderRadius: '20px',
                fontSize: '0.8rem',
                color: status === 'connected' ? '#ffffff' : 'var(--text-muted)',
              }}
              title={status === 'connected' ? `${peers} active device${peers === 1 ? '' : 's'}` : status}
            >
              <span
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: status === 'connected' ? '#ffffff' : '#52525b',
                  boxShadow: status === 'connected' ? '0 0 6px rgba(255, 255, 255, 0.6)' : 'none',
                }}
              />
              <span style={{ fontWeight: 600, color: '#ffffff' }}>
                {status === 'connected' ? (isMobile ? peers : `${peers} ${peers === 1 ? 'device' : 'devices'}`) : status}
              </span>
            </div>

            {/* QR Code Button (Desktop/Tablet only) */}
            {!isMobile && (
              <button
                type="button"
                onClick={() => setShowQrModal(true)}
                className="btn btn-secondary"
                title="Share QR code with phone"
                style={{ padding: '0.4rem 0.75rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
              >
                <QrCode size={15} /> Phone Pair
              </button>
            )}

            {/* Copy Link Button */}
            <button
              type="button"
              onClick={copyLiveLink}
              className="btn btn-secondary"
              style={{ padding: '0.4rem 0.75rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
            >
              {copiedLink ? <Check size={15} style={{ color: '#ffffff' }} /> : <Copy size={15} />}
              <span>{copiedLink ? 'Copied' : (isMobile ? 'URL' : 'Share URL')}</span>
            </button>

            {/* Save as Clip Button */}
            <button
              type="button"
              onClick={() => setShowSaveModal(true)}
              className="btn btn-primary"
              style={{ padding: '0.4rem 0.85rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.45rem' }}
              title="Save as permanent clip (Ctrl+S)"
            >
              <Lock size={14} /> <span>{isMobile ? 'Save' : 'Save as Clip'}</span>
            </button>
          </div>
        </div>

        {/* ── Main Workspace Card ──────────────────────────────────────────── */}
        <div className="card card-glow" style={{ padding: '0.9rem 1.15rem', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {/* Room Banner / Notification Bar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0.4rem 0.75rem',
              background: '#050505',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              fontSize: '0.8125rem',
              flexWrap: 'wrap',
              gap: '0.5rem',
              marginBottom: '0.75rem',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)' }}>
              <span style={{ color: '#ffffff', fontWeight: 600 }}>Room: /{slug}</span>
              {!isMobile && (
                <>
                  <span>•</span>
                  <span>Type or drop files anytime - no need to press save!</span>
                </>
              )}
            </div>

            {/* Mobile Tab Switcher or Desktop Stats */}
            {isMobile ? (
              <div style={{ display: 'flex', gap: '0.25rem', background: '#121214', padding: '0.2rem', borderRadius: '6px', border: '1px solid var(--border)' }}>
                <button
                  type="button"
                  onClick={() => setMobileTab('editor')}
                  style={{
                    padding: '0.2rem 0.6rem',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    borderRadius: '4px',
                    border: 'none',
                    background: mobileTab === 'editor' ? '#ffffff' : 'transparent',
                    color: mobileTab === 'editor' ? '#000000' : 'var(--text-muted)',
                    cursor: 'pointer',
                    transition: 'all 120ms ease',
                  }}
                >
                  Editor
                </button>
                <button
                  type="button"
                  onClick={() => setMobileTab('files')}
                  style={{
                    padding: '0.2rem 0.6rem',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    borderRadius: '4px',
                    border: 'none',
                    background: mobileTab === 'files' ? '#ffffff' : 'transparent',
                    color: mobileTab === 'files' ? '#000000' : 'var(--text-muted)',
                    cursor: 'pointer',
                    transition: 'all 120ms ease',
                  }}
                >
                  Files ({files.length})
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', color: 'var(--text-dim)', fontSize: '0.775rem' }}>
                <span>{charCount} chars</span>
                <span>{wordCount} words</span>
                <span>{lineCount} lines</span>
                <button
                  type="button"
                  onClick={() => setShowFilesPanel(prev => !prev)}
                  className="btn btn-ghost"
                  style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem', gap: '0.35rem', color: showFilesPanel ? '#ffffff' : 'var(--text-muted)' }}
                  title={showFilesPanel ? 'Hide files panel' : 'Show files panel'}
                >
                  <Folder size={13} /> {showFilesPanel ? 'Hide Files' : `Files (${files.length})`}
                </button>
              </div>
            )}
          </div>

          {/* Main Workspace Body: Two Columns (Desktop) or Tab View (Mobile) */}
          <div style={{ display: 'flex', gap: '1rem', flex: 1, minHeight: 0, overflow: 'hidden' }}>
            {/* Real-time Synchronized Textarea Column */}
            {(!isMobile || mobileTab === 'editor') && (
              <div style={{ flex: 1, minWidth: 0, height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <textarea
                  ref={textareaRef}
                  className="input"
                  value={text}
                  onChange={handleTextChange}
                  onKeyUp={handleCursorTrack}
                  onClick={handleCursorTrack}
                  onSelect={handleCursorTrack}
                  placeholder={`Start typing here... everything synchronizes live to any other device opening this URL.

Tip: Paste images directly from your clipboard (Ctrl+V) or drag and drop any files onto this window.`}
                  style={{
                    width: '100%',
                    height: '100%',
                    minHeight: 0,
                    resize: 'none',
                    fontSize: '0.95rem',
                    lineHeight: 1.65,
                    fontFamily: 'var(--font-mono)',
                    background: '#050505',
                    padding: '1.1rem',
                    borderRadius: '10px',
                    border: '1px solid var(--border)',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            )}

            {/* Live Shared Files & Media Panel */}
            {(!isMobile ? showFilesPanel : mobileTab === 'files') && (
              <div
                style={{
                  width: isMobile ? '100%' : '360px',
                  minWidth: isMobile ? '100%' : '280px',
                  height: '100%',
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  background: '#050505',
                  border: '1px solid var(--border)',
                  borderRadius: '10px',
                  padding: '0.85rem',
                  boxSizing: 'border-box',
                  overflow: 'hidden',
                }}
              >
                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', flexShrink: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span style={{ fontWeight: 600, fontSize: '0.875rem', color: '#ffffff' }}>
                      Files & Media ({files.length})
                    </span>
                    <span style={{ fontSize: '0.725rem', color: 'var(--text-dim)' }}>
                      (24h)
                    </span>
                  </div>

                  {/* Hidden file input */}
                  <label
                    className="btn btn-secondary"
                    style={{
                      padding: '0.3rem 0.65rem',
                      fontSize: '0.775rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      cursor: 'pointer',
                      margin: 0,
                    }}
                  >
                    <Upload size={13} /> Add Files
                    <input
                      type="file"
                      multiple
                      style={{ display: 'none' }}
                      onChange={e => {
                        if (e.target.files && e.target.files.length > 0) {
                          handleUpload(e.target.files)
                        }
                      }}
                    />
                  </label>
                </div>

                {/* Uploading progress bars */}
                {uploadingFiles.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '0.75rem', flexShrink: 0 }}>
                    {uploadingFiles.map(u => (
                      <div
                        key={u.id}
                        style={{
                          padding: '0.5rem 0.75rem',
                          background: '#121214',
                          border: '1px solid var(--border)',
                          borderRadius: '8px',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: '0.25rem' }}>
                          <span style={{ color: '#ffffff', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Uploading {u.name}...</span>
                          <span style={{ color: '#ffffff' }}>{u.pct}%</span>
                        </div>
                        <div style={{ height: '3px', background: '#27272a', borderRadius: '2px', overflow: 'hidden' }}>
                          <div
                            style={{
                              height: '100%',
                              width: `${u.pct}%`,
                              background: '#ffffff',
                              transition: 'width 100ms ease',
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Files List / Empty Drop Area */}
                {files.length === 0 && uploadingFiles.length === 0 ? (
                  <div
                    style={{
                      flex: 1,
                      minHeight: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: '#070707',
                      border: '1px dashed var(--border)',
                      borderRadius: '8px',
                      textAlign: 'center',
                      padding: '1.25rem',
                      color: 'var(--text-muted)',
                    }}
                  >
                    <Upload size={28} style={{ color: 'var(--text-dim)', marginBottom: '0.65rem' }} />
                    <p style={{ fontSize: '0.85rem', fontWeight: 600, color: '#ffffff', margin: 0 }}>
                      No files uploaded yet
                    </p>
                    <p style={{ fontSize: '0.775rem', color: 'var(--text-dim)', marginTop: '0.4rem', lineHeight: 1.4 }}>
                      Paste screenshots with <kbd style={{ background: '#222', padding: '0.1rem 0.3rem', borderRadius: '4px' }}>Ctrl+V</kbd> or drag & drop files here.
                    </p>
                  </div>
                ) : (
                  <div
                    style={{
                      flex: 1,
                      minHeight: 0,
                      overflowY: 'auto',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.6rem',
                      paddingRight: '0.25rem',
                    }}
                  >
                    {files.map(f => {
                      const isImg = f.fileMime.startsWith('image/')
                      const downloadUrl = liveFileDownloadUrl(slug, f.id, f.fileMime, f.fileName)

                      return (
                        <div
                          key={f.id}
                          style={{
                            background: '#0a0a0a',
                            border: '1px solid var(--border)',
                            borderRadius: '8px',
                            overflow: 'hidden',
                            display: 'flex',
                            flexDirection: 'column',
                            flexShrink: 0,
                          }}
                        >
                          {/* Image Thumbnail Preview */}
                          {isImg ? (
                            <div
                              onClick={() => {
                                setLightboxUrl(downloadUrl)
                                setLightboxName(f.fileName)
                              }}
                              style={{
                                height: '110px',
                                background: '#000000',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                position: 'relative',
                                overflow: 'hidden',
                              }}
                            >
                              <img
                                src={downloadUrl}
                                alt={f.fileName}
                                loading="lazy"
                                style={{
                                  width: '100%',
                                  height: '100%',
                                  objectFit: 'cover',
                                  transition: 'transform 200ms ease',
                                }}
                              />
                              <div
                                style={{
                                  position: 'absolute',
                                  inset: 0,
                                  background: 'rgba(0,0,0,0.3)',
                                  opacity: 0,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  transition: 'opacity 150ms ease',
                                }}
                                onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                                onMouseLeave={e => (e.currentTarget.style.opacity = '0')}
                              >
                                <Eye size={20} style={{ color: '#ffffff' }} />
                              </div>
                            </div>
                          ) : (
                            <div
                              style={{
                                height: '56px',
                                background: '#0e0e10',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              {getFileIcon(f.fileMime)}
                            </div>
                          )}

                          {/* File Details & Actions */}
                          <div style={{ padding: '0.6rem 0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <p
                                title={f.fileName}
                                style={{
                                  fontSize: '0.8rem',
                                  fontWeight: 600,
                                  color: '#ffffff',
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  margin: 0,
                                }}
                              >
                                {f.fileName}
                              </p>
                              <p style={{ fontSize: '0.725rem', color: 'var(--text-dim)', margin: '0.15rem 0 0' }}>
                                {formatBytes(f.fileSize)}
                              </p>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexShrink: 0 }}>
                              <a
                                href={downloadUrl}
                                download={f.fileName}
                                className="btn btn-secondary"
                                style={{ padding: '0.25rem 0.5rem', fontSize: '0.725rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                                title="Download"
                              >
                                <Download size={12} />
                              </a>
                              <button
                                type="button"
                                onClick={() => handleDeleteFile(f.id)}
                                className="btn btn-ghost"
                                title="Remove file for everyone"
                                style={{ padding: '0.25rem 0.4rem', color: 'var(--text-muted)' }}
                                onMouseEnter={e => (e.currentTarget.style.color = '#ffffff')}
                                onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>

      {/* ── Lightbox Image Modal ─────────────────────────────────────────── */}
      {lightboxUrl && (
        <div
          onClick={() => setLightboxUrl(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.92)',
            backdropFilter: 'blur(10px)',
            zIndex: 10000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '2rem',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              position: 'relative',
              maxWidth: '90vw',
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
            }}
          >
            <button
              onClick={() => setLightboxUrl(null)}
              style={{
                position: 'absolute',
                top: '-2.5rem',
                right: 0,
                background: 'transparent',
                border: 'none',
                color: '#ffffff',
                cursor: 'pointer',
              }}
            >
              <X size={26} />
            </button>
            <img
              src={lightboxUrl}
              alt={lightboxName}
              style={{
                maxWidth: '100%',
                maxHeight: '80vh',
                borderRadius: '8px',
                objectFit: 'contain',
                boxShadow: '0 20px 50px rgba(0,0,0,0.8)',
              }}
            />
            <p style={{ marginTop: '0.85rem', color: '#ffffff', fontSize: '0.9rem', fontWeight: 500 }}>
              {lightboxName}
            </p>
          </div>
        </div>
      )}

      {/* ── QR Code / Phone Pairing Modal ─────────────────────────────────── */}
      {showQrModal && (
        <div
          onClick={() => setShowQrModal(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.85)',
            backdropFilter: 'blur(8px)',
            zIndex: 10000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1.5rem',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            className="card"
            style={{
              width: '100%',
              maxWidth: '380px',
              padding: '1.75rem',
              textAlign: 'center',
              border: '1px solid var(--border-active)',
              boxShadow: '0 25px 60px rgba(0,0,0,0.9)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <QrCode size={20} style={{ color: '#ffffff' }} />
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>Connect Phone</h3>
              </div>
              <button onClick={() => setShowQrModal(false)} className="btn btn-ghost" style={{ padding: '0.25rem' }}>
                <X size={18} />
              </button>
            </div>

            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
              Scan this code with your phone's camera to immediately join and type into this room live.
            </p>

            <div
              style={{
                display: 'inline-block',
                padding: '1.25rem',
                background: '#ffffff',
                borderRadius: '12px',
                boxShadow: '0 0 25px rgba(255, 255, 255, 0.08)',
                marginBottom: '1.25rem',
              }}
            >
              <Suspense fallback={<div style={{ width: 180, height: 180 }} />}>
                <QRCodeSVG value={window.location.href} size={180} level="M" />
              </Suspense>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                readOnly
                value={window.location.href}
                className="input"
                style={{ flex: 1, fontSize: '0.75rem', padding: '0.45rem 0.65rem' }}
              />
              <button
                type="button"
                onClick={copyLiveLink}
                className="btn btn-primary"
                style={{ padding: '0.45rem 0.85rem', fontSize: '0.8rem' }}
              >
                {copiedLink ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Save as Permanent Clip Modal ──────────────────────────────────── */}
      {showSaveModal && (
        <div
          onClick={() => setShowSaveModal(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.85)',
            backdropFilter: 'blur(8px)',
            zIndex: 10000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1.5rem',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            className="card"
            style={{
              width: '100%',
              maxWidth: '460px',
              padding: '1.75rem',
              border: '1px solid var(--border-active)',
              boxShadow: '0 25px 60px rgba(0,0,0,0.9)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Lock size={18} style={{ color: '#ffffff' }} />
                <h3 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0 }}>Save as Permanent Clip</h3>
              </div>
              <button onClick={() => setShowSaveModal(false)} className="btn btn-ghost" style={{ padding: '0.25rem' }}>
                <X size={18} />
              </button>
            </div>

            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
              Export this live session into a shareable, permanent or custom-timed clip with an edit code.
            </p>

            {saveError && (
              <div style={{ padding: '0.65rem 0.85rem', background: '#18181b', border: '1px solid #52525b', borderRadius: '8px', color: '#ffffff', fontSize: '0.8rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <AlertCircle size={14} style={{ color: '#ffffff', flexShrink: 0 }} />
                <span>{saveError}</span>
              </div>
            )}

            <form onSubmit={handleSaveAsClip} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label className="label">Clip URL / Slug</label>
                <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.5rem' }}>
                  <button
                    type="button"
                    onClick={() => setSaveSlugChoice('room')}
                    className={`btn ${saveSlugChoice === 'room' ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ flex: 1, padding: '0.35rem 0.5rem', fontSize: '0.78rem' }}
                  >
                    Room (/{slug})
                  </button>
                  <button
                    type="button"
                    onClick={() => setSaveSlugChoice('custom')}
                    className={`btn ${saveSlugChoice === 'custom' ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ flex: 1, padding: '0.35rem 0.5rem', fontSize: '0.78rem' }}
                  >
                    Custom
                  </button>
                  <button
                    type="button"
                    onClick={() => setSaveSlugChoice('random')}
                    className={`btn ${saveSlugChoice === 'random' ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ flex: 1, padding: '0.35rem 0.5rem', fontSize: '0.78rem' }}
                  >
                    Random
                  </button>
                </div>
                {saveSlugChoice === 'custom' && (
                  <input
                    type="text"
                    value={saveCustomSlug}
                    onChange={e => setSaveCustomSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                    className="input"
                    placeholder="e.g. my-saved-notes"
                    style={{ fontSize: '0.85rem' }}
                    maxLength={50}
                  />
                )}
              </div>

              <div>
                <label className="label">Edit Code <span style={{ color: 'var(--text-muted)' }}>*</span></label>
                <input
                  type="text"
                  required
                  value={saveEditCode}
                  onChange={e => setSaveEditCode(e.target.value)}
                  className="input"
                  placeholder="Secret code to edit later"
                />
              </div>

              <div>
                <label className="label">Expiration</label>
                <select
                  value={saveTtl}
                  onChange={e => setSaveTtl(e.target.value)}
                  className="input"
                >
                  <option value="3600">1 Hour</option>
                  <option value="21600">6 Hours (Default)</option>
                  <option value="86400">1 Day</option>
                  <option value="604800">7 Days</option>
                  <option value="2592000">30 Days</option>
                  <option value="permanent">Permanent (Text only)</option>
                </select>
              </div>

              <div>
                <label className="label">Password Encryption <span style={{ color: 'var(--text-dim)' }}>(Optional)</span></label>
                <input
                  type="password"
                  value={savePassword}
                  onChange={e => setSavePassword(e.target.value)}
                  className="input"
                  placeholder="Optional zero-knowledge password"
                />
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => setShowSaveModal(false)}
                  className="btn btn-secondary"
                  style={{ flex: 1 }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saveSaving || saveEditCode.length < 4}
                  className="btn btn-primary"
                  style={{ flex: 1.5, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}
                >
                  {saveSaving ? (
                    'Saving Clip...'
                  ) : (
                    <>
                      <span>Create Clip</span>
                      <ArrowRight size={14} />
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Sleek Floating Toast Notification ─────────────────────────────── */}
      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: '1.5rem',
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#121214',
            border: '1px solid #3f3f46',
            color: '#ffffff',
            padding: '0.65rem 1.25rem',
            borderRadius: '10px',
            fontSize: '0.85rem',
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            boxShadow: '0 10px 30px rgba(0,0,0,0.85)',
            zIndex: 11000,
            animation: 'fadeIn 150ms ease',
          }}
        >
          {toast.type === 'error' && <AlertCircle size={16} style={{ color: '#ffffff' }} />}
          {toast.type === 'success' && <Check size={16} style={{ color: '#ffffff' }} />}
          {toast.type === 'info' && <Zap size={16} style={{ color: '#ffffff' }} />}
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  )
}
