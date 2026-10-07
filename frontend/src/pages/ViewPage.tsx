import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Copy, Check, Edit3, Download, Eye, FileText, Image as ImageIcon, FileArchive, Film, Music, File as FileIcon, LayoutList, LayoutGrid, Grid, HardDrive, Terminal, X, QrCode, Lock, Unlock, Upload, Monitor, Sparkles, Folder, RefreshCw, AlertCircle, Clock, Zap, Paperclip } from 'lucide-react'
import { getEntry, getLiveState, updateEntryWithProgress, fileUrl, rawUrl, zipUrl, formatBytes, formatLocalDate, setLiveSecurity, seedLiveRoom, uploadLiveFile, type PublicEntry, type FileItem } from '../lib/api'
import { isEncrypted, decryptContent, computeAuthHash, generateSalt, isEncryptedFileBuffer, decryptFileBuffer, encryptFile } from '../lib/crypto'
import { extractFilesFromDataTransfer } from '../lib/fileDrop'
import { getMimeType } from '../lib/fileTypes'
import { useEntrySSE } from '../lib/useEntrySSE'
import Countdown from '../components/Countdown'
import Logo      from '../components/Logo'
import { useSeo } from '../lib/useSeo'
import FilePreviewModal, { type PreviewFileItem } from '../components/FilePreviewModal'

// Heavy components lazy-loaded: their library chunks are only downloaded when needed
const MarkdownRenderer = lazy(() => import('../components/MarkdownRenderer'))
const QRCodeSVG = lazy(() =>
  import('qrcode.react').then(m => ({ default: m.QRCodeSVG }))
)


