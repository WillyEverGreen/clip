import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  Zap, ArrowLeft, ArrowRight, Copy, Check, QrCode, Upload, Download, Trash2,
  File as FileIcon, FileText, Image as ImageIcon, Film, Music, FileArchive,
  Eye, X, Lock, AlertCircle, Folder,
  FolderPlus, Code, Play, Clock
} from 'lucide-react'
import { useLiveSocket } from '../lib/useLiveSocket'
import {
  liveFileDownloadUrl,
  uploadLiveFile,
  deleteLiveFile,
  batchDeleteLiveFiles,
  liveZipDownloadUrl,
  createEntryWithProgress,
  updateEntryWithProgress,
  getUniqueLiveSlug,
  formatBytes,
} from '../lib/api'
import { extractFilesFromDataTransfer, normalizeFileInputFiles } from '../lib/fileDrop'
import {
  isImageFile,
  isVideoFile,
  isAudioFile,
  isPdfFile,
  isTextOrCodeFile,
  isArchiveFile,
  getFileTypeBadge,
  getMimeType
} from '../lib/fileTypes'
import { encryptContent, encryptFile, decryptFileBuffer, isEncryptedFileBuffer } from '../lib/crypto'
import Logo from '../components/Logo'
import { useSeo } from '../lib/useSeo'
import FilePreviewModal, { type PreviewFileItem } from '../components/FilePreviewModal'

const QRCodeSVG = lazy(() =>
  import('qrcode.react').then(m => ({ default: m.QRCodeSVG }))
)

function LiveImageThumbnail({
  slug,
  file,
  getP2PBlob,
  onClick,
}: {
  slug: string
  file: { id: string; fileName: string; fileMime: string }
  getP2PBlob: (id: string) => Blob | undefined
  onClick: () => void
}) {
  const [src, setSrc] = useState<string>(() => {
    const p2p = getP2PBlob(file.id)
    if (p2p) return URL.createObjectURL(p2p)
    return liveFileDownloadUrl(slug, file.id, file.fileMime, file.fileName)
  })

  useEffect(() => {
    let active = true
    let blobUrlToRevoke: string | null = null

    const resolve = async () => {
      const p2p = getP2PBlob(file.id)
      const livePass = sessionStorage.getItem('clip_live_pass_' + slug)
      if (p2p) {
        const buf = await p2p.arrayBuffer()
        if (isEncryptedFileBuffer(buf) && livePass) {
          const dec = await decryptFileBuffer(buf, livePass)
          if (dec && active) {
            const u = URL.createObjectURL(dec.blob)
            blobUrlToRevoke = u
            setSrc(u)
            return
          }
        }
        if (active) {
          const u = URL.createObjectURL(p2p)
          blobUrlToRevoke = u
          setSrc(u)
          return
        }
      }

      if (livePass) {
        try {
          const url = liveFileDownloadUrl(slug, file.id, file.fileMime, file.fileName)
          const res = await fetch(url)
          if (!res.ok) return
          const buf = await res.arrayBuffer()
          if (isEncryptedFileBuffer(buf)) {
            const dec = await decryptFileBuffer(buf, livePass)
            if (dec && active) {
              const u = URL.createObjectURL(dec.blob)
              blobUrlToRevoke = u
              setSrc(u)
            }
          }
        } catch {}
      }
    }

    resolve()
    return () => {
      active = false
      if (blobUrlToRevoke) URL.revokeObjectURL(blobUrlToRevoke)
    }
  }, [file.id, slug, getP2PBlob])

  return (
    <div
      onClick={onClick}
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
      title="Click to view image"
    >
      <img
        src={src}
        alt={file.fileName}
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
  )
}

