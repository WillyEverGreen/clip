/**
 * Comprehensive MIME type mapping and file classification utilities for LivePad and Clip.
 * Supports every common file type across code, markup, data, documents, media, archives, and binaries.
 */

export const EXTENSION_MIME_MAP: Record<string, string> = {
  // Web & Code
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  scss: 'text/x-scss',
  sass: 'text/x-sass',
  less: 'text/x-less',
  js: 'application/javascript',
  mjs: 'application/javascript',
  cjs: 'application/javascript',
  jsx: 'text/jsx',
  ts: 'application/typescript',
  tsx: 'text/tsx',
  json: 'application/json',
  json5: 'application/json5',
  jsonc: 'application/json',
  wasm: 'application/wasm',
  vue: 'text/x-vue',
  svelte: 'text/x-svelte',
  astro: 'text/x-astro',

  // Programming languages
  py: 'text/x-python',
  pyw: 'text/x-python',
  pyi: 'text/x-python',
  rs: 'text/rust',
  go: 'text/x-go',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  hpp: 'text/x-c++',
  cc: 'text/x-c++',
  cxx: 'text/x-c++',
  cs: 'text/x-csharp',
  java: 'text/x-java',
  kt: 'text/x-kotlin',
  kts: 'text/x-kotlin',
  swift: 'text/x-swift',
  rb: 'text/x-ruby',
  php: 'text/x-php',
  lua: 'text/x-lua',
  dart: 'text/x-dart',
  scala: 'text/x-scala',
  zig: 'text/x-zig',
  nim: 'text/x-nim',
  r: 'text/x-r',
  jl: 'text/x-julia',
  pl: 'text/x-perl',
  pm: 'text/x-perl',
  ex: 'text/x-elixir',
  exs: 'text/x-elixir',
  erl: 'text/x-erlang',
  clj: 'text/x-clojure',
  lisp: 'text/x-lisp',
  hs: 'text/x-haskell',

  // Shell & Scripts
  sh: 'application/x-sh',
  bash: 'application/x-sh',
  zsh: 'application/x-sh',
  fish: 'application/x-fish',
  bat: 'application/x-bat',
  cmd: 'application/x-bat',
  ps1: 'text/x-powershell',
  psm1: 'text/x-powershell',

  // Config & Data
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  xml: 'application/xml',
  ini: 'text/plain',
  conf: 'text/plain',
  cfg: 'text/plain',
  env: 'text/plain',
  properties: 'text/plain',
  sql: 'application/sql',
  prisma: 'text/plain',
  graphql: 'application/graphql',
  gql: 'application/graphql',

  // Plain Text & Documentation
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdx: 'text/mdx',
  rst: 'text/x-rst',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  diff: 'text/x-diff',
  patch: 'text/x-diff',

  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  psd: 'image/vnd.adobe.photoshop',
  ai: 'application/postscript',
  eps: 'application/postscript',

  // Audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  opus: 'audio/opus',
  weba: 'audio/webm',
  mid: 'audio/midi',
  midi: 'audio/midi',

  // Video
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  m4v: 'video/x-m4v',
  ogv: 'video/ogg',
  '3gp': 'video/3gpp',
  m2ts: 'video/mp2t',

  // Documents
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  epub: 'application/epub+zip',

  // Archives & Compressed
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  bz2: 'application/x-bzip2',
  xz: 'application/x-xz',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  iso: 'application/x-iso9660-image',
  dmg: 'application/x-apple-diskimage',

  // Fonts
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  eot: 'application/vnd.ms-fontobject',

  // Binaries & Executables
  exe: 'application/vnd.microsoft.portable-executable',
  bin: 'application/octet-stream',
  dll: 'application/octet-stream',
  so: 'application/octet-stream',
  dylib: 'application/octet-stream',
  sqlite: 'application/x-sqlite3',
  sqlite3: 'application/x-sqlite3',
  db: 'application/x-sqlite3',
}

/**
 * Extracts the file extension (in lowercase) from a filename or path.
 */
export function getExtension(filename: string): string {
  if (!filename) return ''
  // Strip query string if any
  const clean = filename.split('?')[0].split('#')[0]
  // Extract base filename if path contains slashes
  const base = clean.split(/[/\\]/).pop() || ''
  // Special handling for hidden files like .env, .gitignore, .dockerignore
  if (base.startsWith('.') && !base.slice(1).includes('.')) {
    return base.slice(1).toLowerCase()
  }
  const parts = base.split('.')
  if (parts.length <= 1) return ''
  return parts.pop()?.toLowerCase() || ''
}