export default function ViewPage() {
  const { slug } = useParams<{ slug: string }>()
  const navigate  = useNavigate()
  const [entry,             setEntry]             = useState<PublicEntry | null>(null)
  const [loading,           setLoading]           = useState(true)
  const [copied,            setCopied]            = useState(false)
  const [textCopied,        setTextCopied]        = useState(false)
  const [showCliModal,      setShowCliModal]      = useState(false)
  const [showQrModal,       setShowQrModal]       = useState(false)
  const [cliOs,             setCliOs]             = useState<'linux' | 'windows'>('windows')
  const [cliTab,            setCliTab]            = useState<'download' | 'upload'>('download')
  const [cliCmdCopied,      setCliCmdCopied]      = useState<string | null>(null)
  // Encryption state
  const [decryptPassword,   setDecryptPassword]   = useState('')
  const [decryptedContent,  setDecryptedContent]  = useState<string | null>(null)
  const [decryptError,      setDecryptError]      = useState(false)
  const [decrypting,        setDecrypting]        = useState(false)
  const [refreshing,        setRefreshing]        = useState(false)
  const loadedRef      = useRef(false)       // tracks whether we've ever loaded data
  const lastUpdatedAtRef = useRef<number | undefined>(undefined)  // tracks last known updatedAt
  const fetchEntryRef  = useRef<((isManual?: boolean, expectedUpdatedAt?: number) => Promise<void>) | null>(null)

  // LivePad hosting modal states
  const [showHostLiveModal, setShowHostLiveModal] = useState(false)
  const [hostLiveChoice, setHostLiveChoice] = useState<'existing' | 'new' | 'none' | 'pass'>('existing')
  const [hostLivePassword, setHostLivePassword] = useState('')
  const [hostLiveLoading, setHostLiveLoading] = useState(false)
  const [hostLiveError, setHostLiveError] = useState<string | null>(null)
  const [pastedFiles, setPastedFiles] = useState<File[] | null>(null)
  const [attachingFiles, setAttachingFiles] = useState(false)
  const [attachEditCode, setAttachEditCode] = useState(() => {
    return (typeof window !== 'undefined' && slug ? sessionStorage.getItem('clip_edit_code_' + slug) : null) || ''
  })
  const [attachError, setAttachError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'info' | 'error' } | null>(null)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(t)
  }, [toast])

  const handleAttachRef = useRef<((files: File[]) => Promise<void>) | null>(null)

  // Clipboard paste listener on ViewPage: paste screenshot/file to quick-share
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

          const knownCode = (slug ? sessionStorage.getItem('clip_edit_code_' + slug) : null) || attachEditCode
          if (knownCode && handleAttachRef.current) {
            handleAttachRef.current(renamed)
          } else {
            setPastedFiles(renamed)
          }
        }
      }
    }

    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [slug, attachEditCode])

  // Dynamic SEO Title & Description
  const rawText = decryptedContent || entry?.content || ''
  const firstLine = rawText.trim().split('\n')[0]?.replace(/[#*`_~]/g, '').trim()
  const snippet = firstLine ? firstLine.slice(0, 60) : ''
  const pageTitle = entry
    ? entry.type === 'file'
      ? `${entry.fileName || (entry.files && entry.files.length > 0 ? `${entry.files.length} Shared Files` : 'Shared Files')} - Clip`
      : snippet
        ? `${snippet} - Clip /${slug}`
        : `Clip /${slug} - Shared Text`
    : `Clip /${slug} - Shared Link`

  const pageDescription = entry
    ? entry.type === 'file'
      ? `View and download ${entry.fileName || 'shared files'} securely on Clip. Zero accounts, instant transfer.`
      : rawText.slice(0, 160).replace(/\n/g, ' ') || 'View shared markdown, code, and text on Clip.'
    : 'View shared text and files securely on Clip.'

  useSeo({
    title: pageTitle,
    description: pageDescription,
    canonicalUrl: `https://clip.foo.ng/${slug}`,
  })

  const fetchEntry = useCallback(async (isManual = false, expectedUpdatedAt?: number) => {
    if (!slug) return
    if (isManual) setRefreshing(true)
    try {
      // Cache-bust on manual refresh, initial load, and browser reload (skip only for background auto-polls)
      const isAutoPoll = !isManual && loadedRef.current
      const cacheBust = !isAutoPoll ? `${Date.now()}` : undefined
      const e = await getEntry(slug, cacheBust, isAutoPoll)
      if (!e || (!e.isPermanent && Date.now() > e.expiresAt)) {
        if (!loadedRef.current) {
          try {
            const liveState = await getLiveState(slug)
            if (liveState && (liveState.peers > 0 || liveState.text || (liveState.files && liveState.files.length > 0) || liveState.isProtected)) {
              navigate(`/live/${slug}`, { replace: true })
              return
            }
          } catch {}
          navigate('/404')
        }
        return
      }
      
      // Stale data detection: if we expected a newer updatedAt but got older data,
      // it means we hit a KV edge that hasn't propagated yet — skip this update and retry
      const entryUpdatedAt = e.updatedAt ?? e.createdAt
      if (expectedUpdatedAt && entryUpdatedAt < expectedUpdatedAt && lastUpdatedAtRef.current) {
        if (import.meta.env.DEV) {
          console.warn(`Stale data detected: expected ${expectedUpdatedAt}, got ${entryUpdatedAt}`)
        }
        setTimeout(() => fetchEntryRef.current?.(false, expectedUpdatedAt), 1500)
        return
      }
      
      loadedRef.current = true
      lastUpdatedAtRef.current = entryUpdatedAt
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
    } catch {
      // Only navigate away if we've never successfully loaded data
      if (!loadedRef.current) {
        try {
          const liveState = await getLiveState(slug)
          if (liveState && (liveState.peers > 0 || liveState.text || (liveState.files && liveState.files.length > 0) || liveState.isProtected)) {
            navigate(`/live/${slug}`, { replace: true })
            return
          }
        } catch {}
        navigate('/404')
      }
    } finally {
      setLoading(false)
      if (isManual) setRefreshing(false)
    }
  }, [slug, navigate])

  // Keep a ref to the latest fetchEntry so the interval always calls the current version
  fetchEntryRef.current = fetchEntry

  const handleAttachPastedFiles = useCallback(async (filesToAttach?: File[], codeOverride?: string) => {
    const list = filesToAttach || pastedFiles
    if (!list || list.length === 0 || !slug) return

    const code = codeOverride || attachEditCode || (slug ? sessionStorage.getItem('clip_edit_code_' + slug) : null) || ''
    if (!code) {
      setPastedFiles(list)
      return
    }

    setAttachingFiles(true)
    setAttachError(null)

    try {
      const form = new FormData()
      form.append('editCode', code)

      if (entry?.content) {
        form.append('content', entry.content)
      }

      if (entry?.files && entry.files.length > 0) {
        entry.files.forEach(f => {
          if (f.id) form.append('keepFileIds', f.id)
        })
      }

      const sessionPass = (slug ? sessionStorage.getItem('clip_decrypt_' + slug) : null) || decryptPassword
      const isEnc = entry?.content ? isEncrypted(entry.content) : false

      for (const f of list) {
        let fileObj = f
        if (isEnc && sessionPass) {
          fileObj = await encryptFile(f, sessionPass)
        }
        form.append('files', fileObj)
        form.append('file', fileObj)
      }

      await updateEntryWithProgress(slug, form, () => {})
      sessionStorage.setItem('clip_edit_code_' + slug, code)

      await fetchEntry(true)
      setPastedFiles(null)
      setToast({ message: `Attached ${list.length} file(s) to this clip!`, type: 'success' })
    } catch (err: any) {
      const msg = err?.error === 'wrong_edit_code'
        ? 'Incorrect edit code.'
        : (err?.error || 'Failed to attach file.')
      setAttachError(msg)
    } finally {
      setAttachingFiles(false)
    }
  }, [slug, entry, attachEditCode, decryptPassword, pastedFiles, fetchEntry])

  useEffect(() => {
    handleAttachRef.current = (f: File[]) => handleAttachPastedFiles(f)
  }, [handleAttachPastedFiles])

  // Initial fetch
  useEffect(() => {
    loadedRef.current = false
    fetchEntryRef.current?.()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  // SSE — real-time push from Cloudflare Durable Object.
  // When any client mutates the entry, the worker notifies the DO which
  // immediately pushes an "update" event to every connected EventSource.
  // The update includes updatedAt for stale data detection.
  useEntrySSE(slug, {
    onUpdate: (updatedAt) => fetchEntryRef.current?.(false, updatedAt),
  })

  // One-shot 5s poll after mount to cover Cloudflare KV propagation lag
  // (the DO notify fires right after the write, but KV may take a few seconds
  // to be readable at every edge node globally).
  useEffect(() => {
    if (!slug) return
    const t = setTimeout(() => fetchEntryRef.current?.(), 5_000)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

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

  const handleLaunchLivePad = async () => {
    if (!slug) return
    setHostLiveLoading(true)
    setHostLiveError(null)

    try {
      const isEnc = entry?.content ? isEncrypted(entry.content) : false
      let effectivePassword = ''

      if (isEnc) {
        if (hostLiveChoice === 'existing') {
          effectivePassword = decryptPassword || sessionStorage.getItem('clip_decrypt_' + slug) || ''
          if (!effectivePassword) {
            setHostLiveError('Please unlock the clip first or select "Set New Password".')
            setHostLiveLoading(false)
            return
          }
        } else if (hostLiveChoice === 'new') {
          if (hostLivePassword.length < 4) {
            setHostLiveError('Password must be at least 4 characters.')
            setHostLiveLoading(false)
            return
          }
          effectivePassword = hostLivePassword
        }
      } else {
        if (hostLiveChoice === 'pass') {
          if (hostLivePassword.length < 4) {
            setHostLiveError('Password must be at least 4 characters.')
            setHostLiveLoading(false)
            return
          }
          effectivePassword = hostLivePassword
        }
      }

      // Configure room security
      if (effectivePassword) {
        const salt = generateSalt()
        const authHash = await computeAuthHash(effectivePassword, salt)
        await setLiveSecurity(slug, true, authHash, salt)
        sessionStorage.setItem('clip_live_pass_' + slug, effectivePassword)
      } else {
        await setLiveSecurity(slug, false)
      }

      // Seed room with current content & files (normalizing single-file clips if needed)
      const entryFiles: FileItem[] = entry?.files && entry.files.length > 0
        ? entry.files
        : (entry?.fileName ? [{
            id: entry.slug,
            fileName: entry.fileName,
            fileMime: entry.fileMime || 'application/octet-stream',
            fileSize: entry.fileSize || 0,
          }] : [])

      await seedLiveRoom(
        slug,
        displayContent || entry?.content || '',
        entryFiles
      )

      // If user had pasted files, upload them directly to the LivePad
      if (pastedFiles && pastedFiles.length > 0) {
        for (const file of pastedFiles) {
          await uploadLiveFile(slug, file)
        }
        setPastedFiles(null)
      }

      navigate(`/live/${slug}`)
    } catch (err: any) {
      setHostLiveError(err?.message || 'Failed to start LivePad.')
    } finally {
      setHostLiveLoading(false)
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

  // Generate CLI commands with password placeholder for encrypted content
  const passPlaceholder = contentIsEncrypted ? '{your-password-here}' : null
  const rawUrlWithPass = passPlaceholder ? `${rawEndpoint}?pass=${passPlaceholder}` : rawEndpoint
  const zipUrlWithPass = passPlaceholder ? `${zipEndpoint}?pass=${passPlaceholder}` : zipEndpoint
  const fileUrlWithPass = passPlaceholder ? `${fileEndpoint}?pass=${passPlaceholder}` : fileEndpoint

  const textCurlCmd = cliOs === 'windows' ? `curl.exe -sL "${rawUrlWithPass}"` : `curl -sL "${rawUrlWithPass}"`
  const fileCurlCmd = cliOs === 'windows' ? `curl.exe -fLJO "${fileUrlWithPass}"` : `curl -fLJO "${fileUrlWithPass}"`
  const zipCurlCmd  = cliOs === 'windows' ? `curl.exe -fLO "${zipUrlWithPass}"` : `curl -fLO "${zipUrlWithPass}"`

  // CLI Upload commands (Windows first, then Linux/macOS)
  const uploadCurlText = cliOs === 'windows'
    ? `curl.exe -X POST ${uploadOrigin}/api/entry ^
  -F "type=text" ^
  -F "content=@yourfile.txt" ^
  -F "editCode=YourSecret" ^
  -F "ttl=86400"`
    : `curl -X POST ${uploadOrigin}/api/entry \\
  -F "type=text" \\
  -F "content=@yourfile.txt" \\
  -F "editCode=YourSecret" \\
  -F "ttl=86400"`

  const uploadCurlFile = cliOs === 'windows'
    ? `curl.exe -X POST ${uploadOrigin}/api/entry ^
  -F "type=file" ^
  -F "files=@photo.jpg" ^
  -F "editCode=YourSecret"`
    : `curl -X POST ${uploadOrigin}/api/entry \\
  -F "type=file" \\
  -F "files=@photo.jpg" \\
  -F "editCode=YourSecret"`

  return (
    <div className="page-wrapper" style={{ justifyContent:'flex-start', paddingTop:'2.5rem' }}>
      <div className="content-box animate-fade-up">

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
            <button
              className="btn btn-secondary btn-compact-mobile"
              onClick={() => {
                const isEnc = entry?.content ? isEncrypted(entry.content) : false
                setHostLiveChoice(isEnc ? 'existing' : 'none')
                setShowHostLiveModal(true)
              }}
              title="Host LivePad from this URL"
              style={{ gap: '0.4rem' }}
            >
              <Zap size={14} /> Host LivePad
            </button>
            <button
              className="btn btn-ghost btn-compact-mobile"
              onClick={() => fetchEntry(true)}
              disabled={refreshing}
              title="Refresh to see latest uploads"
              style={{ gap: '0.4rem' }}
            >
              <RefreshCw size={14} style={{ animation: refreshing ? 'spin 0.7s linear infinite' : 'none' }} />
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
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
                {/* OS Selector - Windows first since user is on Windows */}
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', background: '#000000', padding: '0.25rem', borderRadius: '8px', border: '1px solid #27272a' }}>
                  <button onClick={() => setCliOs('windows')} style={{ flex: 1, padding: '0.5rem 0.75rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 600, border: 'none', transition: 'all 150ms ease', background: cliOs === 'windows' ? '#27272a' : 'transparent', color: cliOs === 'windows' ? '#ffffff' : '#a1a1aa', display:'flex', alignItems:'center', justifyContent:'center', gap:'0.4rem' }}>
                    <Monitor size={14} /> Windows (PowerShell)
                  </button>
                  <button onClick={() => setCliOs('linux')} style={{ flex: 1, padding: '0.5rem 0.75rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 600, border: 'none', transition: 'all 150ms ease', background: cliOs === 'linux' ? '#27272a' : 'transparent', color: cliOs === 'linux' ? '#ffffff' : '#a1a1aa', display:'flex', alignItems:'center', justifyContent:'center', gap:'0.4rem' }}>
                    <Terminal size={14} /> Linux / macOS
                  </button>
                </div>

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
                          const singleFileUrl = passPlaceholder ? `${fileUrl(entry.slug, f.id)}?pass=${passPlaceholder}` : fileUrl(entry.slug, f.id)
                          const fCmd = cliOs === 'windows' ? `curl.exe -LO "${singleFileUrl}"` : `curl -LO "${singleFileUrl}"`
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
                <Suspense fallback={<div style={{ width: 190, height: 190, background: '#f4f4f5', borderRadius: 8 }} />}>
                  <QRCodeSVG
                    value={pageUrl}
                    size={190}
                    bgColor="#ffffff"
                    fgColor="#000000"
                    level="H"
                    includeMargin={false}
                    style={{ display: 'block' }}
                  />
                </Suspense>
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

        {/* ── Host LivePad Modal ───────────────────────────────────────────── */}
        {showHostLiveModal && createPortal(
          <div className="modal-backdrop" onClick={() => !hostLiveLoading && setShowHostLiveModal(false)}>
            <div
              className="card animate-fade-up"
              onClick={e => e.stopPropagation()}
              style={{ maxWidth: 480, width: '92%', padding: '1.75rem', border: '1px solid #3f3f46', background: '#0a0a0a' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <div style={{ width: 34, height: 34, borderRadius: 8, background: '#18181b', border: '1px solid #27272a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Zap size={18} color="#ffffff" />
                  </div>
                  <div>
                    <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: '#ffffff' }}>Host LivePad</h3>
                    <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>Synchronized real-time session for /{slug}</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowHostLiveModal(false)}
                  disabled={hostLiveLoading}
                  className="btn btn-ghost"
                  style={{ padding: '0.35rem 0.5rem', color: '#a1a1aa' }}
                >
                  <X size={16} />
                </button>
              </div>

              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.25rem', lineHeight: 1.5 }}>
                Launch a collaborative workspace with real-time text syncing, multi-file sharing, and viewer presence.
              </p>

              {contentIsEncrypted ? (
                /* Source Clip is Encrypted */
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.25rem' }}>
                  <label
                    onClick={() => setHostLiveChoice('existing')}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.75rem',
                      padding: '0.75rem 1rem',
                      borderRadius: 8,
                      border: hostLiveChoice === 'existing' ? '1px solid #ffffff' : '1px solid var(--border)',
                      background: hostLiveChoice === 'existing' ? '#18181b' : '#000000',
                      cursor: 'pointer'
                    }}
                  >
                    <input
                      type="radio"
                      name="hostLiveChoice"
                      checked={hostLiveChoice === 'existing'}
                      onChange={() => setHostLiveChoice('existing')}
                      style={{ marginTop: 3 }}
                    />
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#ffffff' }}>Keep Existing Password</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                        Retains this clip's encryption password for the LivePad room.
                      </div>
                    </div>
                  </label>

                  <label
                    onClick={() => setHostLiveChoice('new')}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.75rem',
                      padding: '0.75rem 1rem',
                      borderRadius: 8,
                      border: hostLiveChoice === 'new' ? '1px solid #ffffff' : '1px solid var(--border)',
                      background: hostLiveChoice === 'new' ? '#18181b' : '#000000',
                      cursor: 'pointer'
                    }}
                  >
                    <input
                      type="radio"
                      name="hostLiveChoice"
                      checked={hostLiveChoice === 'new'}
                      onChange={() => setHostLiveChoice('new')}
                      style={{ marginTop: 3 }}
                    />
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#ffffff' }}>Set New Password</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                        Set a different password specifically for this LivePad.
                      </div>
                    </div>
                  </label>

                  <label
                    onClick={() => setHostLiveChoice('none')}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.75rem',
                      padding: '0.75rem 1rem',
                      borderRadius: 8,
                      border: hostLiveChoice === 'none' ? '1px solid #ffffff' : '1px solid var(--border)',
                      background: hostLiveChoice === 'none' ? '#18181b' : '#000000',
                      cursor: 'pointer'
                    }}
                  >
                    <input
                      type="radio"
                      name="hostLiveChoice"
                      checked={hostLiveChoice === 'none'}
                      onChange={() => setHostLiveChoice('none')}
                      style={{ marginTop: 3 }}
                    />
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#ffffff' }}>Make Public (No Password)</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                        Anyone with the link can join without entering a password.
                      </div>
                    </div>
                  </label>
                </div>
              ) : (
                /* Source Clip is Public */
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.25rem' }}>
                  <label
                    onClick={() => setHostLiveChoice('none')}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.75rem',
                      padding: '0.75rem 1rem',
                      borderRadius: 8,
                      border: hostLiveChoice === 'none' ? '1px solid #ffffff' : '1px solid var(--border)',
                      background: hostLiveChoice === 'none' ? '#18181b' : '#000000',
                      cursor: 'pointer'
                    }}
                  >
                    <input
                      type="radio"
                      name="hostLiveChoicePublic"
                      checked={hostLiveChoice === 'none'}
                      onChange={() => setHostLiveChoice('none')}
                      style={{ marginTop: 3 }}
                    />
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#ffffff' }}>Public LivePad</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                        Open to anyone who visits /live/{slug}.
                      </div>
                    </div>
                  </label>

                  <label
                    onClick={() => setHostLiveChoice('pass')}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.75rem',
                      padding: '0.75rem 1rem',
                      borderRadius: 8,
                      border: hostLiveChoice === 'pass' ? '1px solid #ffffff' : '1px solid var(--border)',
                      background: hostLiveChoice === 'pass' ? '#18181b' : '#000000',
                      cursor: 'pointer'
                    }}
                  >
                    <input
                      type="radio"
                      name="hostLiveChoicePublic"
                      checked={hostLiveChoice === 'pass'}
                      onChange={() => setHostLiveChoice('pass')}
                      style={{ marginTop: 3 }}
                    />
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#ffffff' }}>Password Protected</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                        Require visitors to enter a password to enter and edit.
                      </div>
                    </div>
                  </label>
                </div>
              )}

              {/* Password Input field if needed */}
              {(hostLiveChoice === 'new' || hostLiveChoice === 'pass') && (
                <div style={{ marginBottom: '1.25rem' }}>
                  <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>
                    LivePad Password (min 4 chars)
                  </label>
                  <input
                    className="input"
                    type="password"
                    placeholder="Enter password…"
                    value={hostLivePassword}
                    onChange={e => { setHostLivePassword(e.target.value); setHostLiveError(null) }}
                    autoFocus
                  />
                </div>
              )}

              {/* Existing password prompt if user hasn't unlocked yet */}
              {contentIsEncrypted && hostLiveChoice === 'existing' && !decryptedContent && !decryptPassword && !sessionStorage.getItem('clip_decrypt_' + slug) && (
                <div style={{ marginBottom: '1.25rem' }}>
                  <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>
                    Current Clip Password
                  </label>
                  <input
                    className="input"
                    type="password"
                    placeholder="Enter this clip's current password…"
                    value={decryptPassword}
                    onChange={e => { setDecryptPassword(e.target.value); setHostLiveError(null) }}
                    autoFocus
                  />
                </div>
              )}

              {hostLiveError && (
                <p style={{ margin: '0 0 1rem', fontSize: '0.8rem', color: '#ef4444', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <AlertCircle size={14} />
                  <span>{hostLiveError}</span>
                </p>
              )}

              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                <button
                  className="btn btn-ghost"
                  onClick={() => setShowHostLiveModal(false)}
                  disabled={hostLiveLoading}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleLaunchLivePad}
                  disabled={hostLiveLoading}
                  style={{ gap: '0.5rem', fontWeight: 600 }}
                >
                  {hostLiveLoading ? <div className="spinner" style={{ borderColor: '#000000', borderTopColor: 'transparent' }} /> : <Zap size={15} />}
                  Launch LivePad
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

        {/* ── Clipboard Paste Prompt Modal ─────────────────────────────────── */}
        {pastedFiles && pastedFiles.length > 0 && createPortal(
          <div className="modal-backdrop" onClick={() => setPastedFiles(null)}>
            <div
              className="card animate-fade-up"
              onClick={e => e.stopPropagation()}
              style={{ maxWidth: 440, width: '92%', padding: '1.5rem', border: '1px solid #3f3f46', background: '#0a0a0a' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Upload size={18} color="#ffffff" />
                  <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#ffffff' }}>File(s) Pasted</h3>
                </div>
                <button
                  onClick={() => setPastedFiles(null)}
                  className="btn btn-ghost"
                  style={{ padding: '0.35rem 0.5rem', color: '#a1a1aa' }}
                >
                  <X size={16} />
                </button>
              </div>

              <p style={{ fontSize: '0.825rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                You pasted {pastedFiles.length} file{pastedFiles.length > 1 ? 's' : ''} from clipboard:
              </p>

              <div style={{ maxHeight: 130, overflowY: 'auto', background: '#000000', border: '1px solid var(--border)', borderRadius: 8, padding: '0.5rem 0.75rem', marginBottom: '1.25rem' }}>
                {pastedFiles.map((f, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.775rem', padding: '0.25rem 0', borderBottom: i < pastedFiles.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <span style={{ color: '#ffffff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>
                      {f.name}
                    </span>
                    <span style={{ color: 'var(--text-dim)', fontSize: '0.7rem' }}>
                      {formatBytes(f.size)}
                    </span>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div style={{ background: '#121214', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.75rem' }}>
                  <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#ffffff', marginBottom: '0.35rem' }}>
                    Attach Directly to /{slug}
                  </label>
                  <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '0 0 0.5rem' }}>
                    Enter your secret edit code to add this file to the current clip.
                  </p>
                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    <input
                      type="password"
                      className="input"
                      placeholder="Enter edit code…"
                      value={attachEditCode}
                      onChange={e => { setAttachEditCode(e.target.value); setAttachError(null) }}
                      onKeyDown={e => e.key === 'Enter' && handleAttachPastedFiles()}
                      style={{ fontSize: '0.8rem', height: '36px' }}
                    />
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => handleAttachPastedFiles()}
                      disabled={attachingFiles || !attachEditCode}
                      style={{ padding: '0 0.85rem', fontSize: '0.785rem', height: '36px', flexShrink: 0 }}
                    >
                      {attachingFiles ? <div className="spinner" style={{ width: 12, height: 12 }} /> : 'Attach'}
                    </button>
                  </div>
                  {attachError && (
                    <p style={{ margin: '0.4rem 0 0', fontSize: '0.75rem', color: '#ef4444' }}>
                      {attachError}
                    </p>
                  )}
                </div>

                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    const isEnc = entry?.content ? isEncrypted(entry.content) : false
                    setHostLiveChoice(isEnc ? 'existing' : 'none')
                    setShowHostLiveModal(true)
                  }}
                  style={{ width: '100%', justifyContent: 'center', gap: '0.4rem', fontWeight: 600 }}
                >
                  <Zap size={14} /> Host LivePad & Attach Pasted File{pastedFiles.length > 1 ? 's' : ''}
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    navigate(`/${slug}/edit`)
                  }}
                  style={{ width: '100%', justifyContent: 'center', gap: '0.4rem' }}
                >
                  <Edit3 size={14} /> Edit Existing Clip in Full Editor
                </button>
              </div>
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
                <p style={{ marginTop:'0.75rem', fontSize:'0.8125rem', color:'var(--text-muted)', display:'flex', alignItems:'center', gap:'0.4rem' }}>
                  <AlertCircle size={14} style={{ color: '#ffffff' }} />
                  <span>Wrong password - please try again.</span>
                </p>
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
                  <Suspense fallback={<pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: '0.875rem', lineHeight: 1.7 }}>{displayContent}</pre>}>
                    <MarkdownRenderer content={displayContent ?? ''} />
                  </Suspense>
                </div>
              )}

              {/* File card section */}
              {(entry.hasFile || entry.fileName) && (
                <div style={{ marginTop: hasActualText ? '2rem' : 0, paddingTop: hasActualText ? '2rem' : 0, borderTop: hasActualText ? '1px solid var(--border)' : 'none' }}>
                  <FileCard entry={entry} slug={slug!} />
                </div>
              )}

              {/* Expired file notice if temporary file retention period passed */}
              {!hasActualText && !entry.hasFile && !entry.fileName && (
                <div style={{ textAlign: 'center', padding: '2.5rem 1rem' }}>
                  <Clock size={32} style={{ color: 'var(--text-dim)', marginBottom: '0.85rem' }} />
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#ffffff', marginBottom: '0.4rem' }}>Attached File Expired</h3>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', maxWidth: '420px', margin: '0 auto', lineHeight: 1.6 }}>
                    Files uploaded to temporary clips are retained for 48 hours to preserve storage. The file attachment for this clip has expired and been cleaned up.
                  </p>
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

  const [previewFile, setPreviewFile] = useState<PreviewFileItem | null>(null)
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [previewLoadingIndex, setPreviewLoadingIndex] = useState<number | null>(null)

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
    if (mime.startsWith('image/'))  return <ImageIcon size={size} color="#38bdf8" />
    if (mime.startsWith('video/'))  return <Film size={size} color="#ec4899" />
    if (mime.startsWith('audio/'))  return <Music size={size} color="#f59e0b" />
    if (mime.includes('zip') || mime.includes('tar') || mime.includes('rar')) return <FileArchive size={size} color="#10b981" />
    if (mime === 'application/pdf') return <FileText size={size} color="#ef4444" />
    return <FileIcon size={size} color="#ffffff" />
  }

  const handleDownloadFile = async (item: { id?: string; fileName: string }) => {
    const sessionPass = sessionStorage.getItem('clip_decrypt_' + slug) || ''
    const downloadLink = fileUrl(slug, item.id)
    if (!sessionPass) {
      const a = document.createElement('a')
      a.href = downloadLink
      a.download = item.fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      return
    }

    try {
      const res = await fetch(downloadLink)
      if (!res.ok) throw new Error('Fetch failed')
      const buf = await res.arrayBuffer()
      if (isEncryptedFileBuffer(buf)) {
        const dec = await decryptFileBuffer(buf, sessionPass)
        if (dec) {
          const blobUrl = URL.createObjectURL(dec.blob)
          const a = document.createElement('a')
          a.href = blobUrl
          a.download = dec.fileName
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000)
          return
        }
      }
      const blob = new Blob([buf])
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = item.fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000)
    } catch {
      const a = document.createElement('a')
      a.href = downloadLink
      a.download = item.fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    }
  }

  const handleOpenPreview = async (idx: number) => {
    const item = filesList[idx]
    if (!item) return
    setPreviewIndex(idx)
    setPreviewLoadingIndex(idx)

    const sessionPass = sessionStorage.getItem('clip_decrypt_' + slug) || ''
    const downloadLink = fileUrl(slug, item.id)

    try {
      if (sessionPass) {
        const res = await fetch(downloadLink)
        if (res.ok) {
          const buf = await res.arrayBuffer()
          if (isEncryptedFileBuffer(buf)) {
            const dec = await decryptFileBuffer(buf, sessionPass)
            if (dec) {
              const blobUrl = URL.createObjectURL(dec.blob)
              setPreviewFile({
                id: item.id,
                name: dec.fileName,
                mime: dec.fileMime,
                size: dec.blob.size,
                url: blobUrl,
                blob: dec.blob,
              })
              return
            }
          }
          const blob = new Blob([buf], { type: item.fileMime || 'application/octet-stream' })
          const blobUrl = URL.createObjectURL(blob)
          setPreviewFile({
            id: item.id,
            name: item.fileName,
            mime: item.fileMime,
            size: item.fileSize,
            url: blobUrl,
            blob,
          })
          return
        }
      }
    } catch (err) {
      console.error('Failed to prepare preview:', err)
    } finally {
      setPreviewLoadingIndex(null)
    }

    setPreviewFile({
      id: item.id,
      name: item.fileName,
      mime: item.fileMime,
      size: item.fileSize,
      url: downloadLink,
    })
  }

  const handleDownloadAll = () => {
    filesList.forEach((file, idx) => {
      setTimeout(() => {
        handleDownloadFile(file)
      }, idx * 350)
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
            const isLoadingThis = previewLoadingIndex === i

            return (
              <div
                key={item.id ?? i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '1.25rem',
                  flexWrap: 'wrap',
                  padding: '0.9rem 1.25rem',
                  background: '#09090c',
                  border: '1px solid var(--border)',
                  borderRadius: '12px',
                  transition: 'border-color 150ms ease, background 150ms ease',
                }}
                className="file-list-row"
              >
                <div
                  onClick={() => handleOpenPreview(i)}
                  style={{
                    background: '#121216',
                    border: '1px solid var(--border)',
                    padding: '0.75rem',
                    borderRadius: '10px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    cursor: 'pointer',
                  }}
                  title="Click to preview"
                >
                  {getIcon(item.fileMime)}
                </div>

                <div
                  onClick={() => handleOpenPreview(i)}
                  style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                  title="Click to preview"
                >
                  <p style={{ fontWeight: 600, fontSize: '1rem', color: '#ffffff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
                    {item.fileName}
                  </p>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.8125rem', marginTop: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', margin: 0 }}>
                    <span>{ext} · {formatBytes(item.fileSize)}</span>
                    <span style={{ color: 'var(--text-dim)' }}>·</span>
                    <span style={{ color: '#f87171', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                      Auto-deletes in: <Countdown expiresAt={fileExpiresAt} />
                    </span>
                  </p>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => handleOpenPreview(i)}
                    disabled={isLoadingThis}
                    className="btn btn-secondary"
                    style={{ gap: '0.4rem', padding: '0.45rem 0.85rem', fontSize: '0.8rem' }}
                    title="Preview file"
                  >
                    {isLoadingThis ? <div className="spinner" style={{ width: 14, height: 14 }} /> : <Eye size={14} />}
                    Preview
                  </button>

                  <button
                    type="button"
                    onClick={() => handleDownloadFile(item)}
                    className="btn btn-ghost"
                    style={{ gap: '0.4rem', padding: '0.45rem 0.85rem', fontSize: '0.8rem' }}
                    title="Download file"
                  >
                    <Download size={14} /> Download
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── 2. GRID / CARDS VIEW ───────────────────────────────────────────── */}
      {layout === 'grid' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '1rem' }}>
          {filesList.map((item, i) => {
            const ext = (item.fileName ?? '').split('.').pop()?.toUpperCase() ?? 'FILE'
            const isLoadingThis = previewLoadingIndex === i

            return (
              <div
                key={item.id ?? i}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  padding: '1.25rem',
                  background: '#09090c',
                  border: '1px solid var(--border)',
                  borderRadius: '12px',
                  gap: '1rem',
                  textAlign: 'center',
                  alignItems: 'center',
                  transition: 'border-color 150ms ease, transform 150ms ease',
                }}
              >
                <div
                  onClick={() => handleOpenPreview(i)}
                  style={{
                    background: '#121216',
                    border: '1px solid var(--border)',
                    padding: '1rem',
                    borderRadius: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '64px',
                    height: '64px',
                    cursor: 'pointer',
                  }}
                  title="Click to preview"
                >
                  {getIcon(item.fileMime, 36)}
                </div>

                <div
                  onClick={() => handleOpenPreview(i)}
                  style={{ width: '100%', minWidth: 0, cursor: 'pointer' }}
                  title="Click to preview"
                >
                  <p style={{ fontWeight: 600, fontSize: '0.95rem', color: '#ffffff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }} title={item.fileName}>
                    {item.fileName}
                  </p>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.785rem', marginTop: '0.35rem', margin: 0 }}>
                    {ext} · {formatBytes(item.fileSize)}
                  </p>
                  <p style={{ color: '#f87171', fontSize: '0.75rem', marginTop: '0.2rem', margin: 0 }}>
                    <Countdown expiresAt={fileExpiresAt} />
                  </p>
                </div>

                <div style={{ display: 'flex', gap: '0.4rem', width: '100%' }}>
                  <button
                    type="button"
                    onClick={() => handleOpenPreview(i)}
                    disabled={isLoadingThis}
                    className="btn btn-secondary"
                    style={{ flex: 1, justifyContent: 'center', gap: '0.35rem', padding: '0.45rem 0.6rem', fontSize: '0.775rem' }}
                    title="Preview file"
                  >
                    {isLoadingThis ? <div className="spinner" style={{ width: 12, height: 12 }} /> : <Eye size={13} />} Preview
                  </button>

                  <button
                    type="button"
                    onClick={() => handleDownloadFile(item)}
                    className="btn btn-ghost"
                    style={{ flex: 1, justifyContent: 'center', gap: '0.35rem', padding: '0.45rem 0.6rem', fontSize: '0.775rem' }}
                    title="Download file"
                  >
                    <Download size={13} /> Download
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── 3. TILES / COMPACT ICONS VIEW ───────────────────────────────────────────── */}
      {layout === 'tiles' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: '0.75rem' }}>
          {filesList.map((item, i) => {
            const isLoadingThis = previewLoadingIndex === i

            return (
              <div
                key={item.id ?? i}
                onClick={() => handleOpenPreview(i)}
                style={{
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  textAlign: 'center',
                  padding: '1rem 0.75rem',
                  background: '#09090c',
                  border: '1px solid var(--border)',
                  borderRadius: '10px',
                  gap: '0.6rem',
                  transition: 'border-color 150ms ease, background 150ms ease',
                }}
                className="tile-card"
                title="Click to preview"
              >
                <div style={{ background: '#121216', border: '1px solid var(--border)', padding: '0.6rem', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {getIcon(item.fileMime, 26)}
                </div>
                <div style={{ width: '100%', minWidth: 0 }}>
                  <p style={{ fontWeight: 600, fontSize: '0.85rem', color: '#ffffff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }} title={item.fileName}>
                    {item.fileName}
                  </p>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.725rem', marginTop: '2px', margin: 0 }}>
                    {formatBytes(item.fileSize)}
                  </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '2px' }}>
                  <span style={{ fontSize: '0.725rem', color: '#38bdf8', display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                    {isLoadingThis ? <div className="spinner" style={{ width: 10, height: 10 }} /> : <Eye size={12} />} View
                  </span>
                  <span style={{ color: 'var(--text-dim)', fontSize: '0.65rem' }}>·</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDownloadFile(item)
                    }}
                    className="btn btn-ghost"
                    style={{ padding: '0.1rem 0.3rem', fontSize: '0.725rem', color: '#a1a1aa' }}
                    title="Download file"
                  >
                    <Download size={12} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── High-Quality File Preview Modal ─────────────────────────────── */}
      {previewFile && (
        <FilePreviewModal
          file={previewFile}
          onClose={() => {
            if (previewFile.blob) URL.revokeObjectURL(previewFile.url)
            setPreviewFile(null)
            setPreviewIndex(null)
          }}
          onDownload={(f) => {
            const itemToDownload = filesList[previewIndex ?? 0] || { id: f.id, fileName: f.name }
            handleDownloadFile(itemToDownload)
          }}
          hasPrev={previewIndex !== null && previewIndex > 0}
          hasNext={previewIndex !== null && previewIndex < filesList.length - 1}
          onNavigatePrev={() => {
            if (previewIndex !== null && previewIndex > 0) handleOpenPreview(previewIndex - 1)
          }}
          onNavigateNext={() => {
            if (previewIndex !== null && previewIndex < filesList.length - 1) handleOpenPreview(previewIndex + 1)
          }}
        />
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
