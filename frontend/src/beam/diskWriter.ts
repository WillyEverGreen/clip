/**
 * Where an incoming Beam file goes.
 *
 * - Chrome / Edge / Opera: the File System Access API streams straight to a file the user picks,
 *   so memory use stays flat whatever the size.
 * - Other browsers: parts are kept as Blobs (which browsers may page out to disk) and handed to
 *   the normal download manager at the end. Capped at MEMORY_LIMIT.
 */

export const MEMORY_LIMIT = 2 * 1024 ** 3

export interface DiskWriter {
  kind: 'disk' | 'download'
  write(data: Blob): Promise<void>
  /** Finishes the file (closes it on disk, or starts the download). */
  close(): Promise<void>
  /** Throws away whatever was written. */
  abort(): Promise<void>
}

interface SaveFilePickerOptions {
  suggestedName?: string
}
type ShowSaveFilePicker = (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>

function savePicker(): ShowSaveFilePicker | null {
  const picker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker
  return typeof picker === 'function' ? picker.bind(window) : null
}

/** True when this browser can stream a file of any size straight to disk. */
export function canStreamToDisk(): boolean {
  return savePicker() !== null
}

export class UnsupportedSizeError extends Error {}

/**
 * Must be called from a user gesture (the Accept click) because it may open the save dialog.
 * Throws a DOMException named AbortError if the user closes the dialog.
 */
export async function createDiskWriter(name: string, size: number, type: string): Promise<DiskWriter> {
  const picker = savePicker()
  if (picker) {
    const handle = await picker({ suggestedName: name })
    const writable = await handle.createWritable()
    return {
      kind: 'disk',
      write: (data) => writable.write(data),
      close: () => writable.close(),
      abort: () => writable.abort().catch(() => undefined),
    }
  }

  if (size > MEMORY_LIMIT) {
    throw new UnsupportedSizeError('This browser can only receive files up to 2 GB. Open this page in Chrome or Edge to receive larger files.')
  }
  let parts: Blob[] = []
  return {
    kind: 'download',
    write: async (data) => {
      parts.push(data)
    },
    close: async () => {
      const blob = new Blob(parts, { type: type || 'application/octet-stream' })
      parts = []
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
      parts = []
    },
  }
}