/**
 * Infer the best MIME type for a file from its name and supplied MIME.
 */
export function getMimeType(filename: string, fallbackMime?: string): string {
  if (fallbackMime && fallbackMime !== 'application/octet-stream' && fallbackMime !== '') {
    return fallbackMime
  }
  const ext = getExtension(filename)
  if (ext && EXTENSION_MIME_MAP[ext]) {
    return EXTENSION_MIME_MAP[ext]
  }
  return fallbackMime || 'application/octet-stream'
}

/**
 * Determine if a file is an image by MIME type or extension.
 */
export function isImageFile(mime: string, filename: string): boolean {
  if (mime && mime.startsWith('image/')) return true
  const ext = getExtension(filename)
  return ['png', 'jpg', 'jpeg', 'jpe', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tiff', 'tif', 'avif', 'heic', 'heif'].includes(ext)
}

/**
 * Determine if a file is a video by MIME type or extension.
 */
export function isVideoFile(mime: string, filename: string): boolean {
  if (mime && mime.startsWith('video/')) return true
  const ext = getExtension(filename)
  return ['mp4', 'webm', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'm4v', 'ogv', '3gp'].includes(ext)
}

/**
 * Determine if a file is an audio file by MIME type or extension.
 */
export function isAudioFile(mime: string, filename: string): boolean {
  if (mime && mime.startsWith('audio/')) return true
  const ext = getExtension(filename)
  return ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus', 'weba', 'mid', 'midi'].includes(ext)
}

/**
 * Determine if a file is a PDF by MIME type or extension.
 */
export function isPdfFile(mime: string, filename: string): boolean {
  return mime === 'application/pdf' || getExtension(filename) === 'pdf'
}

/**
 * Determine if a file is text / code / readable in a text editor.
 */
export function isTextOrCodeFile(mime: string, filename: string): boolean {
  if (mime) {
    if (mime.startsWith('text/')) return true
    if (mime.includes('json') || mime.includes('javascript') || mime.includes('typescript') || mime.includes('xml') || mime.includes('yaml') || mime.includes('sql') || mime.includes('graphql')) {
      return true
    }
  }
  const ext = getExtension(filename)
  const textExtensions = [
    'txt', 'log', 'md', 'markdown', 'mdx', 'csv', 'tsv', 'json', 'json5', 'jsonc',
    'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'pyw', 'rs', 'go', 'c', 'cpp',
    'h', 'hpp', 'cs', 'java', 'kt', 'kts', 'swift', 'rb', 'php', 'lua', 'dart',
    'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'sql', 'yaml', 'yml',
    'toml', 'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'ini', 'conf',
    'cfg', 'env', 'gitignore', 'dockerfile', 'diff', 'patch', 'prisma', 'graphql', 'gql'
  ]
  const base = filename.split(/[/\\]/).pop()?.toLowerCase() || ''
  if (['dockerfile', 'makefile', 'procfile', 'license', 'cname', 'authors', 'readme'].includes(base)) {
    return true
  }
  return textExtensions.includes(ext)
}

/**
 * Determine if a file is an archive / compressed file.
 */
export function isArchiveFile(mime: string, filename: string): boolean {
  if (mime) {
    if (mime.includes('zip') || mime.includes('tar') || mime.includes('rar') || mime.includes('gzip') || mime.includes('compressed')) {
      return true
    }
  }
  const ext = getExtension(filename)
  return ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'iso', 'dmg'].includes(ext)
}

/**
 * Get an upper-case badge label for any file (e.g. "PNG", "TSX", "PDF", "ZIP", "PY").
 */
export function getFileTypeBadge(filename: string, mime?: string): string {
  const ext = getExtension(filename)
  if (ext) {
    return ext.toUpperCase().slice(0, 5)
  }
  const base = filename.split(/[/\\]/).pop() || ''
  if (base.startsWith('.')) return base.slice(1).toUpperCase().slice(0, 5)
  if (base.toLowerCase() === 'dockerfile') return 'DOCKER'
  if (base.toLowerCase() === 'makefile') return 'MAKE'
  if (mime) {
    const sub = mime.split('/')[1]
    if (sub) return sub.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 4)
  }
  return 'FILE'
}