export default function LivePage() {
  const { slug: rawSlug } = useParams<{ slug: string }>()
  const navigate = useNavigate()

  // Redirect /live to a unique server-reserved room slug
  const slug = rawSlug || ''
  useEffect(() => {
    if (!rawSlug) {
      getUniqueLiveSlug().then(unique => {
        navigate(`/live/${unique}`, { replace: true })
      })
    }
  }, [rawSlug, navigate])

  useSeo({
    title: slug ? `Live Pad /${slug} - Real-Time Text & File Sync | Clip` : 'Live Pad - Real-Time Collaborative Sync | Clip',
    description: 'Instant collaborative notepad and live file sharing room. Type and drop files with real-time WebSocket synchronization across devices.',
    canonicalUrl: slug ? `https://clip.foo.ng/live/${slug}` : 'https://clip.foo.ng/live',
  })

  const {
    status,
    roomClosedMessage,
    text,
    files,
    peers,
    remoteUpdateTrigger,
    sendText,
    addLocalFile,
    removeLocalFile,
    removeLocalFiles,
    isProtected,
    isAuthenticated,
    isProtectionChecked,
    authError,
    authenticate,
    isP2PActive,
    p2pPeerCount,
    sendP2PFile,
    getP2PBlob,
    setLocalP2PBlob,
  } = useLiveSocket(slug)

  const [enterPass, setEnterPass] = useState('')
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([])
  const [isBatchDeleting, setIsBatchDeleting] = useState(false)

  const [copiedLink, setCopiedLink] = useState(false)
  const [showQrModal, setShowQrModal] = useState(false)
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [previewFile, setPreviewFile] = useState<PreviewFileItem | null>(null)
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
  const [saveEditCode, setSaveEditCode] = useState(() => {
    // Cryptographically secure random edit code — never Math.random
    const bytes = crypto.getRandomValues(new Uint8Array(6))
    return Array.from(bytes).map(b => b.toString(36)).join('').slice(0, 8)
  })
  const [saveTtl, setSaveTtl] = useState('21600')
  const [savePassword, setSavePassword] = useState(() => {
    return (typeof window !== 'undefined' && slug ? sessionStorage.getItem('clip_live_pass_' + slug) : null) || ''
  })
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

  // Handle uploading files to this Live Pad (with concurrency and folder path support)
  const handleUpload = useCallback(async (fileList: FileList | File[]) => {
    if (!slug) return
    if (isProtected && !isAuthenticated) {
      showToast('Please unlock room to upload files.', 'error')
      return
    }
    const queue = normalizeFileInputFiles(fileList)
    if (queue.length === 0) return

    const validFiles: File[] = []
    for (const f of queue) {
      if (f.size > 25 * 1024 * 1024) {
        showToast(`"${f.name}" exceeds the 25 MB limit.`, 'error')
      } else {
        validFiles.push(f)
      }
    }

    if (validFiles.length === 0) return

    if (validFiles.length > 1) {
      showToast(`Uploading ${validFiles.length} files...`, 'info')
    }

    // Upload with concurrency pool (up to 3 files concurrently)
    const CONCURRENCY = 3
    let index = 0
    let successCount = 0
    const failedNames: string[] = []

    const uploadWorker = async () => {
      while (index < validFiles.length) {
        const i = index++
        const f = validFiles[i]
        const tempId = `temp_${Date.now()}_${Math.random()}`
        setUploadingFiles(prev => [...prev, { id: tempId, name: f.name, pct: 0 }])

        try {
          const livePass = sessionStorage.getItem('clip_live_pass_' + slug)
          let fileToUpload = f
          if (livePass && livePass.length >= 4) {
            fileToUpload = await encryptFile(f, livePass)
          }

          const uploaded = await uploadLiveFile(slug, fileToUpload, (pct) => {
            setUploadingFiles(prev =>
              prev.map(item => item.id === tempId ? { ...item, pct } : item)
            )
          })
          addLocalFile(uploaded)
          setLocalP2PBlob(uploaded.id, fileToUpload)

          if (isP2PActive) {
            sendP2PFile(uploaded, fileToUpload).catch(() => {})
          }

          successCount++
          if (validFiles.length === 1) {
            showToast(`Uploaded ${f.name}`, 'success')
          }
        } catch (err) {
          console.error('Upload failed:', err)
          failedNames.push(f.name)
        } finally {
          setUploadingFiles(prev => prev.filter(item => item.id !== tempId))
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, validFiles.length) }, () => uploadWorker())
    await Promise.all(workers)

    if (validFiles.length > 1) {
      if (failedNames.length === 0) {
        showToast(`Successfully uploaded ${successCount} files`, 'success')
      } else if (successCount > 0) {
        showToast(`Uploaded ${successCount} files (${failedNames.length} failed)`, 'info')
      } else {
        showToast(`Failed to upload ${failedNames.length} files.`, 'error')
      }
    } else if (failedNames.length > 0) {
      showToast(`Failed to upload ${failedNames[0]}. Please try again.`, 'error')
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

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault()
      dragCounterRef.current = 0
      setIsDragging(false)
      if (e.dataTransfer) {
        const extracted = await extractFilesFromDataTransfer(e.dataTransfer)
        if (extracted.length > 0) {
          handleUpload(extracted)
        } else if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
          showToast('The dropped folder contains no files.', 'info')
        }
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
  }, [handleUpload, showToast])

  // Clipboard paste listener: paste images or files directly from clipboard (Ctrl+V / Cmd+V)
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      if (!e.clipboardData) return
      const items = Array.from(e.clipboardData.items || [])
      const fileItems = items.filter(item => item.kind === 'file')

      if (fileItems.length > 0) {
        e.preventDefault()
        if (isProtected && !isAuthenticated) {
          showToast('Please unlock room to attach files.', 'error')
          return
        }

        try {
          const extracted = await extractFilesFromDataTransfer(e.clipboardData)
          if (extracted.length > 0) {
            const filesToUpload = extracted.map(file => {
              // Generate clean name for pasted screenshots/images if unnamed
              const name = file.name === 'image.png'
                ? `screenshot_${new Date().toISOString().replace(/[:.]/g, '-')}.png`
                : file.name
              return new File([file], name, { type: file.type || getMimeType(name) })
            })
            setShowFilesPanel(true)
            if (isMobile) setMobileTab('files')
            handleUpload(filesToUpload)
          } else {
            // Check if user attempted to paste a folder from clipboard that the browser blocked
            const attemptedFolder = items.some(item => {
              const entry = (item as unknown as { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.()
              if (entry?.isDirectory) return true
              const f = item.getAsFile()
              return f && f.size === 0 && !f.type && !f.name.includes('.')
            })
            if (attemptedFolder) {
              showToast('Browsers do not permit reading folder contents from clipboard (Ctrl+V). Please drag & drop the folder or use "Add Folder".', 'info')
            }
          }
        } catch (err) {
          console.error('Failed to extract clipboard files:', err)
        }
      }
    }

    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [handleUpload, showToast])

  const handleOpenSaveModal = useCallback(() => {
    const livePass = (slug ? sessionStorage.getItem('clip_live_pass_' + slug) : null) || ''
    if (livePass) {
      setSavePassword(livePass)
    }
    const cachedCode = (slug ? sessionStorage.getItem('clip_edit_code_' + slug) : null) || ''
    if (cachedCode && saveSlugChoice === 'room') {
      setSaveEditCode(cachedCode)
    }
    setShowSaveModal(true)
  }, [slug, saveSlugChoice])

  // Global keyboard shortcuts (Ctrl+S to save clip, Escape to close modals)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        handleOpenSaveModal()
      } else if (e.key === 'Escape') {
        setShowQrModal(false)
        setShowSaveModal(false)
        setPreviewFile(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleOpenSaveModal])

  // Delete live file
  const handleDeleteFile = async (fileId: string) => {
    if (!slug) return
    try {
      removeLocalFile(fileId)
      await deleteLiveFile(slug, fileId)
      setSelectedFileIds(prev => prev.filter(id => id !== fileId))
      showToast('File removed', 'info')
    } catch (err) {
      console.error('Delete failed:', err)
      showToast('Failed to delete file', 'error')
    }
  }

  // File selection for batch operations
  const toggleSelectFile = (fileId: string) => {
    setSelectedFileIds(prev =>
      prev.includes(fileId) ? prev.filter(id => id !== fileId) : [...prev, fileId]
    )
  }

  const toggleSelectAll = () => {
    if (selectedFileIds.length === files.length) {
      setSelectedFileIds([])
    } else {
      setSelectedFileIds(files.map(f => f.id))
    }
  }

  const handleBatchDelete = async () => {
    if (!slug || selectedFileIds.length === 0) return
    const count = selectedFileIds.length
    setIsBatchDeleting(true)
    try {
      removeLocalFiles(selectedFileIds)
      await batchDeleteLiveFiles(slug, selectedFileIds)
      setSelectedFileIds([])
      showToast(`Removed ${count} file${count > 1 ? 's' : ''}`, 'info')
    } catch (err) {
      console.error('Batch delete failed:', err)
      showToast('Failed to delete selected files.', 'error')
    } finally {
      setIsBatchDeleting(false)
    }
  }

  // Room unlock handler
  const handleUnlock = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!enterPass) return
    setIsAuthenticating(true)
    try {
      await authenticate(enterPass)
    } catch (err: any) {
      console.error('Auth error:', err)
    } finally {
      setIsAuthenticating(false)
    }
  }

  const handleDownloadLiveFile = useCallback(async (f: { id: string; fileName: string; fileMime: string }) => {
    const livePass = sessionStorage.getItem('clip_live_pass_' + slug) || ''
    const p2pBlob = getP2PBlob(f.id)

    try {
      let buf: ArrayBuffer
      if (p2pBlob) {
        buf = await p2pBlob.arrayBuffer()
      } else {
        const url = liveFileDownloadUrl(slug, f.id, f.fileMime, f.fileName)
        const res = await fetch(url)
        if (!res.ok) throw new Error('Fetch failed')
        buf = await res.arrayBuffer()
      }

      if (isEncryptedFileBuffer(buf)) {
        if (livePass) {
          const dec = await decryptFileBuffer(buf, livePass)
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
      }

      const blob = new Blob([buf], { type: f.fileMime || 'application/octet-stream' })
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = f.fileName.split(/[/\\]/).pop() || f.fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000)
    } catch (err) {
      console.error('Download error:', err)
      const a = document.createElement('a')
      a.href = liveFileDownloadUrl(slug, f.id, f.fileMime, f.fileName)
      a.download = f.fileName.split(/[/\\]/).pop() || f.fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    }
  }, [slug, getP2PBlob])

  const handleTriggerPreview = useCallback(async (f: { id: string; fileName: string; fileMime: string; fileSize: number }) => {
    const livePass = sessionStorage.getItem('clip_live_pass_' + slug) || ''
    const p2pBlob = getP2PBlob(f.id)

    if (p2pBlob || livePass) {
      try {
        let buf: ArrayBuffer
        if (p2pBlob) {
          buf = await p2pBlob.arrayBuffer()
        } else {
          const url = liveFileDownloadUrl(slug, f.id, f.fileMime, f.fileName)
          const res = await fetch(url)
          if (!res.ok) throw new Error('Fetch failed')
          buf = await res.arrayBuffer()
        }

        if (isEncryptedFileBuffer(buf) && livePass) {
          const dec = await decryptFileBuffer(buf, livePass)
          if (dec) {
            const blobUrl = URL.createObjectURL(dec.blob)
            setPreviewFile({
              id: f.id,
              url: blobUrl,
              blob: dec.blob,
              name: dec.fileName,
              mime: dec.fileMime,
              size: dec.blob.size,
            })
            return
          }
        } else if (p2pBlob) {
          const blobUrl = URL.createObjectURL(p2pBlob)
          setPreviewFile({
            id: f.id,
            url: blobUrl,
            blob: p2pBlob,
            name: f.fileName,
            mime: f.fileMime,
            size: f.fileSize,
          })
          return
        }
      } catch {}
    }

    setPreviewFile({
      id: f.id,
      url: liveFileDownloadUrl(slug, f.id, f.fileMime, f.fileName),
      name: f.fileName,
      mime: f.fileMime,
      size: f.fileSize,
    })
  }, [slug, getP2PBlob])

  // Clean up selected files when files list updates
  useEffect(() => {
    setSelectedFileIds(prev => prev.filter(id => files.some(f => f.id === id)))
  }, [files])

  // Custom slug validation helper
  const validateCustomSlug = (s: string): string | null => {
    const trimmed = s.trim().toLowerCase()
    if (!trimmed) return 'Please enter a custom URL.'
    if (trimmed.length < 3) return 'Custom URL must be at least 3 characters.'
    if (trimmed.length > 50) return 'Custom URL must be 50 characters or fewer.'
    if (trimmed.startsWith('-') || trimmed.endsWith('-')) return 'Custom URL cannot start or end with a hyphen.'
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(trimmed)) return 'Custom URL can only contain lowercase letters, numbers, and hyphens.'
    const reserved = new Set([
      'api', 'edit', 'new', 'create', 'help', 'about',
      '404', 'not-found', 'admin', 'login', 'signup',
      'static', '_next', '_headers', '_redirects',
      'favicon.ico', 'robots.txt', 'sitemap.xml',
      'raw', 'zip', 'r', 'z', 'f',
      'live', 'livepad', 'room', 'ws', 'new-slug',
    ])
    if (reserved.has(trimmed)) return `'${trimmed}' is a reserved URL. Please choose another.`
    return null
  }

  // Save as permanent / custom clip
  const handleSaveAsClip = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!slug) return
    setSaveSaving(true)
    setSaveError(null)

    try {
      if (!text.trim() && files.length === 0) {
        setSaveError('Cannot save an empty clip. Please add text or files first.')
        setSaveSaving(false)
        return
      }

      if (savePassword && savePassword.length < 4) {
        setSaveError('Password must be at least 4 characters.')
        setSaveSaving(false)
        return
      }

      let targetSlug = ''
      if (saveSlugChoice === 'room') {
        targetSlug = slug
      } else if (saveSlugChoice === 'custom') {
        const customErr = validateCustomSlug(saveCustomSlug)
        if (customErr) {
          setSaveError(customErr)
          setSaveSaving(false)
          return
        }
        targetSlug = saveCustomSlug.trim().toLowerCase()
      }

      let finalContent = text
      if (savePassword && savePassword.length >= 4) {
        if (text.trim()) {
          finalContent = await encryptContent(text, savePassword)
        } else if (files.length > 0) {
          finalContent = await encryptContent('{"file_lock":true}', savePassword)
        }
      }

      const form = new FormData()
      form.append('type', files.length > 0 ? 'file' : 'text')
      form.append('content', finalContent)
      form.append('editCode', saveEditCode)
      form.append('ttl', saveTtl)

      if (targetSlug) {
        form.append('slug', targetSlug)
      }

      // Fetch file blobs and attach them to the creation form (encrypting if password is set)
      const livePass = sessionStorage.getItem('clip_live_pass_' + slug) || ''
      for (const f of files) {
        let buf: ArrayBuffer | null = null
        const p2pBlob = getP2PBlob(f.id)
        if (p2pBlob) {
          buf = await p2pBlob.arrayBuffer()
        } else {
          const url = liveFileDownloadUrl(slug, f.id, f.fileMime, f.fileName)
          try {
            const res = await fetch(url)
            if (res.ok) {
              buf = await res.arrayBuffer()
            }
          } catch (e) {
            if (import.meta.env.DEV) console.warn('Fetch live file failed:', e)
          }
        }
        if (!buf) continue

        let rawFile: File
        if (isEncryptedFileBuffer(buf)) {
          if (livePass) {
            const dec = await decryptFileBuffer(buf, livePass)
            if (dec) {
              rawFile = new File([dec.blob], dec.fileName, { type: dec.fileMime })
            } else {
              rawFile = new File([buf], f.fileName, { type: f.fileMime })
            }
          } else {
            rawFile = new File([buf], f.fileName, { type: f.fileMime })
          }
        } else {
          rawFile = new File([buf], f.fileName, { type: f.fileMime })
        }

        const fileObj = (savePassword && savePassword.length >= 4)
          ? await encryptFile(rawFile, savePassword)
          : rawFile

        form.append('files', fileObj)
      }

      let createdSlug = targetSlug
      try {
        const created = await createEntryWithProgress(form, () => {})
        createdSlug = created.slug
      } catch (err: any) {
        if (err?.error === 'slug_taken' && targetSlug) {
          // If the entry already exists, update it if the user provided the edit code
          try {
            form.append('removeFile', 'true')
            await updateEntryWithProgress(targetSlug, form, () => {})
            createdSlug = targetSlug
          } catch (updateErr: any) {
            if (updateErr?.error === 'wrong_edit_code') {
              setSaveError(`The URL '/${targetSlug}' already exists. To update it, provide its existing edit code, or choose a different custom URL.`)
            } else {
              setSaveError(`The custom URL '/${targetSlug}' is already taken. Please choose another URL.`)
            }
            return
          }
        } else {
          const errorMap: Record<string, string> = {
            slug_taken: `The URL '/${targetSlug}' is already taken. Please choose another URL.`,
            slug_invalid: 'Custom URL is invalid. Must be 3–50 lowercase alphanumeric characters or hyphens (cannot start or end with a hyphen).',
            slug_reserved: 'This URL is reserved by the system. Please choose another.',
            missing_edit_code: 'Edit code must be at least 4 characters.',
            no_content: 'Please add some text or files before saving a clip.',
            file_too_large: 'Files exceed maximum upload size (50 MB total).',
            text_too_large: 'Text exceeds maximum allowable size (2 MB).',
          }
          setSaveError(errorMap[err?.error] || err?.error || 'Failed to save clip. Please try again.')
          return
        }
      }

      sessionStorage.setItem('clip_edit_code_' + createdSlug, saveEditCode)
      sessionStorage.removeItem('clip_decrypt_' + createdSlug)
      showToast(`Exported to /${createdSlug}!`, 'success')
      navigate(`/${createdSlug}`)
    } catch (err: any) {
      setSaveError(err?.message || 'Failed to save clip. Please try again.')
    } finally {
      setSaveSaving(false)
    }
  }

  // File icon helper with comprehensive format detection
  const getFileIcon = (mime: string, filename: string = '') => {
    if (isImageFile(mime, filename)) return <ImageIcon size={18} style={{ color: '#34d399' }} />
    if (isVideoFile(mime, filename)) return <Film size={18} style={{ color: '#f472b6' }} />
    if (isAudioFile(mime, filename)) return <Music size={18} style={{ color: '#ffffff' }} />
    if (isPdfFile(mime, filename)) return <FileText size={18} style={{ color: '#ef4444' }} />
    if (isArchiveFile(mime, filename)) return <FileArchive size={18} style={{ color: '#a1a1aa' }} />
    if (isTextOrCodeFile(mime, filename)) return <Code size={18} style={{ color: '#60a5fa' }} />
    return <FileIcon size={18} style={{ color: '#94a3b8' }} />
  }

  // Word & character stats
  const charCount = text.length
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0
  const lineCount = text ? text.split('\n').length : 1

  return (
    <div className="page-wrapper" style={{ height: isMobile ? '100dvh' : '100vh', maxHeight: isMobile ? '100dvh' : '100vh', overflow: 'hidden', padding: isMobile ? '0.5rem 0.6rem' : '1rem 1.5rem', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      {/* ── Drag & Drop Screen Overlay ────────────────────────────────────── */}
      {isDragging && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.92)',
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
            Drop files or folders to share in real time
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem' }}>
            All devices in this Live Pad will receive them instantly · Supports each and every file type
          </p>
        </div>
      )}

      <main className="content-box animate-fade-up" style={{ height: '100%', maxHeight: isMobile ? 'calc(100dvh - 1rem)' : 'calc(100vh - 2rem)', display: 'flex', flexDirection: 'column' }}>
        <h1 style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', border: 0 }}>
          Live Pad - Real-Time Collaborative Text and File Sharing
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

            {/* P2P LAN Direct Indicator */}
            {isP2PActive && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.35rem 0.65rem',
                  background: '#141414',
                  border: '1px solid #27272a',
                  borderRadius: '20px',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  color: '#ffffff',
                  letterSpacing: '0.02em',
                }}
                title={`WebRTC DataChannel active with ${p2pPeerCount} local peer${p2pPeerCount === 1 ? '' : 's'}. Direct LAN transfer speed.`}
              >
                <span
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: '#ffffff',
                    boxShadow: '0 0 6px rgba(255, 255, 255, 0.8)',
                  }}
                />
                <span>LAN Direct</span>
              </div>
            )}

            {/* QR Code Button (Desktop/Tablet only) */}
            {!isMobile && isAuthenticated && (
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
            {isAuthenticated && (
              <button
                type="button"
                onClick={handleOpenSaveModal}
                className="btn btn-primary"
                style={{ padding: '0.4rem 0.85rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.45rem' }}
                title="Save as permanent clip (Ctrl+S)"
              >
                <Lock size={14} /> <span>{isMobile ? 'Save' : 'Save as Clip'}</span>
              </button>
            )}
          </div>
        </div>

        {/* ── Main Workspace Card ──────────────────────────────────────────── */}
        <div className="card card-glow" style={{ padding: '0.9rem 1.15rem', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {!isProtectionChecked ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '3.5rem 1rem', textAlign: 'center' }}>
              <div className="spinner" style={{ width: 28, height: 28, borderWidth: 3, marginBottom: '0.85rem' }} />
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Connecting to LivePad…</p>
            </div>
          ) : isProtected && !isAuthenticated ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2.5rem 1rem', textAlign: 'center' }}>
              <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#141414', border: '1px solid #27272a', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1.25rem' }}>
                <Lock size={26} color="#ffffff" />
              </div>
              <h2 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#ffffff', marginBottom: '0.5rem' }}>
                This LivePad is Password Protected
              </h2>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginBottom: '1.5rem', maxWidth: 420, lineHeight: 1.6 }}>
                Enter the room password to join and decrypt this real-time session.
              </p>
              <form onSubmit={handleUnlock} style={{ display: 'flex', gap: '0.6rem', width: '100%', maxWidth: 360 }}>
                <input
                  type="password"
                  className="input"
                  placeholder="Enter password…"
                  value={enterPass}
                  onChange={e => setEnterPass(e.target.value)}
                  autoFocus
                  style={{ flex: 1 }}
                />
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isAuthenticating || !enterPass}
                  style={{ padding: '0 1.5rem', fontWeight: 600 }}
                >
                  {isAuthenticating ? <div className="spinner" style={{ borderColor: '#000', borderTopColor: 'transparent' }} /> : 'Unlock'}
                </button>
              </form>
              {authError && (
                <p style={{ marginTop: '1rem', fontSize: '0.825rem', color: '#ef4444', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <AlertCircle size={14} />
                  <span>{authError}</span>
                </p>
              )}
            </div>
          ) : (
            <>
              {/* Room Closed or Terminated Notice */}
              {roomClosedMessage && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.65rem',
                    padding: '0.75rem 1rem',
                    background: '#18181b',
                    border: '1px solid #ef4444',
                    borderRadius: '8px',
                    color: '#f87171',
                    fontSize: '0.85rem',
                    fontWeight: 500,
                    marginBottom: '0.75rem',
                    flexShrink: 0,
                  }}
                >
                  <AlertCircle size={18} style={{ color: '#ef4444', flexShrink: 0 }} />
                  <span style={{ color: '#fca5a5' }}>{roomClosedMessage}</span>
                </div>
              )}

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
                  readOnly={!!roomClosedMessage}
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
                    fontSize: isMobile ? '16px' : '0.95rem',
                    lineHeight: 1.65,
                    fontFamily: 'var(--font-mono)',
                    background: '#050505',
                    padding: isMobile ? '0.85rem' : '1.1rem',
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
                  width: isMobile ? '100%' : 'clamp(340px, 26vw, 420px)',
                  minWidth: isMobile ? '100%' : '300px',
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', marginBottom: '0.75rem', flexShrink: 0 }}>
                  {/* Title Bar */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0, flexWrap: 'nowrap' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.875rem', color: '#ffffff', whiteSpace: 'nowrap' }}>
                        Files & Media
                      </span>
                      <span
                        style={{
                          fontSize: '0.72rem',
                          fontWeight: 600,
                          color: '#ffffff',
                          background: '#27272a',
                          padding: '0.1rem 0.45rem',
                          borderRadius: '999px',
                          lineHeight: 1,
                          flexShrink: 0,
                        }}
                      >
                        {files.length}
                      </span>
                      <span
                        style={{
                          fontSize: '0.68rem',
                          color: 'var(--text-muted)',
                          background: '#141414',
                          border: '1px solid #27272a',
                          padding: '0.15rem 0.45rem',
                          borderRadius: '4px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                          whiteSpace: 'nowrap',
                          lineHeight: 1,
                          flexShrink: 0,
                        }}
                        title="Temporary 24-hour storage"
                      >
                        <Clock size={10} /> 24h
                      </span>
                    </div>

                    {/* Quick ZIP download if files exist */}
                    {files.length > 0 && (() => {
                      const cachedPass = isProtected ? (sessionStorage.getItem('clip_live_pass_' + slug) || '') : ''
                      const zipHref = liveZipDownloadUrl(slug) + (cachedPass ? `?pass=${encodeURIComponent(cachedPass)}` : '')
                      return (
                        <a
                          href={zipHref}
                          download={`${slug}_files.zip`}
                          className="btn btn-secondary"
                          style={{
                            padding: '0.25rem 0.55rem',
                            fontSize: '0.725rem',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.35rem',
                            textDecoration: 'none',
                            whiteSpace: 'nowrap',
                            flexShrink: 0,
                            height: '28px',
                          }}
                          title="Download all room files in a ZIP archive"
                        >
                          <Download size={12} /> ZIP
                        </a>
                      )
                    })()}
                  </div>

                  {/* Upload Action Buttons */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.45rem' }}>
                    <label
                      className="btn btn-secondary"
                      style={{
                        padding: '0.35rem 0.5rem',
                        fontSize: '0.75rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.35rem',
                        cursor: 'pointer',
                        margin: 0,
                        height: '32px',
                        boxSizing: 'border-box',
                        whiteSpace: 'nowrap',
                      }}
                      title="Upload individual files or media"
                    >
                      <Upload size={13} /> Add Files
                      <input
                        type="file"
                        multiple
                        style={{ display: 'none' }}
                        onChange={e => {
                          if (e.target.files && e.target.files.length > 0) {
                            handleUpload(e.target.files)
                            e.target.value = ''
                          }
                        }}
                      />
                    </label>

                    <label
                      className="btn btn-secondary"
                      style={{
                        padding: '0.35rem 0.5rem',
                        fontSize: '0.75rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.35rem',
                        cursor: 'pointer',
                        margin: 0,
                        height: '32px',
                        boxSizing: 'border-box',
                        whiteSpace: 'nowrap',
                      }}
                      title="Upload entire folder structure"
                    >
                      <FolderPlus size={13} /> Add Folder
                      <input
                        type="file"
                        // @ts-expect-error webkitdirectory is standard in HTML5 directory picker
                        webkitdirectory=""
                        directory=""
                        multiple
                        style={{ display: 'none' }}
                        onChange={e => {
                          if (e.target.files && e.target.files.length > 0) {
                            handleUpload(e.target.files)
                            e.target.value = ''
                          }
                        }}
                      />
                    </label>
                  </div>
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

                {/* Batch selection & delete toolbar */}
                {files.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.35rem 0.6rem',
                      background: '#0d0d10',
                      border: '1px solid var(--border)',
                      borderRadius: '6px',
                      marginBottom: '0.6rem',
                      fontSize: '0.75rem',
                      flexShrink: 0
                    }}
                  >
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', margin: 0, color: 'var(--text-muted)' }}>
                      <input
                        type="checkbox"
                        checked={files.length > 0 && selectedFileIds.length === files.length}
                        onChange={toggleSelectAll}
                      />
                      <span>Select All ({files.length})</span>
                    </label>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      {selectedFileIds.length > 0 && (
                        <>
                          <span style={{ color: '#ffffff', fontWeight: 600 }}>
                            {selectedFileIds.length} selected
                          </span>
                          <button
                            type="button"
                            onClick={handleBatchDelete}
                            disabled={isBatchDeleting}
                            className="btn btn-ghost"
                            style={{ padding: '0.2rem 0.5rem', fontSize: '0.725rem', color: '#ef4444', gap: '0.3rem' }}
                          >
                            {isBatchDeleting ? <div className="spinner" style={{ width: 12, height: 12 }} /> : <Trash2 size={12} />}
                            Delete ({selectedFileIds.length})
                          </button>
                        </>
                      )}
                    </div>
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
                      Paste screenshots with <kbd style={{ background: '#222', padding: '0.1rem 0.3rem', borderRadius: '4px' }}>Ctrl+V</kbd> or drag & drop files or folders here.
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
                      const isImg = isImageFile(f.fileMime, f.fileName)
                      const isVid = isVideoFile(f.fileMime, f.fileName)
                      const isAud = isAudioFile(f.fileMime, f.fileName)
                      const isCode = isTextOrCodeFile(f.fileMime, f.fileName)
                      const badge = getFileTypeBadge(f.fileName, f.fileMime)

                      const lastSlash = f.fileName.lastIndexOf('/')
                      const dirPart = lastSlash >= 0 ? f.fileName.slice(0, lastSlash + 1) : ''
                      const namePart = lastSlash >= 0 ? f.fileName.slice(lastSlash + 1) : f.fileName

                      return (
                        <div
                          key={f.id}
                          style={{
                            background: selectedFileIds.includes(f.id) ? '#18181b' : '#0a0a0a',
                            border: selectedFileIds.includes(f.id) ? '1px solid #71717a' : '1px solid var(--border)',
                            borderRadius: '8px',
                            overflow: 'hidden',
                            display: 'flex',
                            flexDirection: 'column',
                            flexShrink: 0,
                          }}
                        >
                          {/* Image Thumbnail Preview */}
                          {isImg ? (
                            <LiveImageThumbnail
                              slug={slug}
                              file={f}
                              getP2PBlob={getP2PBlob}
                              onClick={() => handleTriggerPreview(f)}
                            />
                          ) : isVid ? (
                            <div
                              onClick={() => handleTriggerPreview(f)}
                              style={{
                                height: '70px',
                                background: 'linear-gradient(135deg, #180d1e 0%, #0d0d12 100%)',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                position: 'relative',
                                gap: '0.5rem',
                              }}
                              title="Click to play video"
                            >
                              <div style={{ background: 'rgba(244,114,182,0.15)', border: '1px solid rgba(244,114,182,0.3)', padding: '0.4rem', borderRadius: '50%' }}>
                                <Play size={18} style={{ color: '#f472b6', marginLeft: '2px' }} />
                              </div>
                              <span style={{ fontSize: '0.75rem', color: '#f472b6', fontWeight: 600 }}>Play Video</span>
                            </div>
                          ) : isAud ? (
                            <div
                              onClick={() => handleTriggerPreview(f)}
                              style={{
                                height: '56px',
                                background: 'linear-gradient(135deg, #18181b 0%, #0e0e10 100%)',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '0.5rem',
                              }}
                              title="Click to play audio"
                            >
                              <Music size={18} style={{ color: '#ffffff' }} />
                              <span style={{ fontSize: '0.75rem', color: '#ffffff', fontWeight: 600 }}>Play Audio</span>
                            </div>
                          ) : isCode ? (
                            <div
                              onClick={() => handleTriggerPreview(f)}
                              style={{
                                height: '56px',
                                background: '#0a0d14',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '0.5rem',
                              }}
                              title="Click to preview code"
                            >
                              <Code size={18} style={{ color: '#60a5fa' }} />
                              <span style={{ fontSize: '0.75rem', color: '#60a5fa', fontWeight: 600 }}>Preview Source</span>
                            </div>
                          ) : (
                            <div
                              onClick={() => handleTriggerPreview(f)}
                              style={{
                                height: '56px',
                                background: '#0e0e10',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '0.5rem',
                              }}
                              title="Click to preview file"
                            >
                              {getFileIcon(f.fileMime, f.fileName)}
                              <span style={{ fontSize: '0.75rem', color: '#a1a1aa', fontWeight: 500 }}>{badge} File</span>
                            </div>
                          )}

                          {/* File Details & Actions */}
                          <div style={{ padding: '0.6rem 0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0, flex: 1 }}>
                              <input
                                type="checkbox"
                                checked={selectedFileIds.includes(f.id)}
                                onChange={() => toggleSelectFile(f.id)}
                                onClick={e => e.stopPropagation()}
                                style={{ cursor: 'pointer', flexShrink: 0 }}
                                title="Select file"
                              />
                              <div
                                onClick={() => handleTriggerPreview(f)}
                                style={{ minWidth: 0, flex: 1, cursor: 'pointer' }}
                                title={`Click to view: ${f.fileName}`}
                              >
                              <p
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
                                {dirPart && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{dirPart}</span>}
                                {namePart}
                              </p>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.15rem' }}>
                                <span style={{ fontSize: '0.725rem', color: 'var(--text-dim)' }}>
                                  {formatBytes(f.fileSize)}
                                </span>
                                <span
                                  style={{
                                    fontSize: '0.625rem',
                                    background: '#1a1a1e',
                                    border: '1px solid rgba(255,255,255,0.08)',
                                    color: '#d4d4d8',
                                    padding: '0.05rem 0.35rem',
                                    borderRadius: '3px',
                                    fontWeight: 600,
                                    letterSpacing: '0.4px',
                                  }}
                                >
                                  {badge}
                                </span>
                              </div>
                              </div>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexShrink: 0 }}>
                              <button
                                type="button"
                                onClick={() => handleTriggerPreview(f)}
                                className="btn btn-ghost"
                                style={{ padding: '0.25rem 0.4rem', color: 'var(--text-muted)' }}
                                title="Preview file"
                                onMouseEnter={e => (e.currentTarget.style.color = '#ffffff')}
                                onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
                              >
                                <Eye size={12} />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDownloadLiveFile(f)}
                                className="btn btn-secondary"
                                style={{ padding: '0.25rem 0.5rem', fontSize: '0.725rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                                title="Download"
                              >
                                <Download size={12} />
                              </button>
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
            </>
          )}
        </div>
      </main>

      {/* ── High-Quality File Preview Modal ─────────────────────────────── */}
      {previewFile && (
        <FilePreviewModal
          file={previewFile}
          onClose={() => {
            if (previewFile.blob) URL.revokeObjectURL(previewFile.url)
            setPreviewFile(null)
          }}
          onDownload={(item) => {
            const f = files.find(item2 => item2.id === item.id || item2.fileName === item.name)
            if (f) {
              handleDownloadLiveFile(f)
            } else {
              const a = document.createElement('a')
              a.href = item.url
              a.download = item.name.split(/[/\\]/).pop() || item.name
              document.body.appendChild(a)
              a.click()
              document.body.removeChild(a)
            }
          }}
          onDelete={(item) => {
            const f = files.find(item2 => item2.id === item.id || item2.fileName === item.name)
            if (f) {
              handleDeleteFile(f.id)
              if (previewFile.blob) URL.revokeObjectURL(previewFile.url)
              setPreviewFile(null)
            }
          }}
          hasPrev={(() => {
            const idx = files.findIndex(f => f.fileName === previewFile.name || f.id === previewFile.id)
            return idx > 0
          })()}
          hasNext={(() => {
            const idx = files.findIndex(f => f.fileName === previewFile.name || f.id === previewFile.id)
            return idx >= 0 && idx < files.length - 1
          })()}
          onNavigatePrev={() => {
            const idx = files.findIndex(f => f.fileName === previewFile.name || f.id === previewFile.id)
            if (idx > 0) handleTriggerPreview(files[idx - 1])
          }}
          onNavigateNext={() => {
            const idx = files.findIndex(f => f.fileName === previewFile.name || f.id === previewFile.id)
            if (idx >= 0 && idx < files.length - 1) handleTriggerPreview(files[idx + 1])
          }}
        />
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
                    onClick={() => {
                      setSaveSlugChoice('room')
                      const cached = sessionStorage.getItem('clip_edit_code_' + slug)
                      if (cached) setSaveEditCode(cached)
                    }}
                    className={`btn ${saveSlugChoice === 'room' ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ flex: 1, padding: '0.35rem 0.5rem', fontSize: '0.78rem' }}
                  >
                    Room (/{slug})
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSaveSlugChoice('custom')
                      if (saveCustomSlug) {
                        const cached = sessionStorage.getItem('clip_edit_code_' + saveCustomSlug)
                        if (cached) setSaveEditCode(cached)
                      }
                    }}
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
                  <div style={{ marginTop: '0.35rem' }}>
                    <div style={{ display: 'flex', alignItems: 'stretch' }}>
                      <span
                        style={{
                          padding: '0 0.65rem',
                          background: '#0a0a0c',
                          border: '1px solid var(--border)',
                          borderRight: 'none',
                          borderRadius: '8px 0 0 8px',
                          color: 'var(--text-dim)',
                          fontSize: '0.8rem',
                          display: 'flex',
                          alignItems: 'center',
                          userSelect: 'none',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {window.location.host}/
                      </span>
                      <input
                        type="text"
                        value={saveCustomSlug}
                        onChange={e => {
                          const val = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')
                          setSaveCustomSlug(val)
                          const cached = sessionStorage.getItem('clip_edit_code_' + val)
                          if (cached) setSaveEditCode(cached)
                        }}
                        className="input"
                        placeholder="your-custom-slug"
                        style={{ fontSize: '0.85rem', borderRadius: '0 8px 8px 0', flex: 1 }}
                        maxLength={50}
                        spellCheck={false}
                        autoFocus
                      />
                    </div>
                    {saveCustomSlug.length > 0 && saveCustomSlug.length < 3 && (
                      <p style={{ margin: '0.35rem 0 0', fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                        Custom slug must be at least 3 characters.
                      </p>
                    )}
                  </div>
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
                <label className="label">
                  Password Encryption{' '}
                  <span style={{ color: 'var(--text-dim)' }}>
                    {sessionStorage.getItem('clip_live_pass_' + slug) ? '(Pre-filled from room password)' : '(Optional)'}
                  </span>
                </label>
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
                  disabled={
                    saveSaving ||
                    saveEditCode.length < 4 ||
                    (saveSlugChoice === 'custom' && saveCustomSlug.trim().length < 3)
                  }
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
