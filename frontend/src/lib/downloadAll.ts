import { Zip, ZipPassThrough } from 'fflate'
import { requestBigDownload, type DownloadAnswer } from './bigUpload'

export interface BucketFile {
  bundle: string
  n: number
  name: string
  size: number
}

/** Names inside a zip must be unique: "a.txt", "a (2).txt", ... */
function uniqueNames(files: BucketFile[]): string[] {
  const seen = new Map<string, number>()
  return files.map((f) => {
    const count = (seen.get(f.name) ?? 0) + 1
    seen.set(f.name, count)
    if (count === 1) return f.name
    const dot = f.name.lastIndexOf('.')
    return dot > 0 ? `${f.name.slice(0, dot)} (${count})${f.name.slice(dot)}` : `${f.name} (${count})`
  })
}

/**
 * Fetches every file and packs them into one zip as the bytes arrive (stored, not compressed: fast, and big files rarely
 * shrink), then hands the zip to the browser to save. `onProgress` receives 0..100.
 */
export async function downloadAllAsZip(files: BucketFile[], zipName: string, onProgress: (pct: number) => void): Promise<Exclude<DownloadAnswer, { url: string }> | null> {
  const total = files.reduce((a, f) => a + f.size, 0) || 1
  const chunks: Uint8Array[] = []
  let zipError: Error | null = null
  const zip = new Zip((err, chunk) => {
    if (err) zipError = err
    else chunks.push(chunk)
  })
  const names = uniqueNames(files)
  let done = 0
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!
    const answer = await requestBigDownload(f.bundle, f.n, true)
    if (!('url' in answer)) return answer
    const res = await fetch(answer.url).catch(() => null)
    if (!res?.ok || !res.body) return { error: 'failed' }
    const entry = new ZipPassThrough(names[i]!)
    zip.add(entry)
    const reader = res.body.getReader()
    for (;;) {
      const { value, done: finished } = await reader.read()
      if (finished) break
      entry.push(value)
      done += value.length
      onProgress(Math.min(99, (done / total) * 100))
    }
    entry.push(new Uint8Array(0), true)
  }
  zip.end()
  if (zipError) return { error: 'failed' }
  const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: 'application/zip' }))
  const a = document.createElement('a')
  a.href = url
  a.download = zipName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  onProgress(100)
  return null
}
