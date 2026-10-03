import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import {
  X,
  Download,
  Trash2,
  Copy,
  Check,
  Maximize2,
  Minimize2,
  ZoomIn,
  ZoomOut,
  RotateCw,
  WrapText,
  FileText,
  FileCode,
  Image as ImageIcon,
  Video as VideoIcon,
  Music as MusicIcon,
  Archive as ArchiveIcon,
  File as FileIcon,
  ChevronLeft,
  ChevronRight,
  Folder,
  ExternalLink,
  Search,
  Sparkles,
} from 'lucide-react'
import Prism from 'prismjs'
import { unzipSync } from 'fflate'
import {
  isImageFile,
  isVideoFile,
  isAudioFile,
  isPdfFile,
  isTextOrCodeFile,
  isArchiveFile,
  getFileTypeBadge,
  getExtension,
  getMimeType,
} from '../lib/fileTypes'
import { formatBytes } from '../lib/api'

// Mapping of file extensions to Prism grammar keys
const EXT_TO_PRISM: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  pyw: 'python',
  rs: 'rust',
  go: 'go',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  cs: 'csharp',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  rb: 'ruby',
  php: 'php',
  dart: 'dart',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  bat: 'batch',
  cmd: 'batch',
  ps1: 'powershell',
  psm1: 'powershell',
  json: 'json',
  json5: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'css',
  md: 'markdown',
  markdown: 'markdown',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'docker',
  ini: 'ini',
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export interface PreviewFileItem {
  id?: string
  name: string
  mime?: string
  size?: number
  url: string
  blob?: Blob
}

interface ZipEntryInfo {
  path: string
  size: number
  isDir: boolean
  data?: Uint8Array
}

export interface FilePreviewModalProps {
  file: PreviewFileItem | null
  onClose: () => void
  onDownload?: (file: PreviewFileItem) => void
  onDelete?: (file: PreviewFileItem) => void
  onNavigatePrev?: () => void
  onNavigateNext?: () => void
  hasPrev?: boolean
  hasNext?: boolean
}

