import { useState } from 'react'
import { Download, File as FileIcon, HardDrive } from 'lucide-react'
import Countdown from './Countdown'
import { formatBytes, type PublicEntry } from '../lib/api'
import { requestBigDownload, downloadProblem } from '../lib/bigUpload'
import { downloadAllAsZip, type BucketFile } from '../lib/downloadAll'

/**
 * The files of a clip that were too big to keep in KV. They look and behave like the clip's other files: each has its
 * own Download button, and "Download all" packs them into one zip in the browser.
 */
export default function BundleFilesCard({ entry }: { entry: PublicEntry }) {
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [zipPct, setZipPct] = useState<number | null>(null)
  const now = Date.now()
  const files: (BucketFile & { expiresAt: number; type: string })[] = (entry.bundles ?? [])
    .filter((b) => b.expiresAt > now)
    .flatMap((b) => b.files.map((f) => ({ bundle: b.id, n: f.n, name: f.name, size: f.size, type: f.type, expiresAt: b.expiresAt })))
  if (files.length === 0) return null
  const total = files.reduce((a, f) => a + f.size, 0)

  const downloadOne = async (f: BucketFile) => {
    const key = `${f.bundle}:${f.n}`
    if (busy) return
    setBusy(key)
    setNotice('')
    const answer = await requestBigDownload(f.bundle, f.n)
    setBusy(null)
    if ('url' in answer) window.location.href = answer.url
    else setNotice(downloadProblem(answer.error))
  }

  const downloadAll = async () => {
    if (busy) return
    if (files.length === 1) return downloadOne(files[0]!)
    setBusy('all')
    setNotice('')
    setZipPct(0)
    const problem = await downloadAllAsZip(files, `${entry.slug}-files.zip`, setZipPct)
    setBusy(null)
    setZipPct(null)
    if (problem) setNotice(downloadProblem(problem.error))
  }

  return (
    <div data-testid="bundle-files" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <HardDrive size={16} color="#a1a1aa" />
          <span style={{ fontWeight: 600 }}>Files ({files.length})</span>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>· {formatBytes(total)}</span>
        </div>
        <button type="button" onClick={downloadAll} disabled={!!busy} className="btn btn-primary" data-testid="bundle-download-all" style={{ fontSize: '0.8125rem', padding: '0.45rem 0.9rem', gap: '0.4rem' }}>
          {busy === 'all' ? <div className="spinner" style={{ width: 14, height: 14 }} /> : <Download size={14} />}
          {zipPct !== null ? `Preparing ${Math.round(zipPct)}%` : files.length > 1 ? `Download All (${files.length})` : 'Download'}
        </button>
      </div>

      {notice && <p role="alert" data-testid="bundle-notice" style={{ margin: 0, color: '#fbbf24', fontSize: '0.88rem', lineHeight: 1.5 }}>{notice}</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
        {files.map((f) => {
          const ext = f.name.includes('.') ? f.name.split('.').pop()!.toUpperCase() : 'FILE'
          const key = `${f.bundle}:${f.n}`
          return (
            <div key={key} className="file-list-row" data-testid="bundle-file" style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', flexWrap: 'wrap', padding: '0.9rem 1.25rem', background: '#09090c', border: '1px solid var(--border)', borderRadius: '12px' }}>
              <div style={{ background: '#121216', border: '1px solid var(--border)', padding: '0.75rem', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <FileIcon size={22} color="#a1a1aa" />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontWeight: 600, fontSize: '1rem', color: '#ffffff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }} title={f.name}>{f.name}</p>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8125rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', margin: '0.25rem 0 0' }}>
                  <span>{ext} · {formatBytes(f.size)}</span>
                  <span style={{ color: 'var(--text-dim)' }}>·</span>
                  <span style={{ color: '#f87171', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>Auto-deletes in: <Countdown expiresAt={f.expiresAt} /></span>
                </p>
              </div>
              <button type="button" onClick={() => downloadOne(f)} disabled={!!busy} className="btn btn-ghost" style={{ gap: '0.4rem', padding: '0.45rem 0.85rem', fontSize: '0.8rem' }} aria-label={`Download ${f.name}`}>
                {busy === key ? <div className="spinner" style={{ width: 14, height: 14 }} /> : <Download size={14} />} Download
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
