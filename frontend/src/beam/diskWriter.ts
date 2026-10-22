/**
 * Where an incoming Beam file goes.
 *
 * - Chrome / Edge / Opera: the File System Access API streams straight to a file the user picks,
 *   so memory use stays flat whatever the size. A half-finished file can be committed to disk and
 *   reopened later to carry on from the end (resume).
 * - Other browsers: parts are kept as Blobs (which browsers may page out to disk) and handed to
 *   the normal download manager at the end. Capped at MEMORY_LIMIT. These can resume only while the
 *   page stays open; after a reload there is nothing to continue from, so the transfer restarts.
 */

export const MEMORY_LIMIT = 2 * 1024 ** 3

/** What is needed to carry on writing the same file later. */
export type ResumeToken =
  | { kind: 'disk'; handle: FileSystemFileHandle }
  | { kind: 'download'; parts: Blob[] }

export interface DiskWriter {
  kind: 'disk' | 'download'
  write(data: Blob): Promise<void>
  /** Finishes the file (closes it on disk, or starts the download). */
  close(): Promise<void>
  /** Throws away whatever was written. */
  abort(): Promise<void>
  /** Commits what has been written so far and lets go of the file, so it can be reopened and continued. */
  suspend(): Promise<ResumeToken>
}

interface SaveFilePickerOptions {
  suggestedName?: string
}
type ShowSaveFilePicker = (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>
type PermissionHandle = FileSystemFileHandle & {
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
}

function savePicker(): ShowSaveFilePicker | null {
  const picker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker
  return typeof picker === 'function' ? picker.bind(window) : null
}

/** True when this browser can stream a file of any size straight to disk (and so resume after a reload). */
export function canStreamToDisk(): boolean {
  return savePicker() !== null
}

export class UnsupportedSizeError extends Error {}
/** The partial file cannot be continued (moved, changed, or permission refused). */
export class ResumeUnavailableError extends Error {}

function diskWriter(handle: FileSystemFileHandle, writable: FileSystemWritableFileStream): DiskWriter {
  return {
    kind: 'disk',
    write: (data) => writable.write(data),
    close: () => writable.close(),
    abort: () => writable.abort().catch(() => undefined),
    suspend: async () => {
      await writable.close() // commits everything written so far to the real file
      return { kind: 'disk', handle }
    },
  }
}

function memoryWriter(name: string, type: string, parts: Blob[]): DiskWriter {
  return {
    kind: 'download',
    write: async (data) => {
      parts.push(data)
    },
    close: async () => {
      const blob = new Blob(parts, { type: type || 'application/octet-stream' })
      parts.length = 0
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    },
    abort: async () => {
      parts.length = 0
    },
    suspend: async () => ({ kind: 'download', parts }),
  }
}

/**
 * Must be called from a user gesture (the Accept click) because it may open the save dialog.
 * Throws a DOMException named AbortError if the user closes the dialog.
 */
export async function createDiskWriter(name: string, size: number, type: string): Promise<DiskWriter> {
  const picker = savePicker()
  if (picker) {
    const handle = await picker({ suggestedName: name })
    return diskWriter(handle, await handle.createWritable())
  }
  if (size > MEMORY_LIMIT) {
    throw new UnsupportedSizeError('This browser can only receive files up to 2 GB. Open this page in Chrome or Edge to receive larger files.')
  }
  return memoryWriter(name, type, [])
}

/**
 * Whether we may write to a saved file again. A page that has been open all along keeps its permission;
 * after a reload the browser needs a click, which `prompt` allows (call it from a click handler).
 */
export async function hasWritePermission(token: ResumeToken, prompt: boolean): Promise<boolean> {
  if (token.kind !== 'disk') return true
  const handle = token.handle as PermissionHandle
  try {
    if (!handle.queryPermission) return true
    if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true
    if (!prompt || !handle.requestPermission) return false
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted'
  } catch {
    return false
  }
}

/** Opens a suspended file again, positioned to continue after the first `have` bytes. */
export async function reopenWriter(token: ResumeToken, have: number, name: string, type: string): Promise<DiskWriter> {
  if (token.kind === 'download') {
    const stored = token.parts.reduce((n, p) => n + p.size, 0)
    if (stored !== have) throw new ResumeUnavailableError('The partly received data is no longer available.')
    return memoryWriter(name, type, token.parts)
  }
  try {
    const file = await token.handle.getFile()
    if (file.size < have) throw new ResumeUnavailableError('The partly saved file is smaller than expected. It may have been moved or changed.')
    const writable = await token.handle.createWritable({ keepExistingData: true })
    await writable.truncate(have)
    await writable.seek(have)
    return diskWriter(token.handle, writable)
  } catch (err) {
    if (err instanceof ResumeUnavailableError) throw err
    throw new ResumeUnavailableError(`The partly saved file could not be reopened: ${(err as Error).message}`)
  }
}