export default function FilePreviewModal({
  file,
  onClose,
  onDownload,
  onDelete,
  onNavigatePrev,
  onNavigateNext,
  hasPrev,
  hasNext,
}: FilePreviewModalProps) {
  // Modal layout state
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Image viewer state
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [rotation, setRotation] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [imageDims, setImageDims] = useState<{ width: number; height: number } | null>(null)

  // Video viewer state
  const [videoDims, setVideoDims] = useState<{ width: number; height: number; duration: number } | null>(null)

  // Text/Code viewer state
  const [textContent, setTextContent] = useState<string | null>(null)
  const [textLoading, setTextLoading] = useState(false)
  const [textError, setTextError] = useState<string | null>(null)
  const [textCopied, setTextCopied] = useState(false)
  const [wrapText, setWrapText] = useState(true)
  const [textSearchQuery, setTextSearchQuery] = useState('')

  // ZIP inspector state
  const [zipEntries, setZipEntries] = useState<ZipEntryInfo[] | null>(null)
  const [zipLoading, setZipLoading] = useState(false)
  const [zipError, setZipError] = useState<string | null>(null)
  const [zipSearchQuery, setZipSearchQuery] = useState('')

  // Reset transforms whenever active file changes
  useEffect(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setRotation(0)
    setImageDims(null)
    setVideoDims(null)
    setTextContent(null)
    setTextError(null)
    setTextSearchQuery('')
    setZipEntries(null)
    setZipError(null)
    setZipSearchQuery('')
  }, [file?.url, file?.name])

  // Compute effective MIME and classification
  const effectiveMime = useMemo(() => {
    if (!file) return 'application/octet-stream'
    return getMimeType(file.name, file.mime)
  }, [file])

  const isImg = useMemo(() => file ? isImageFile(effectiveMime, file.name) : false, [file, effectiveMime])
  const isVid = useMemo(() => file ? isVideoFile(effectiveMime, file.name) : false, [file, effectiveMime])
  const isAud = useMemo(() => file ? isAudioFile(effectiveMime, file.name) : false, [file, effectiveMime])
  const isPdf = useMemo(() => file ? isPdfFile(effectiveMime, file.name) : false, [file, effectiveMime])
  const isCode = useMemo(() => file ? isTextOrCodeFile(effectiveMime, file.name) : false, [file, effectiveMime])
  const isZip = useMemo(() => file ? isArchiveFile(effectiveMime, file.name) : false, [file, effectiveMime])
  const badge = useMemo(() => file ? getFileTypeBadge(file.name, effectiveMime) : 'FILE', [file, effectiveMime])

  // Fetch text content for code/text files
  useEffect(() => {
    if (!file || !isCode) return

    let cancelled = false
    setTextLoading(true)
    setTextError(null)

    const loadText = async () => {
      try {
        if (file.blob) {
          const t = await file.blob.text()
          if (!cancelled) setTextContent(t)
        } else {
          const res = await fetch(file.url)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const t = await res.text()
          if (!cancelled) setTextContent(t)
        }
      } catch (err: any) {
        if (!cancelled) {
          setTextError(err?.message || 'Failed to read text content')
        }
      } finally {
        if (!cancelled) setTextLoading(false)
      }
    }

    loadText()
    return () => {
      cancelled = true
    }
  }, [file, isCode])

  // Parse ZIP archive content
  useEffect(() => {
    if (!file || !isZip) return

    let cancelled = false
    setZipLoading(true)
    setZipError(null)

    const loadZip = async () => {
      try {
        let buf: ArrayBuffer
        if (file.blob) {
          buf = await file.blob.arrayBuffer()
        } else {
          const res = await fetch(file.url)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          buf = await res.arrayBuffer()
        }

        const unzipped = unzipSync(new Uint8Array(buf))
        const entries: ZipEntryInfo[] = Object.entries(unzipped).map(([path, data]) => ({
          path,
          size: data.byteLength,
          isDir: path.endsWith('/'),
          data,
        }))

        // Sort: directories first, then files alphabetically
        entries.sort((a, b) => {
          if (a.isDir && !b.isDir) return -1
          if (!a.isDir && b.isDir) return 1
          return a.path.localeCompare(b.path)
        })

        if (!cancelled) {
          setZipEntries(entries)
        }
      } catch (err: any) {
        if (!cancelled) {
          setZipError('Archive could not be unpacked (unsupported format, encrypted, or corrupted).')
        }
      } finally {
        if (!cancelled) setZipLoading(false)
      }
    }

    loadZip()
    return () => {
      cancelled = true
    }
  }, [file, isZip])

  // Keyboard navigation & controls listener
  useEffect(() => {
    if (!file) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept typing in search inputs
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'ArrowLeft' && hasPrev && onNavigatePrev) {
        e.preventDefault()
        onNavigatePrev()
      } else if (e.key === 'ArrowRight' && hasNext && onNavigateNext) {
        e.preventDefault()
        onNavigateNext()
      } else if (isImg) {
        if (e.key === '+' || e.key === '=') {
          e.preventDefault()
          setZoom(z => Math.min(5, Number((z + 0.25).toFixed(2))))
        } else if (e.key === '-' || e.key === '_') {
          e.preventDefault()
          setZoom(z => Math.max(0.25, Number((z - 0.25).toFixed(2))))
        } else if (e.key === '0') {
          e.preventDefault()
          setZoom(1)
          setPan({ x: 0, y: 0 })
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [file, onClose, hasPrev, hasNext, onNavigatePrev, onNavigateNext, isImg])

  // Mouse wheel zoom for images
  const handleImageWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY < 0 ? 0.2 : -0.2
    setZoom(z => {
      const next = Math.max(0.25, Math.min(5, Number((z + delta).toFixed(2))))
      if (next === 1) setPan({ x: 0, y: 0 })
      return next
    })
  }, [])

  // Mouse drag-to-pan for images
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (zoom <= 1) return
    setIsDragging(true)
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y })
  }, [zoom, pan])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return
    setPan({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    })
  }, [isDragging, dragStart])

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  // Copy text to clipboard
  const handleCopyText = useCallback(() => {
    if (!textContent) return
    navigator.clipboard.writeText(textContent).then(() => {
      setTextCopied(true)
      setTimeout(() => setTextCopied(false), 2000)
    })
  }, [textContent])

  // Download individual file from inside ZIP
  const handleDownloadZipEntry = useCallback((entry: ZipEntryInfo) => {
    if (!entry.data) return
    const arrayBuf = entry.data.buffer.slice(
      entry.data.byteOffset,
      entry.data.byteOffset + entry.data.byteLength
    )
    const blob = new Blob([arrayBuf as BlobPart])
    const blobUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = entry.path.split('/').pop() || 'file'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000)
  }, [])

  // Highlighted code lines with Prism
  const codeLines = useMemo(() => {
    if (!textContent) return []
    return textContent.split('\n')
  }, [textContent])

  const highlightedHtml = useMemo(() => {
    if (!textContent || !file) return ''
    const ext = getExtension(file.name)
    const lang = EXT_TO_PRISM[ext] || 'text'
    const grammar = Prism.languages[lang]
    if (grammar) {
      try {
        return Prism.highlight(textContent, grammar, lang)
      } catch {
        return escapeHtml(textContent)
      }
    }
    return escapeHtml(textContent)
  }, [textContent, file])

  // Filtered ZIP entries
  const filteredZipEntries = useMemo(() => {
    if (!zipEntries) return []
    if (!zipSearchQuery.trim()) return zipEntries
    const q = zipSearchQuery.toLowerCase()
    return zipEntries.filter(e => e.path.toLowerCase().includes(q))
  }, [zipEntries, zipSearchQuery])

  if (!file) return null

  // File type icon with distinctive color
  const renderIcon = () => {
    if (isImg) return <ImageIcon size={18} style={{ color: '#38bdf8' }} />
    if (isVid) return <VideoIcon size={18} style={{ color: '#ec4899' }} />
    if (isAud) return <MusicIcon size={18} style={{ color: '#f59e0b' }} />
    if (isPdf) return <FileText size={18} style={{ color: '#ef4444' }} />
    if (isCode) return <FileCode size={18} style={{ color: '#a855f7' }} />
    if (isZip) return <ArchiveIcon size={18} style={{ color: '#10b981' }} />
    return <FileIcon size={18} style={{ color: '#94a3b8' }} />
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.92)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: isFullscreen ? 0 : '1rem',
        animation: 'fadeIn 180ms ease-out',
      }}
    >
      {/* ── Floating Previous File Chevron ────────────────────────────────────── */}
      {hasPrev && onNavigatePrev && !isFullscreen && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onNavigatePrev()
          }}
          className="btn btn-ghost"
          style={{
            position: 'fixed',
            left: '1rem',
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 100000,
            background: 'rgba(15, 15, 20, 0.75)',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '50%',
            width: 44,
            height: 44,
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#ffffff',
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
          }}
          title="Previous file (Left Arrow)"
        >
          <ChevronLeft size={24} />
        </button>
      )}

      {/* ── Floating Next File Chevron ────────────────────────────────────────── */}
      {hasNext && onNavigateNext && !isFullscreen && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onNavigateNext()
          }}
          className="btn btn-ghost"
          style={{
            position: 'fixed',
            right: '1rem',
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 100000,
            background: 'rgba(15, 15, 20, 0.75)',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '50%',
            width: 44,
            height: 44,
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#ffffff',
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
          }}
          title="Next file (Right Arrow)"
        >
          <ChevronRight size={24} />
        </button>
      )}

      {/* ── Main Modal Card ─────────────────────────────────────────────────── */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          width: isFullscreen ? '100vw' : '94vw',
          maxWidth: isFullscreen ? '100vw' : isVid ? '1240px' : isAud ? '560px' : '1100px',
          height: isFullscreen ? '100vh' : isAud ? 'auto' : '88vh',
          maxHeight: isFullscreen ? '100vh' : '92vh',
          background: '#09090c',
          border: isFullscreen ? 'none' : '1px solid #27272a',
          borderRadius: isFullscreen ? 0 : '14px',
          overflow: 'hidden',
          boxShadow: '0 30px 80px rgba(0, 0, 0, 0.95)',
          transition: 'width 200ms ease, height 200ms ease, border-radius 200ms ease',
        }}
      >
        {/* ── Top Header Toolbar ────────────────────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.75rem 1.15rem',
            background: '#121217',
            borderBottom: '1px solid #27272a',
            gap: '1rem',
            flexShrink: 0,
          }}
        >
          {/* File identity & badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', minWidth: 0, flex: 1 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                padding: '0.45rem',
                borderRadius: '8px',
                flexShrink: 0,
              }}
            >
              {renderIcon()}
            </div>
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <span
                style={{
                  color: '#ffffff',
                  fontSize: '0.925rem',
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={file.name}
              >
                {file.name}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginTop: '2px' }}>
                <span
                  style={{
                    fontSize: '0.65rem',
                    background: '#27272a',
                    color: '#e4e4e7',
                    padding: '0.1rem 0.45rem',
                    borderRadius: '4px',
                    fontWeight: 700,
                    letterSpacing: '0.4px',
                  }}
                >
                  {badge}
                </span>
                {file.size ? (
                  <span style={{ fontSize: '0.725rem', color: 'var(--text-muted)' }}>
                    {formatBytes(file.size)}
                  </span>
                ) : null}
                {isImg && imageDims && (
                  <span style={{ fontSize: '0.725rem', color: '#38bdf8' }}>
                    {imageDims.width} × {imageDims.height} px
                  </span>
                )}
                {isVid && videoDims && (
                  <span style={{ fontSize: '0.725rem', color: '#ec4899' }}>
                    {videoDims.width} × {videoDims.height} px · {Math.round(videoDims.duration)}s
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Context Controls & Action Buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0 }}>
            {/* Image zoom controls */}
            {isImg && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '2px', background: '#1c1c22', padding: '2px', borderRadius: '6px', border: '1px solid #2e2e36' }}>
                <button
                  type="button"
                  onClick={() => setZoom(z => Math.max(0.25, Number((z - 0.25).toFixed(2))))}
                  className="btn btn-ghost"
                  style={{ padding: '0.3rem', borderRadius: '4px', color: '#a1a1aa' }}
                  title="Zoom Out (-)"
                >
                  <ZoomOut size={15} />
                </button>
                <span
                  onClick={() => {
                    setZoom(1)
                    setPan({ x: 0, y: 0 })
                  }}
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    color: '#ffffff',
                    padding: '0 0.4rem',
                    cursor: 'pointer',
                    userSelect: 'none',
                    minWidth: '42px',
                    textAlign: 'center',
                  }}
                  title="Click to reset (100%)"
                >
                  {Math.round(zoom * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() => setZoom(z => Math.min(5, Number((z + 0.25).toFixed(2))))}
                  className="btn btn-ghost"
                  style={{ padding: '0.3rem', borderRadius: '4px', color: '#a1a1aa' }}
                  title="Zoom In (+)"
                >
                  <ZoomIn size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => setRotation(r => (r + 90) % 360)}
                  className="btn btn-ghost"
                  style={{ padding: '0.3rem', borderRadius: '4px', color: '#a1a1aa' }}
                  title="Rotate 90°"
                >
                  <RotateCw size={14} />
                </button>
              </div>
            )}

            {/* Code/Text Controls */}
            {isCode && (
              <>
                <button
                  type="button"
                  onClick={() => setWrapText(w => !w)}
                  className="btn btn-ghost"
                  style={{
                    padding: '0.35rem 0.55rem',
                    fontSize: '0.75rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    background: wrapText ? '#27272a' : 'transparent',
                    color: wrapText ? '#ffffff' : '#a1a1aa',
                  }}
                  title={wrapText ? 'Disable line wrap' : 'Enable line wrap'}
                >
                  <WrapText size={14} /> Wrap
                </button>
                <button
                  type="button"
                  onClick={handleCopyText}
                  className="btn btn-secondary"
                  style={{
                    padding: '0.35rem 0.65rem',
                    fontSize: '0.75rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                  }}
                  title="Copy file text"
                >
                  {textCopied ? <Check size={14} style={{ color: '#4ade80' }} /> : <Copy size={14} />}
                  {textCopied ? 'Copied' : 'Copy'}
                </button>
              </>
            )}

            {/* Fullscreen Modal Toggle (for desktop / theater mode) */}
            {!isAud && (
              <button
                type="button"
                onClick={() => setIsFullscreen(f => !f)}
                className="btn btn-ghost"
                style={{ padding: '0.4rem', color: '#a1a1aa' }}
                title={isFullscreen ? 'Exit full screen' : 'Expand full screen'}
              >
                {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
            )}

            {/* Download Button */}
            <button
              type="button"
              onClick={() => {
                if (onDownload) {
                  onDownload(file)
                } else {
                  const a = document.createElement('a')
                  a.href = file.url
                  a.download = file.name.split(/[/\\]/).pop() || file.name
                  document.body.appendChild(a)
                  a.click()
                  document.body.removeChild(a)
                }
              }}
              className="btn btn-primary"
              style={{
                padding: '0.4rem 0.75rem',
                fontSize: '0.775rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
              }}
              title="Download file"
            >
              <Download size={14} /> Download
            </button>

            {/* Optional Delete Button (LivePad mode) */}
            {onDelete && (
              <button
                type="button"
                onClick={() => onDelete(file)}
                className="btn btn-ghost"
                style={{ padding: '0.4rem', color: '#ef4444' }}
                title="Delete file"
              >
                <Trash2 size={16} />
              </button>
            )}

            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              className="btn btn-ghost"
              style={{ padding: '0.4rem', color: '#a1a1aa' }}
              title="Close (Esc)"
              onMouseEnter={e => (e.currentTarget.style.color = '#ffffff')}
              onMouseLeave={e => (e.currentTarget.style.color = '#a1a1aa')}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* ── Modal Body Content ────────────────────────────────────────────── */}
        <div
          style={{
            flex: 1,
            position: 'relative',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#040406',
          }}
        >
          {/* ── 1. Image Viewer (High-Res, Pan & Zoom) ─────────────────────── */}
          {isImg && (
            <div
              onWheel={handleImageWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              style={{
                width: '100%',
                height: '100%',
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
                userSelect: 'none',
              }}
            >
              <img
                src={file.url}
                alt={file.name}
                onLoad={(e) => {
                  setImageDims({
                    width: e.currentTarget.naturalWidth,
                    height: e.currentTarget.naturalHeight,
                  })
                }}
                style={{
                  maxWidth: zoom <= 1 ? '100%' : 'none',
                  maxHeight: zoom <= 1 ? '100%' : 'none',
                  objectFit: 'contain',
                  imageRendering: 'auto',
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`,
                  transition: isDragging ? 'none' : 'transform 100ms ease-out',
                  pointerEvents: 'none',
                }}
              />
            </div>
          )}

          {/* ── 2. Video Player (Theater & Cinematic) ────────────────────── */}
          {isVid && (
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#000000',
                padding: '0.5rem',
              }}
            >
              <video
                src={file.url}
                controls
                autoPlay={false}
                playsInline
                preload="metadata"
                onLoadedMetadata={(e) => {
                  setVideoDims({
                    width: e.currentTarget.videoWidth,
                    height: e.currentTarget.videoHeight,
                    duration: e.currentTarget.duration,
                  })
                }}
                style={{
                  width: '100%',
                  height: 'auto',
                  maxHeight: isFullscreen ? '94vh' : 'calc(86vh - 80px)',
                  objectFit: 'contain',
                  borderRadius: isFullscreen ? 0 : '8px',
                  background: '#000000',
                }}
              />
            </div>
          )}

          {/* ── 3. Audio Player ────────────────────────────────────────────── */}
          {isAud && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '1.75rem',
                padding: '3rem 2rem',
                width: '100%',
                maxWidth: '480px',
                background: '#0b0b0f',
                borderRadius: '16px',
                border: '1px solid #27272a',
                margin: 'auto',
                boxShadow: '0 20px 50px rgba(0,0,0,0.6)',
              }}
            >
              <div
                style={{
                  background: 'radial-gradient(circle, rgba(245, 158, 11, 0.25) 0%, rgba(15, 15, 20, 0.4) 70%)',
                  border: '1px solid rgba(245, 158, 11, 0.35)',
                  padding: '1.75rem',
                  borderRadius: '50%',
                  boxShadow: '0 0 30px rgba(245, 158, 11, 0.15)',
                }}
              >
                <MusicIcon size={52} style={{ color: '#f59e0b' }} />
              </div>

              <div style={{ textAlign: 'center', width: '100%' }}>
                <p
                  style={{
                    margin: 0,
                    fontSize: '1.1rem',
                    fontWeight: 700,
                    color: '#ffffff',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {file.name}
                </p>
                <p style={{ margin: '0.35rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  {badge} Audio Stream · {file.size ? formatBytes(file.size) : 'Ready'}
                </p>
              </div>

              <audio
                src={file.url}
                controls
                autoPlay={false}
                style={{ width: '100%', outline: 'none' }}
              />
            </div>
          )}

          {/* ── 4. PDF Viewer ──────────────────────────────────────────────── */}
          {isPdf && (
            <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.45rem 1rem',
                  background: '#15151a',
                  borderBottom: '1px solid #27272a',
                  fontSize: '0.775rem',
                  color: 'var(--text-muted)',
                }}
              >
                <span>Viewing PDF Document</span>
                <a
                  href={file.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: '#38bdf8',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    textDecoration: 'none',
                  }}
                >
                  Open in new tab <ExternalLink size={12} />
                </a>
              </div>
              <iframe
                src={file.url}
                title={file.name}
                style={{
                  width: '100%',
                  height: '100%',
                  border: 'none',
                  background: '#ffffff',
                }}
              />
            </div>
          )}

          {/* ── 5. Code & Text Viewer (Syntax Highlighted, Line Numbers) ────── */}
          {isCode && (
            <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#070709' }}>
              {/* Search filter in text */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.4rem 1rem',
                  background: '#0f0f13',
                  borderBottom: '1px solid #27272a',
                  gap: '1rem',
                  flexShrink: 0,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, maxWidth: '320px' }}>
                  <Search size={14} style={{ color: '#71717a' }} />
                  <input
                    type="text"
                    value={textSearchQuery}
                    onChange={e => setTextSearchQuery(e.target.value)}
                    placeholder="Find in file..."
                    style={{
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      color: '#ffffff',
                      fontSize: '0.8rem',
                      width: '100%',
                    }}
                  />
                  {textSearchQuery && (
                    <button
                      type="button"
                      onClick={() => setTextSearchQuery('')}
                      className="btn btn-ghost"
                      style={{ padding: '0.1rem 0.3rem', color: '#71717a' }}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  <span>{codeLines.length} lines</span>
                  <span>·</span>
                  <span>{textContent ? formatBytes(textContent.length) : '0 B'}</span>
                  <span>·</span>
                  <span>UTF-8</span>
                </div>
              </div>

              {/* Text content area */}
              <div
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  overflowX: wrapText ? 'hidden' : 'auto',
                  padding: '0.5rem 0',
                }}
              >
                {textLoading ? (
                  <div style={{ padding: '4rem 2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                    <div className="spinner" style={{ width: 24, height: 24, margin: '0 auto 1rem' }} />
                    <p style={{ margin: 0, fontSize: '0.9rem' }}>Loading file text...</p>
                  </div>
                ) : textError ? (
                  <div style={{ padding: '4rem 2rem', textAlign: 'center', color: '#ef4444' }}>
                    <p style={{ margin: 0, fontSize: '0.9rem' }}>{textError}</p>
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'flex',
                      fontFamily: 'var(--font-mono, "SFMono-Regular", Consolas, monospace)',
                      fontSize: '0.825rem',
                      lineHeight: 1.6,
                      minWidth: '100%',
                    }}
                  >
                    {/* Line numbers gutter */}
                    <div
                      style={{
                        userSelect: 'none',
                        textAlign: 'right',
                        padding: '0 0.85rem 0 1rem',
                        color: '#52525b',
                        borderRight: '1px solid #1f1f26',
                        background: '#070709',
                        flexShrink: 0,
                      }}
                    >
                      {codeLines.map((_, i) => (
                        <div key={i}>{i + 1}</div>
                      ))}
                    </div>

                    {/* Syntax highlighted code block */}
                    <pre
                      style={{
                        margin: 0,
                        padding: '0 1.25rem',
                        color: '#f4f4f5',
                        background: 'transparent',
                        whiteSpace: wrapText ? 'pre-wrap' : 'pre',
                        wordBreak: wrapText ? 'break-word' : 'normal',
                        overflow: 'visible',
                        flex: 1,
                      }}
                    >
                      <code dangerouslySetInnerHTML={{ __html: highlightedHtml || '(Empty file)' }} />
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── 6. ZIP & Archive Inspector ─────────────────────────────────── */}
          {isZip && (
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                background: '#09090d',
              }}
            >
              {/* Archive header banner & search */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.75rem 1.25rem',
                  background: '#121217',
                  borderBottom: '1px solid #27272a',
                  flexWrap: 'wrap',
                  gap: '0.75rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Sparkles size={16} style={{ color: '#10b981' }} />
                  <span style={{ fontSize: '0.875rem', fontWeight: 600, color: '#ffffff' }}>
                    Archive Inspector
                  </span>
                  {zipEntries && (
                    <span
                      style={{
                        fontSize: '0.725rem',
                        background: 'rgba(16, 185, 129, 0.15)',
                        border: '1px solid rgba(16, 185, 129, 0.3)',
                        color: '#34d399',
                        padding: '0.1rem 0.5rem',
                        borderRadius: '999px',
                        fontWeight: 600,
                      }}
                    >
                      {zipEntries.filter(e => !e.isDir).length} files
                    </span>
                  )}
                </div>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    background: '#070709',
                    border: '1px solid #27272a',
                    padding: '0.3rem 0.6rem',
                    borderRadius: '6px',
                    width: '260px',
                  }}
                >
                  <Search size={14} style={{ color: '#71717a' }} />
                  <input
                    type="text"
                    value={zipSearchQuery}
                    onChange={e => setZipSearchQuery(e.target.value)}
                    placeholder="Search inside archive..."
                    style={{
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      color: '#ffffff',
                      fontSize: '0.8rem',
                      width: '100%',
                    }}
                  />
                  {zipSearchQuery && (
                    <button
                      type="button"
                      onClick={() => setZipSearchQuery('')}
                      className="btn btn-ghost"
                      style={{ padding: '0.1rem 0.2rem', color: '#71717a' }}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              </div>

              {/* Archive entries list */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem 1.25rem' }}>
                {zipLoading ? (
                  <div style={{ padding: '4rem 2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                    <div className="spinner" style={{ width: 24, height: 24, margin: '0 auto 1rem' }} />
                    <p style={{ margin: 0, fontSize: '0.9rem' }}>Extracting archive manifest in browser...</p>
                  </div>
                ) : zipError ? (
                  <div
                    style={{
                      padding: '3rem 2rem',
                      textAlign: 'center',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '1rem',
                    }}
                  >
                    <ArchiveIcon size={44} style={{ color: '#71717a' }} />
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', maxWidth: '400px', margin: 0 }}>
                      {zipError}
                    </p>
                    <button
                      type="button"
                      onClick={() => onDownload?.(file)}
                      className="btn btn-secondary"
                      style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.825rem' }}
                    >
                      <Download size={14} /> Download Archive Directly
                    </button>
                  </div>
                ) : filteredZipEntries.length === 0 ? (
                  <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                    No files found matching "{zipSearchQuery}"
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    {filteredZipEntries.map((entry, idx) => {
                      return (
                        <div
                          key={idx}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '0.55rem 0.85rem',
                            background: '#0d0d12',
                            border: '1px solid #1f1f26',
                            borderRadius: '8px',
                            gap: '0.75rem',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', minWidth: 0, flex: 1 }}>
                            {entry.isDir ? (
                              <Folder size={16} style={{ color: '#60a5fa', flexShrink: 0 }} />
                            ) : (
                              <FileText size={16} style={{ color: '#94a3b8', flexShrink: 0 }} />
                            )}
                            <span
                              style={{
                                color: entry.isDir ? '#93c5fd' : '#ffffff',
                                fontSize: '0.825rem',
                                fontFamily: 'var(--font-mono, monospace)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                              title={entry.path}
                            >
                              {entry.path}
                            </span>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', flexShrink: 0 }}>
                            {!entry.isDir && (
                              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                {formatBytes(entry.size)}
                              </span>
                            )}
                            {!entry.isDir && entry.data && (
                              <button
                                type="button"
                                onClick={() => handleDownloadZipEntry(entry)}
                                className="btn btn-ghost"
                                style={{
                                  padding: '0.25rem 0.5rem',
                                  fontSize: '0.725rem',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '0.25rem',
                                  color: '#38bdf8',
                                }}
                                title="Extract this file"
                              >
                                <Download size={13} /> Extract
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── 7. Generic Binary / Unsupported File Fallback ────────────── */}
          {!isImg && !isVid && !isAud && !isPdf && !isCode && !isZip && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '1.25rem',
                padding: '3rem 2rem',
                textAlign: 'center',
                maxWidth: '460px',
              }}
            >
              <div
                style={{
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid #27272a',
                  padding: '1.75rem',
                  borderRadius: '50%',
                }}
              >
                <FileIcon size={48} style={{ color: '#94a3b8' }} />
              </div>
              <div>
                <h3 style={{ margin: 0, color: '#ffffff', fontSize: '1.2rem', fontWeight: 700 }}>
                  {file.name}
                </h3>
                <p style={{ margin: '0.4rem 0 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  {badge} file · {file.size ? formatBytes(file.size) : 'Ready to download'} · {effectiveMime}
                </p>
              </div>
              <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: '0.8rem', lineHeight: 1.5 }}>
                Direct preview is not available for this binary format. You can download the file to open it with your device's native application.
              </p>
              <button
                type="button"
                onClick={() => onDownload?.(file)}
                className="btn btn-primary"
                style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', padding: '0.6rem 1.25rem', marginTop: '0.5rem' }}
              >
                <Download size={16} /> Download File
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
