import { useState, useCallback, useRef } from 'react'
import { formatBytes } from '../lib/api'

interface Props {
  onFile: (file: File | null) => void
  maxBytes?: number
}

const MAX = 50 * 1024 * 1024

export default function DropZone({ onFile, maxBytes = MAX }: Props) {
  const [dragging,  setDragging]  = useState(false)
  const [selected,  setSelected]  = useState<File | null>(null)
  const [error,     setError]     = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const accept = useCallback((file: File) => {
    setError('')
    if (file.size > maxBytes) {
      setError(`File too large. Max ${formatBytes(maxBytes)}.`)
      return
    }
    setSelected(file)
    onFile(file)
  }, [maxBytes, onFile])

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) accept(file)
  }

  const onInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) accept(file)
  }

  const clear = (e: React.MouseEvent) => {
    e.stopPropagation()
    setSelected(null)
    setError('')
    onFile(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div>
      <div
        className={`dropzone${dragging ? ' dropzone--over' : ''}`}
        onDragEnter={e => { e.preventDefault(); setDragging(true) }}
        onDragOver={e  => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          style={{ display: 'none' }}
          onChange={onInput}
        />

        {selected ? (
          <div className="dropzone__selected">
            <FileIcon />
            <div className="dropzone__info">
              <span className="dropzone__name">{selected.name}</span>
              <span className="dropzone__size">{formatBytes(selected.size)}</span>
            </div>
            <button className="dropzone__clear btn btn-ghost" onClick={clear} title="Remove">✕</button>
          </div>
        ) : (
          <div className="dropzone__empty">
            <UploadIcon />
            <p>Drop your file here or <span className="dropzone__link">browse</span></p>
            <p className="dropzone__hint">Any file type · Max {formatBytes(maxBytes)}</p>
          </div>
        )}
      </div>
      {error && <p className="error-msg">{error}</p>}

      <style>{`
        .dropzone {
          border: 1px dashed #262626;
          border-radius: 12px;
          min-height: 250px;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 2rem;
          text-align: center;
          cursor: pointer;
          transition: border-color 180ms cubic-bezier(0.16, 1, 0.3, 1), background-color 180ms cubic-bezier(0.16, 1, 0.3, 1), transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
          background: #050505;
        }
        .dropzone:hover, .dropzone--over {
          border-color: #ffffff;
          background: #0d0d0d;
          transform: scale(1.006);
        }
        .dropzone--over .dropzone__icon {
          transform: translateY(-4px);
        }
        .dropzone__icon {
          transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        .dropzone__empty { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; }
        .dropzone__empty p { color: #a1a1aa; font-size: 0.9rem; }
        .dropzone__link { color: #ffffff; text-decoration: underline; text-underline-offset: 3px; font-weight: 500; }
        .dropzone__hint { font-size: 0.8rem !important; color: #52525b !important; }
        .dropzone__selected { display: flex; align-items: center; gap: 1rem; text-align: left; }
        .dropzone__info { flex: 1; min-width: 0; }
        .dropzone__name { display: block; font-size: 0.9rem; font-weight: 500; color: #ffffff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dropzone__size { font-size: 0.8rem; color: #a1a1aa; }
        .dropzone__clear { padding: 0.35rem 0.65rem; font-size: 0.8rem; flex-shrink: 0; }
      `}</style>
    </div>
  )
}

function UploadIcon() {
  return (
    <svg className="dropzone__icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{marginBottom:'0.5rem'}}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  )
}

function FileIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>
  )
}
