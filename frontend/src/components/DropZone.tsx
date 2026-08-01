import { useState, useCallback, useRef } from 'react'
import { formatBytes } from '../lib/api'
import { Plus, X } from 'lucide-react'

interface Props {
  onFile?: (file: File | null) => void
  onFiles?: (files: File[]) => void
  maxBytes?: number
  height?: string
}

const MAX = 50 * 1024 * 1024 // 50 MB total limit

export default function DropZone({ onFile, onFiles, maxBytes = MAX, height = '202px' }: Props) {
  const [dragging, setDragging] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const acceptFiles = useCallback(
    (newFiles: File[]) => {
      setError('')
      const updated = [...selectedFiles, ...newFiles]

      const totalSize = updated.reduce((acc, f) => acc + f.size, 0)
      if (totalSize > maxBytes) {
        setError(`Total files size exceeds ${formatBytes(maxBytes)} limit.`)
        return
      }

      setSelectedFiles(updated)
      if (onFiles) onFiles(updated)
      if (onFile) onFile(updated[0] || null)
    },
    [selectedFiles, maxBytes, onFiles, onFile]
  )

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) acceptFiles(files)
  }

  const onInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length > 0) acceptFiles(files)
  }

  const removeFile = (index: number, e: React.MouseEvent) => {
    e.stopPropagation()
    const updated = selectedFiles.filter((_, i) => i !== index)
    setSelectedFiles(updated)
    if (onFiles) onFiles(updated)
    if (onFile) onFile(updated[0] || null)
    if (updated.length === 0 && inputRef.current) inputRef.current.value = ''
  }

  return (
    <div>
      <div
        className={`dropzone${dragging ? ' dropzone--over' : ''}`}
        style={{ height, minHeight: height }}
        onDragEnter={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={onInput}
        />

        {selectedFiles.length > 0 ? (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '170px', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '0.4rem', borderBottom: '1px solid #262626' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                {selectedFiles.length} FILE{selectedFiles.length > 1 ? 'S' : ''} SELECTED ({formatBytes(selectedFiles.reduce((a, f) => a + f.size, 0))})
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  inputRef.current?.click()
                }}
                className="btn btn-ghost"
                style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem', gap: '0.25rem' }}
              >
                <Plus size={12} /> Add more
              </button>
            </div>

            {selectedFiles.map((file, idx) => (
              <div
                key={`${file.name}-${idx}`}
                className="dropzone__selected"
                style={{ padding: '0.4rem 0.6rem', background: '#0a0a0a', borderRadius: '8px', border: '1px solid #262626' }}
              >
                <FileIcon />
                <div className="dropzone__info">
                  <span className="dropzone__name">{file.name}</span>
                  <span className="dropzone__size">{formatBytes(file.size)}</span>
                </div>
                <button
                  type="button"
                  className="dropzone__clear btn btn-ghost"
                  onClick={(e) => removeFile(idx, e)}
                  title="Remove file"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="dropzone__empty">
            <UploadIcon />
            <p>Drop file(s) here or <span className="dropzone__link">browse</span></p>
            <p className="dropzone__hint">Attach multiple files · Max {formatBytes(maxBytes)} total</p>
          </div>
        )}
      </div>

      {error && <p className="error-msg" style={{ marginTop: '0.4rem' }}>{error}</p>}

      <style>{`
        .dropzone {
          border: 1px dashed #262626;
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1rem 1.5rem;
          text-align: center;
          cursor: pointer;
          transition: border-color 180ms cubic-bezier(0.16, 1, 0.3, 1), background-color 180ms cubic-bezier(0.16, 1, 0.3, 1);
          background: #050505;
          box-sizing: border-box;
        }
        .dropzone:hover, .dropzone--over {
          border-color: #ffffff;
          background: #0d0d0d;
        }
        .dropzone__empty { display: flex; flex-direction: column; align-items: center; gap: 0.35rem; }
        .dropzone__empty p { color: #a1a1aa; font-size: 0.875rem; }
        .dropzone__link { color: #ffffff; text-decoration: underline; text-underline-offset: 3px; font-weight: 500; }
        .dropzone__hint { font-size: 0.775rem !important; color: #52525b !important; }
        .dropzone__selected { display: flex; align-items: center; gap: 0.75rem; text-align: left; }
        .dropzone__info { flex: 1; min-width: 0; }
        .dropzone__name { display: block; font-size: 0.85rem; font-weight: 500; color: #ffffff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dropzone__size { font-size: 0.75rem; color: #a1a1aa; }
        .dropzone__clear { padding: 0.25rem 0.5rem; font-size: 0.75rem; flex-shrink: 0; color: #f87171; }
      `}</style>
    </div>
  )
}

function UploadIcon() {
  return (
    <svg className="dropzone__icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{marginBottom:'0.25rem'}}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  )
}

function FileIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>
  )
}
