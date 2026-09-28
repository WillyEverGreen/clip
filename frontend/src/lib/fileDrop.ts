import { getMimeType } from './fileTypes'

/**
 * Reads a single batch of entries from a FileSystemDirectoryReader.
 */
function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(
      (entries) => resolve(entries || []),
      (err) => reject(err),
    )
  })
}

/**
 * Exhaustively reads all entries from a FileSystemDirectoryEntry,
 * handling the browser requirement that readEntries() must be called
 * repeatedly until it returns an empty array.
 */
async function readAllDirectoryEntries(dirEntry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dirEntry.createReader()
  const allEntries: FileSystemEntry[] = []

  // Keep reading batches until reader returns an empty list
  while (true) {
    try {
      const batch = await readBatch(reader)
      if (!batch || batch.length === 0) break
      allEntries.push(...batch)
    } catch (err) {
      console.warn('Error reading directory batch:', dirEntry.name, err)
      break
    }
  }

  return allEntries
}

/**
 * Traverses a FileSystemEntry recursively and collects all files,
 * preserving relative directory paths.
 */
async function traverseEntry(
  entry: FileSystemEntry,
  currentPath: string = '',
  collectedFiles: File[] = [],
): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry
    try {
      const file = await new Promise<File>((resolve, reject) => {
        fileEntry.file(resolve, reject)
      })

      // Preserve relative path within dropped folder (e.g., "my-folder/assets/logo.svg")
      const relativePath = currentPath ? `${currentPath}/${file.name}` : file.name
      const cleanPath = relativePath.replace(/^\/+/, '')

      // Infer proper MIME type if browser provided empty string
      const mime = getMimeType(cleanPath, file.type)

      const renamedFile = new File([file], cleanPath, {
        type: mime,
        lastModified: file.lastModified,
      })

      collectedFiles.push(renamedFile)
    } catch (err) {
      console.warn('Failed to extract file entry:', entry.name, err)
    }
  } else if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry
    const nextPath = currentPath ? `${currentPath}/${dirEntry.name}` : dirEntry.name

    try {
      const entries = await readAllDirectoryEntries(dirEntry)
      for (const sub of entries) {
        await traverseEntry(sub, nextPath, collectedFiles)
      }
    } catch (err) {
      console.warn('Failed to traverse directory:', dirEntry.name, err)
    }
  }
}

/**
 * Recursively traverses a FileSystemDirectoryHandle (File System Access API)
 */
async function traverseFileSystemHandle(
  dirHandle: FileSystemDirectoryHandle,
  currentPath: string = '',
  collectedFiles: File[] = [],
): Promise<void> {
  try {
    const iterator = (dirHandle as unknown as { values?: () => AsyncIterable<FileSystemHandle> }).values
      ? (dirHandle as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values()
      : (dirHandle as unknown as { entries: () => AsyncIterable<[string, FileSystemHandle]> }).entries()
    for await (const entry of iterator) {
      const handle = (Array.isArray(entry) ? entry[1] : entry) as FileSystemHandle
      const nextPath = currentPath ? `${currentPath}/${handle.name}` : handle.name
      if (handle.kind === 'file') {
        try {
          const fileHandle = handle as FileSystemFileHandle
          const file = await fileHandle.getFile()
          const cleanPath = nextPath.replace(/^\/+/, '')
          const mime = getMimeType(cleanPath, file.type)
          const renamedFile = new File([file], cleanPath, {
            type: mime,
            lastModified: file.lastModified,
          })
          collectedFiles.push(renamedFile)
        } catch (err) {
          console.warn('Failed to read file from directory handle:', handle.name, err)
        }
      } else if (handle.kind === 'directory') {
        await traverseFileSystemHandle(handle as FileSystemDirectoryHandle, nextPath, collectedFiles)
      }
    }
  } catch (err) {
    console.warn('Failed to read directory handle:', dirHandle.name, err)
  }
}

/**
 * Extracts all files from a DataTransfer object, recursively traversing
 * any dropped folders and preserving relative folder paths.
 * Falls back safely to dataTransfer.files if FileSystem API is unavailable,
 * while preventing dummy 0-byte folder files from being created.
 */
export async function extractFilesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const items = dataTransfer.items
  let hasDirectory = false

  if (items && items.length > 0) {
    const collectedFiles: File[] = []
    const promises: Promise<void>[] = []
    let usedApi = false

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind !== 'file') continue

      // 1. Try webkitGetAsEntry (Standard drag-and-drop folder traversal)
      let entry: FileSystemEntry | null = null
      try {
        if (typeof (item as unknown as { webkitGetAsEntry?: unknown }).webkitGetAsEntry === 'function') {
          entry = (item as unknown as { webkitGetAsEntry: () => FileSystemEntry | null }).webkitGetAsEntry()
        }
      } catch {
        entry = null
      }

      if (entry) {
        usedApi = true
        if (entry.isDirectory) {
          hasDirectory = true
        }
        promises.push(traverseEntry(entry, '', collectedFiles))
        continue
      }

      // 2. Try getAsFileSystemHandle (File System Access API)
      if (typeof (item as unknown as { getAsFileSystemHandle?: unknown }).getAsFileSystemHandle === 'function') {
        usedApi = true
        promises.push((async () => {
          try {
            const handle = await (item as unknown as { getAsFileSystemHandle: () => Promise<FileSystemHandle | null> }).getAsFileSystemHandle()
            if (handle) {
              if (handle.kind === 'directory') {
                hasDirectory = true
                await traverseFileSystemHandle(handle as FileSystemDirectoryHandle, '', collectedFiles)
              } else if (handle.kind === 'file') {
                const file = await (handle as FileSystemFileHandle).getFile()
                const mime = getMimeType(file.name, file.type)
                collectedFiles.push(new File([file], file.name, { type: mime, lastModified: file.lastModified }))
              }
            } else {
              const f = item.getAsFile()
              if (f) collectedFiles.push(f)
            }
          } catch {
            const f = item.getAsFile()
            if (f) collectedFiles.push(f)
          }
        })())
        continue
      }

      // 3. Regular file fallback for this item
      const f = item.getAsFile()
      if (f) {
        collectedFiles.push(f)
      }
    }

    if (usedApi || promises.length > 0) {
      await Promise.all(promises)
      if (collectedFiles.length > 0) {
        return collectedFiles
      }
      // If a directory was detected but no files were collected, return empty array
      // Never fall back to dataTransfer.files which turns the directory into a 0-byte fake file
      if (hasDirectory) {
        return []
      }
    }
  }

  // Fallback to dataTransfer.files (only if no directory was detected)
  if (!hasDirectory && dataTransfer.files && dataTransfer.files.length > 0) {
    const list = Array.from(dataTransfer.files)
    // Filter out dummy directory File objects (0-byte files with empty type and no extension)
    const validFiles = list.filter(f => {
      const isSuspectDirectory = f.size === 0 && !f.type && !f.name.includes('.')
      return !isSuspectDirectory
    })

    return validFiles.map((f) => {
      const mime = getMimeType(f.name, f.type)
      if (mime !== f.type) {
        return new File([f], f.name, { type: mime, lastModified: f.lastModified })
      }
      return f
    })
  }

  return []
}

/**
 * Normalizes files from an HTML file input (including folder pickers with webkitdirectory),
 * preserving webkitRelativePath when present.
 */
export function normalizeFileInputFiles(fileList: FileList | File[]): File[] {
  const files = Array.from(fileList)
  return files.map((f) => {
    const webkitFile = f as File & { webkitRelativePath?: string }
    const relativeName = webkitFile.webkitRelativePath && webkitFile.webkitRelativePath.trim() !== ''
      ? webkitFile.webkitRelativePath.replace(/^\/+/, '')
      : f.name

    const mime = getMimeType(relativeName, f.type)

    if (relativeName !== f.name || mime !== f.type) {
      return new File([f], relativeName, {
        type: mime,
        lastModified: f.lastModified,
      })
    }
    return f
  })
}
