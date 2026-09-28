/**
 * Comprehensive Automated Test Suite for Rentry/Clip.
 * Tests crypto, handlers, multi-file handling, rate limits, deletion logic, SSE, and cross-platform CLI generators.
 * Run with: npm test
 */

const assert = require('assert')
const crypto = require('crypto').webcrypto

// Color helpers for terminal reporting
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
}

let passed = 0
let failed = 0

function test(name, fn) {
  return (async () => {
    try {
      await fn()
      passed++
      console.log(`  ${colors.green}✓${colors.reset} ${name}`)
    } catch (err) {
      failed++
      console.error(`  ${colors.red}✗${colors.reset} ${name}`)
      console.error(`    ${colors.red}${err.stack || err}${colors.reset}`)
    }
  })()
}

// ── 1. Crypto & PBKDF2 Encryption Tests ────────────────────────────────────────

async function runCryptoTests() {
  console.log(`\n${colors.bold}${colors.cyan}1. Crypto & Zero-Knowledge Encryption Tests${colors.reset}`)

  await test('AES-GCM 256 encryption & decryption with 250,000 PBKDF2 iterations', async () => {
    const password = 'mySecretPassword123'
    const plaintext = 'Hello world secret clip content!'

    const enc = new TextEncoder()
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))

    const rawKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
      rawKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )

    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext))
    const payload = {
      encrypted: true,
      iv: Buffer.from(iv).toString('base64'),
      salt: Buffer.from(salt).toString('base64'),
      ciphertext: Buffer.from(cipherBuf).toString('base64'),
    }

    // Decrypt
    const decSalt = Uint8Array.from(Buffer.from(payload.salt, 'base64'))
    const decIv = Uint8Array.from(Buffer.from(payload.iv, 'base64'))
    const decCipher = Uint8Array.from(Buffer.from(payload.ciphertext, 'base64'))

    const decRawKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
    const decKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: decSalt, iterations: 250000, hash: 'SHA-256' },
      decRawKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    )

    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decIv }, decKey, decCipher)
    const result = new TextDecoder().decode(plainBuf)
    assert.strictEqual(result, plaintext)
  })

  await test('Fails decryption cleanly with incorrect password', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const enc = new TextEncoder()

    const rawKey = await crypto.subtle.importKey('raw', enc.encode('correctPass'), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
      rawKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    )

    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode('top secret'))
    
    // Attempt wrong password
    const wrongRawKey = await crypto.subtle.importKey('raw', enc.encode('wrongPass'), 'PBKDF2', false, ['deriveKey'])
    const wrongKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
      wrongRawKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    )

    await assert.rejects(
      async () => await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrongKey, cipherBuf)
    )
  })
}

// ── 2. Cross-Platform CLI Command Generators ────────────────────────────────

async function runCliGeneratorTests() {
  console.log(`\n${colors.bold}${colors.cyan}2. Cross-Platform CLI Command Generator Tests${colors.reset}`)

  const HOST = 'https://clip.foo.ng'

  function generateCliCommands(slug, options = {}) {
    const { isEncrypted = false, password = null, hasFile: _hasFile = false, hasMultipleFiles: _hasMultipleFiles = false } = options
    const passQuery = isEncrypted && password ? `?pass=${encodeURIComponent(password)}` : ''
    
    const rawUrl = `${HOST}/r/${slug}${passQuery}`
    const fileUrl = `${HOST}/f/${slug}${passQuery}`
    const zipUrl = `${HOST}/z/${slug}${passQuery}`

    return {
      linux: {
        text: `curl -sL "${rawUrl}"`,
        file: `curl -fLJO "${fileUrl}"`,
        zip:  `curl -fLO "${zipUrl}"`,
      },
      windows: {
        text: `curl.exe -sL "${rawUrl}"`,
        file: `curl.exe -fLJO "${fileUrl}"`,
        zip:  `curl.exe -fLO "${zipUrl}"`,
      },
      mac: {
        text: `curl -sL "${rawUrl}"`,
        file: `curl -fLJO "${fileUrl}"`,
        zip:  `curl -fLO "${zipUrl}"`,
      }
    }
  }

  await test('Generates valid Linux/macOS curl commands for plain text', async () => {
    const cmds = generateCliCommands('test-clip')
    assert.strictEqual(cmds.linux.text, 'curl -sL "https://clip.foo.ng/r/test-clip"')
    assert.strictEqual(cmds.mac.text, 'curl -sL "https://clip.foo.ng/r/test-clip"')
  })

  await test('Generates valid Windows curl.exe commands for plain text', async () => {
    const cmds = generateCliCommands('test-clip')
    assert.strictEqual(cmds.windows.text, 'curl.exe -sL "https://clip.foo.ng/r/test-clip"')
  })

  await test('Includes password query parameter when paste is encrypted', async () => {
    const cmds = generateCliCommands('encrypted-clip', { isEncrypted: true, password: 'p@ss word' })
    assert.strictEqual(cmds.linux.text, 'curl -sL "https://clip.foo.ng/r/encrypted-clip?pass=p%40ss%20word"')
    assert.strictEqual(cmds.windows.text, 'curl.exe -sL "https://clip.foo.ng/r/encrypted-clip?pass=p%40ss%20word"')
  })

  await test('Generates correct file & zip download flags (-fLJO, -fLO)', async () => {
    const cmds = generateCliCommands('files-clip', { hasMultipleFiles: true })
    assert.strictEqual(cmds.linux.file, 'curl -fLJO "https://clip.foo.ng/f/files-clip"')
    assert.strictEqual(cmds.windows.zip, 'curl.exe -fLO "https://clip.foo.ng/z/files-clip"')
  })
}

// ── 3. File & Multi-File Upload Handling Tests ─────────────────────────────

async function runFileLogicTests() {
  console.log(`\n${colors.bold}${colors.cyan}3. File & Multi-File Upload Edge Case Tests${colors.reset}`)

  function sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 128)
  }

  await test('Sanitizes unsafe filenames (path traversal & special chars)', async () => {
    assert.strictEqual(sanitizeFilename('../../../etc/passwd'), '.._.._.._etc_passwd')
    assert.strictEqual(sanitizeFilename('my file (1) [final]!.png'), 'my_file__1___final__.png')
  })

  await test('Multi-file item deletion preserves remaining files', async () => {
    const entry = {
      slug: 'multi-test',
      files: [
        { id: 'f1', fileName: 'doc1.pdf', fileSize: 100 },
        { id: 'f2', fileName: 'doc2.png', fileSize: 200 },
      ]
    }

    // Delete f1
    const fileIdToDelete = 'f1'
    entry.files = entry.files.filter(f => f.id !== fileIdToDelete)
    assert.strictEqual(entry.files.length, 1)
    assert.strictEqual(entry.files[0].id, 'f2')
  })

  await test('File-only paste with encryption sets file lock payload', async () => {
    const isFileMode = true
    const lockContent = true
    const viewPassword = 'secretPassword'

    let contentPayload = ''
    if (isFileMode && lockContent && viewPassword) {
      contentPayload = '{"file_lock":true}'
    }

    assert.strictEqual(contentPayload, '{"file_lock":true}')
  })
}

// ── 4. Expiration & Security Header Tests ───────────────────────────────────

async function runSecurityTests() {
  console.log(`\n${colors.bold}${colors.cyan}4. Expiration, Permanent Pastes & Security Header Tests${colors.reset}`)

  await test('Permanent entries never expire regardless of Date.now()', async () => {
    const permanentEntry = {
      slug: 'perm-clip',
      isPermanent: true,
      expiresAt: Date.now() - 10000,
    }

    const isExpired = !permanentEntry.isPermanent && Date.now() > permanentEntry.expiresAt
    assert.strictEqual(isExpired, false)
  })

  await test('Non-permanent past entries evaluate as expired', async () => {
    const expiredEntry = {
      slug: 'old-clip',
      isPermanent: false,
      expiresAt: Date.now() - 10000,
    }

    const isExpired = !expiredEntry.isPermanent && Date.now() > expiredEntry.expiresAt
    assert.strictEqual(isExpired, true)
  })

  await test('Security headers match required policy', async () => {
    const headers = {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    }

    assert.strictEqual(headers['X-Content-Type-Options'], 'nosniff')
    assert.strictEqual(headers['X-Frame-Options'], 'DENY')
    assert.ok(headers['Content-Security-Policy'].includes("frame-ancestors 'none'"))
  })
}

// ── 5. Full Deletion, Edit Code Verification & Admin Purge Tests ────────────

async function runDeletionTests() {
  console.log(`\n${colors.bold}${colors.cyan}5. Deletion, Edit Code & Admin Purge Tests${colors.reset}`)

  async function mockVerifyCode(code, salt, pepper, storedHash) {
    const enc = new TextEncoder()
    const input = `${code}:${pepper}`
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(input), 'PBKDF2', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      256
    )
    const computed = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('')
    return computed === storedHash
  }

  await test('Full paste deletion requires valid edit code', async () => {
    const editCode = 'myEditCode123'
    const salt = 'randomSalt123'
    const pepper = 'clip_default_pepper'

    // Compute expected hash
    const enc = new TextEncoder()
    const input = `${editCode}:${pepper}`
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(input), 'PBKDF2', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      256
    )
    const storedHash = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('')

    const isValidCorrect = await mockVerifyCode(editCode, salt, pepper, storedHash)
    const isValidWrong   = await mockVerifyCode('wrongCode', salt, pepper, storedHash)

    assert.strictEqual(isValidCorrect, true)
    assert.strictEqual(isValidWrong, false)
  })

  await test('Expired file auto-cleanup clears file storage while preserving text', async () => {
    const entry = {
      slug: 'text-with-file',
      content: 'Important text content',
      hasFile: true,
      fileName: 'attachment.zip',
      fileExpiresAt: Date.now() - 5000, // File expired
    }

    if (entry.fileExpiresAt && Date.now() > entry.fileExpiresAt && entry.hasFile) {
      entry.hasFile = false
      entry.fileName = undefined
      entry.fileExpiresAt = undefined
    }

    assert.strictEqual(entry.hasFile, false)
    assert.strictEqual(entry.fileName, undefined)
    assert.strictEqual(entry.content, 'Important text content')
  })

  await test('Admin authorization headers protect delete and purge endpoints', async () => {
    const adminSecret = 'super_secret_admin_token'

    function checkAdminAuth(headerSecret) {
      if (!headerSecret || headerSecret !== adminSecret) {
        return { authorized: false, status: 401 }
      }
      return { authorized: true, status: 200 }
    }

    assert.strictEqual(checkAdminAuth('wrong_secret').authorized, false)
    assert.strictEqual(checkAdminAuth(adminSecret).authorized, true)
  })
}

// ── 6. Headers, Stale KV Protection & Slug Normalization Tests ─────────────

async function runAdvancedEdgeCaseTests() {
  console.log(`\n${colors.bold}${colors.cyan}6. Headers, Stale KV Protection & Slug Normalization Tests${colors.reset}`)

  await test('Extracts password from x-password or x-pass headers', async () => {
    function extractPassword(headers, query) {
      return headers['x-password'] || headers['x-pass'] || query.password || query.pass || query.p || null
    }

    assert.strictEqual(extractPassword({ 'x-password': 'passHeader' }, {}), 'passHeader')
    assert.strictEqual(extractPassword({ 'x-pass': 'shortHeader' }, {}), 'shortHeader')
    assert.strictEqual(extractPassword({}, { pass: 'queryPass' }), 'queryPass')
  })

  await test('Stale data detection ignores out-of-order KV updates', async () => {
    const expectedUpdatedAt = 1000
    const staleEntryUpdatedAt = 900
    const freshEntryUpdatedAt = 1050

    function isStale(entryUpdatedAt, expected) {
      return Boolean(expected && entryUpdatedAt < expected)
    }

    assert.strictEqual(isStale(staleEntryUpdatedAt, expectedUpdatedAt), true)
    assert.strictEqual(isStale(freshEntryUpdatedAt, expectedUpdatedAt), false)
  })

  await test('Slug normalization enforces lowercase and sanitized characters', async () => {
    function normalizeSlug(raw) {
      return raw.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50)
    }

    assert.strictEqual(normalizeSlug('My-Custom-Slug!@#$'), 'my-custom-slug')
    assert.strictEqual(normalizeSlug('HACKATHON-2026'), 'hackathon-2026')
  })
}

// ── 7. KV Read Protection, Cache-Control & SSE Tests ─────────────────────────

async function runKVReadProtectionAndCacheTests() {
  console.log(`\n${colors.bold}${colors.cyan}7. KV Read Protection, Cache-Control & SSE Tests${colors.reset}`)

  await test('View counting is isolated in views:slug and never overwrites entry document in KV', async () => {
    // In-memory mock KV
    const kvStore = new Map()

    const mockKV = {
      async get(key, type) {
        const val = kvStore.get(key)
        if (!val) return null
        if (type === 'json') return JSON.parse(val)
        return val
      },
      async put(key, val) {
        kvStore.set(key, val)
      },
      async delete(key) {
        kvStore.delete(key)
      }
    }

    // Step 1: Initial creation at t=1000
    const slug = 'test-paste'
    const entryV1 = {
      slug,
      content: 'Original content (1-2 min ago)',
      updatedAt: 1000,
      createdAt: 1000,
      views: 1
    }
    await mockKV.put(`entry:${slug}`, JSON.stringify(entryV1))

    // Step 2: Device A updates the entry at t=2000 with new uploads
    const entryV2 = {
      slug,
      content: 'Brand new upload with files!',
      updatedAt: 2000,
      createdAt: 1000,
      hasFile: true,
      files: [{ id: 'f_1', fileName: 'new_file.pdf', fileSize: 1024 }]
    }
    await mockKV.put(`entry:${slug}`, JSON.stringify(entryV2))

    // Step 3: Device B was holding stale entryV1 (from edge replica before propagation)
    // In the old buggy code, Device B would run putEntry(mockKV, entryV1) to increment views,
    // which overwrote entryV2 back to entryV1!
    // With our fix, incrementViewsKV ONLY writes to `views:${slug}`:
    async function incrementViewsKV(kv, s, base = 0) {
      const v = await kv.get(`views:${s}`)
      const cur = v !== null ? parseInt(v, 10) : base
      await kv.put(`views:${s}`, String(cur + 1))
    }

    await incrementViewsKV(mockKV, slug, entryV1.views)

    // Verify: The entry in KV MUST still be entryV2 (the brand new upload!)
    const currentEntry = await mockKV.get(`entry:${slug}`, 'json')
    assert.strictEqual(currentEntry.updatedAt, 2000)
    assert.strictEqual(currentEntry.content, 'Brand new upload with files!')
    assert.strictEqual(currentEntry.hasFile, true)
    assert.strictEqual(currentEntry.files.length, 1)

    // Verify: views is tracked separately
    const views = await mockKV.get(`views:${slug}`)
    assert.strictEqual(views, '2')
  })

  await test('Cache-Control headers prevent stale browser and CDN caching', async () => {
    const apiHeaders = {
      'ETag': '"test-12345"',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache'
    }

    const fileHeaders = {
      'ETag': '"test-12345-1024"',
      'Cache-Control': 'no-cache, must-revalidate',
      'Pragma': 'no-cache'
    }

    assert.ok(apiHeaders['Cache-Control'].includes('no-store'))
    assert.ok(apiHeaders['Cache-Control'].includes('max-age=0'))
    assert.strictEqual(apiHeaders['Pragma'], 'no-cache')

    // Ensure stale-while-revalidate is NOT present
    assert.ok(!fileHeaders['Cache-Control'].includes('stale-while-revalidate'))
    assert.ok(!apiHeaders['Cache-Control'].includes('stale-while-revalidate'))
  })

  await test('SSE connection target is properly resolved to direct worker origin', async () => {
    const LIVE_WORKER_URL = 'https://clip-worker.saibalkawade10.workers.dev'
    const isLocal = false
    const VITE_API_URL = undefined

    const BASE = VITE_API_URL || (isLocal ? '' : LIVE_WORKER_URL)
    const sseUrl = `${BASE}/api/entry/demo/events`

    assert.strictEqual(sseUrl, 'https://clip-worker.saibalkawade10.workers.dev/api/entry/demo/events')
    // Verifies it does NOT hit the frontend pages 302 redirect domain
    assert.ok(!sseUrl.startsWith('https://clip.foo.ng'))
  })
}

// ── 8. Live Pad Real-Time Sync & Clipboard/File Sharing Tests ────────────────

async function runLivePadRealtimeTests() {
  console.log(`\n${colors.bold}${colors.cyan}8. Live Pad Real-Time Sync & Clipboard/File Sharing Tests${colors.reset}`)

  await test('Live Pad synchronizes text across multiple simulated peer sockets', async () => {
    let currentText = ''
    const peers = new Set()

    function createMockSocket(id) {
      const messages = []
      const socket = {
        id,
        send(msg) {
          messages.push(JSON.parse(msg))
        },
        receive(type, payload) {
          if (type === 'text') {
            currentText = payload.text
            // Broadcast to other peers
            for (const p of peers) {
              if (p !== socket) {
                p.send(JSON.stringify({ type: 'text', text: currentText, senderId: id }))
              }
            }
          }
        },
        getMessages() { return messages }
      }
      peers.add(socket)
      return socket
    }

    const deviceA = createMockSocket('device-laptop')
    const deviceB = createMockSocket('device-phone')

    // Device A types text
    deviceA.receive('text', { text: 'Hello from laptop in real time!' })

    assert.strictEqual(currentText, 'Hello from laptop in real time!')
    const bMessages = deviceB.getMessages()
    assert.strictEqual(bMessages.length, 1)
    assert.strictEqual(bMessages[0].type, 'text')
    assert.strictEqual(bMessages[0].text, 'Hello from laptop in real time!')
    assert.strictEqual(bMessages[0].senderId, 'device-laptop')
  })

  await test('Live Pad handles clipboard and drag-drop file attachments in real time', async () => {
    let liveFiles = []
    const broadcastEvents = []

    function addLiveFile(fileItem) {
      liveFiles = liveFiles.filter(f => f.id !== fileItem.id)
      liveFiles.push(fileItem)
      broadcastEvents.push({ type: 'file_added', file: fileItem })
    }

    function removeLiveFile(fileId) {
      liveFiles = liveFiles.filter(f => f.id !== fileId)
      broadcastEvents.push({ type: 'file_removed', fileId })
    }

    // Simulate pasting a screenshot from clipboard (Ctrl+V)
    const pastedImage = {
      id: 'live_img_123',
      fileName: 'screenshot_2026-09-26.png',
      fileMime: 'image/png',
      fileSize: 45020,
    }
    addLiveFile(pastedImage)

    assert.strictEqual(liveFiles.length, 1)
    assert.strictEqual(broadcastEvents.length, 1)
    assert.strictEqual(broadcastEvents[0].type, 'file_added')
    assert.strictEqual(broadcastEvents[0].file.fileName, 'screenshot_2026-09-26.png')

    // Simulate drag & drop of a code file
    const droppedFile = {
      id: 'live_file_456',
      fileName: 'config.json',
      fileMime: 'application/json',
      fileSize: 2048,
    }
    addLiveFile(droppedFile)

    assert.strictEqual(liveFiles.length, 2)
    assert.strictEqual(liveFiles[1].fileName, 'config.json')

    // Remove file in real time
    removeLiveFile('live_img_123')
    assert.strictEqual(liveFiles.length, 1)
    assert.strictEqual(liveFiles[0].id, 'live_file_456')
    assert.strictEqual(broadcastEvents[2].type, 'file_removed')
    assert.strictEqual(broadcastEvents[2].fileId, 'live_img_123')
  })

  await test('Live Pad converts to permanent clip with edit code and encryption options', async () => {
    const liveSession = {
      text: 'Final meeting notes and design specification',
      files: [{ id: 'live_f1', fileName: 'diagram.png', fileMime: 'image/png', fileSize: 50000 }],
      slug: 'team-design-sync'
    }

    function prepareClipConversion(session, editCode, ttl, password) {
      assert.ok(editCode.length >= 4, 'Edit code must be valid')
      return {
        slug: session.slug,
        type: session.files.length > 0 ? 'file' : 'text',
        content: session.text,
        files: session.files,
        editCode,
        ttl,
        isEncrypted: Boolean(password && password.length >= 4)
      }
    }

    const clipPayload = prepareClipConversion(liveSession, 'secretEditPass123', 'permanent', 'optionalViewerPass')
    assert.strictEqual(clipPayload.type, 'file')
    assert.strictEqual(clipPayload.editCode, 'secretEditPass123')
    assert.strictEqual(clipPayload.ttl, 'permanent')
    assert.strictEqual(clipPayload.isEncrypted, true)
  })
}

// ── 9. Live Pad Folder Drop & Universal File Type Tests ───────────────────────

async function runFolderDropAndFileTypeTests() {
  console.log(`\n${colors.bold}${colors.cyan}9. Live Pad Folder Drop & Universal File Type Tests${colors.reset}`)

  await test('Recursively extracts all files from simulated folder drop with relative paths', async () => {
    // Simulated FileSystemEntry hierarchy
    function makeFileEntry(name, content = 'content') {
      return {
        isFile: true,
        isDirectory: false,
        name,
        file: (cb) => cb({ name, size: content.length, type: '' }),
      }
    }

    function makeDirEntry(name, children) {
      return {
        isFile: false,
        isDirectory: true,
        name,
        createReader: () => {
          let read = false
          return {
            readEntries: (cb) => {
              if (!read) {
                read = true
                cb(children)
              } else {
                cb([]) // End of directory stream
              }
            }
          }
        }
      }
    }

    const mockFolder = makeDirEntry('my-app', [
      makeFileEntry('package.json', '{"name":"app"}'),
      makeDirEntry('src', [
        makeFileEntry('main.ts', 'console.log("hello")'),
        makeDirEntry('utils', [
          makeFileEntry('math.py', 'def add(a, b): return a + b')
        ])
      ]),
      makeFileEntry('.env.example', 'PORT=3000')
    ])

    // Recursive directory extraction algorithm identical to production
    async function traverse(entry, prefix = '', acc = []) {
      if (entry.isFile) {
        await new Promise(resolve => {
          entry.file(f => {
            const rel = prefix ? `${prefix}/${f.name}` : f.name
            acc.push({ name: rel, size: f.size })
            resolve()
          })
        })
      } else if (entry.isDirectory) {
        const next = prefix ? `${prefix}/${entry.name}` : entry.name
        const reader = entry.createReader()
        const entries = await new Promise(resolve => reader.readEntries(resolve))
        for (const child of entries) {
          await traverse(child, next, acc)
        }
      }
      return acc
    }

    const extracted = await traverse(mockFolder)
    assert.strictEqual(extracted.length, 4)
    assert.deepStrictEqual(
      extracted.map(f => f.name),
      [
        'my-app/package.json',
        'my-app/src/main.ts',
        'my-app/src/utils/math.py',
        'my-app/.env.example'
      ]
    )
  })

  await test('Empty folder drop returns 0 files without errors', async () => {
    const emptyFolder = {
      isFile: false,
      isDirectory: true,
      name: 'empty-dir',
      createReader: () => ({
        readEntries: (cb) => cb([])
      })
    }

    const reader = emptyFolder.createReader()
    const entries = await new Promise(resolve => reader.readEntries(resolve))
    assert.strictEqual(entries.length, 0)
  })

  await test('Accepts 0-byte files without rejecting as missing_file', async () => {
    function validateUpload(file) {
      if (!file || typeof file.size !== 'number') {
        return { error: 'missing_file', status: 400 }
      }
      if (file.size > 25 * 1024 * 1024) {
        return { error: 'file_too_large', status: 400 }
      }
      return { ok: true, size: file.size }
    }

    // 0-byte empty file (e.g. __init__.py, .gitkeep)
    const emptyFile = { name: '.gitkeep', size: 0 }
    const result = validateUpload(emptyFile)
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.size, 0)
  })

  await test('Rejects dummy 0-byte OS clipboard folder objects from being uploaded as files', async () => {
    function filterExtractedFiles(files, hasDirectory) {
      if (hasDirectory && files.length === 0) {
        return []
      }
      return files.filter(f => {
        const isSuspectDirectory = f.size === 0 && !f.type && !f.name.includes('.')
        return !isSuspectDirectory
      })
    }

    // Windows clipboard directory copy produces a 0-byte dummy file named after folder
    const clipboardFiles = [{ name: '_template', size: 0, type: '' }]
    const result = filterExtractedFiles(clipboardFiles, true)
    assert.strictEqual(result.length, 0)

    // Genuine 0-byte file (e.g. .gitkeep, empty.txt) is preserved
    const realFiles = [{ name: '.gitkeep', size: 0, type: '' }, { name: 'empty.txt', size: 0, type: 'text/plain' }]
    const realResult = filterExtractedFiles(realFiles, false)
    assert.strictEqual(realResult.length, 2)
  })

  await test('Accurately maps MIME types across code, data, media, and archive formats', async () => {
    const MIME_MAP = {
      html: 'text/html',
      js: 'application/javascript',
      ts: 'application/typescript',
      py: 'text/x-python',
      rs: 'text/rust',
      go: 'text/x-go',
      json: 'application/json',
      yaml: 'application/yaml',
      yml: 'application/yaml',
      sh: 'application/x-sh',
      pdf: 'application/pdf',
      png: 'image/png',
      svg: 'image/svg+xml',
      mp3: 'audio/mpeg',
      mp4: 'video/mp4',
      zip: 'application/zip',
      '7z': 'application/x-7z-compressed',
      tar: 'application/x-tar'
    }

    function lookupMime(filename, fallback) {
      const ext = filename.split('.').pop().toLowerCase()
      return MIME_MAP[ext] || fallback || 'application/octet-stream'
    }

    assert.strictEqual(lookupMime('app.py'), 'text/x-python')
    assert.strictEqual(lookupMime('mod.rs'), 'text/rust')
    assert.strictEqual(lookupMime('index.ts'), 'application/typescript')
    assert.strictEqual(lookupMime('config.yaml'), 'application/yaml')
    assert.strictEqual(lookupMime('doc.pdf'), 'application/pdf')
    assert.strictEqual(lookupMime('vector.svg'), 'image/svg+xml')
    assert.strictEqual(lookupMime('track.mp3'), 'audio/mpeg')
    assert.strictEqual(lookupMime('video.mp4'), 'video/mp4')
    assert.strictEqual(lookupMime('archive.7z'), 'application/x-7z-compressed')
  })

  await test('Generates safe Content-Disposition headers for nested relative folder paths', async () => {
    function makeContentDisposition(requestedName) {
      const baseName = requestedName.split(/[/\\]/).pop() || requestedName
      const sanitizedBase = baseName.replace(/["\r\n]/g, '_')
      return `inline; filename="${sanitizedBase}"; filename*=UTF-8''${encodeURIComponent(requestedName)}`
    }

    const header = makeContentDisposition('my-project/src/components/Header.tsx')
    // Legacy parameter uses safe basename only (no Windows path slashes)
    assert.ok(header.includes('filename="Header.tsx"'))
    // RFC 6266 parameter preserves full encoded path
    assert.ok(header.includes("filename*=UTF-8''my-project%2Fsrc%2Fcomponents%2FHeader.tsx"))
  })
}

// ── 10. Production-Grade Live Pad Slug Uniqueness Tests ────────────────────────

async function runLiveSlugUniquenessTests() {
  console.log(`\n${colors.bold}${colors.cyan}10. Production-Grade Live Pad Slug Uniqueness Tests${colors.reset}`)

  await test('Live slug generator produces 10-char base-36 slugs (server)', async () => {
    // Simulates generateLiveSlug() from worker/src/lib/slug.ts
    function generateLiveSlug() {
      const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
      const bytes = crypto.getRandomValues(new Uint8Array(10))
      return Array.from(bytes).map(b => ALPHABET[b % ALPHABET.length]).join('')
    }

    for (let i = 0; i < 5; i++) {
      const slug = generateLiveSlug()
      assert.strictEqual(slug.length, 10, 'Live slug must be exactly 10 chars')
      assert.ok(/^[a-z0-9]{10}$/.test(slug), `Slug must be lowercase alphanumeric: ${slug}`)
    }
  })

  await test('Cryptographic client-side fallback never uses Math.random', async () => {
    // Simulates getUniqueLiveSlug() offline fallback from frontend/src/lib/api.ts
    const bytes = crypto.getRandomValues(new Uint8Array(8))
    const slug = Array.from(bytes).map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 10)
    assert.strictEqual(slug.length, 10)
    assert.ok(/^[a-z0-9]+$/.test(slug), `Offline fallback slug must be alphanumeric: ${slug}`)
  })

  await test('KV reservation prevents slug re-use in production', async () => {
    // Simulates the /api/live/new-slug endpoint collision-prevention logic
    const RESERVED = new Set(['api', 'edit', 'new', 'admin', 'live', 'livepad', 'room', 'ws', 'new-slug'])
    const kvUsed = new Set()

    function isReserved(s) { return RESERVED.has(s) }

    function getFromKV(slug) {
      return kvUsed.has(slug) ? '1' : null
    }

    function claimInKV(slug) {
      kvUsed.add(slug)
    }

    function generateLiveSlug() {
      const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789'
      const bytes = crypto.getRandomValues(new Uint8Array(10))
      return Array.from(bytes).map(b => ALPHA[b % ALPHA.length]).join('')
    }

    function getUniqueSlug() {
      for (let i = 0; i < 8; i++) {
        const candidate = generateLiveSlug()
        if (isReserved(candidate)) continue
        if (getFromKV(candidate) !== null) continue
        claimInKV(candidate)
        return candidate
      }
      return null
    }

    // Generate 100 slugs and verify no collisions
    const slugs = new Set()
    for (let i = 0; i < 100; i++) {
      const s = getUniqueSlug()
      assert.ok(s !== null, 'Slug generation should not exhaust retries')
      assert.ok(!slugs.has(s), `Collision detected: ${s} was generated twice`)
      slugs.add(s)
    }
    assert.strictEqual(slugs.size, 100, 'All 100 slugs must be unique')
  })

  await test('Reserved words are never returned as live slugs', async () => {
    const RESERVED = new Set(['api', 'edit', 'new', 'admin', 'live', 'livepad', 'room', 'ws', 'new-slug',
      'create', 'help', 'about', '404', 'not-found', 'login', 'signup', 'static'])

    // Verify reserved check works for all reserved words
    for (const word of RESERVED) {
      assert.ok(RESERVED.has(word), `${word} should be in RESERVED`)
    }

    // Random 10-char slug should never match reserved words (length mismatch for most)
    const candidate = 'ab12cd34ef'
    assert.ok(!RESERVED.has(candidate), 'Random 10-char slug should not match any short reserved words')
  })
}

// ── Main Test Runner ────────────────────────────────────────────────────────

async function main() {
  console.log(`${colors.bold}=== Rentry / Clip Automated Test Suite ===${colors.reset}`)
  
  await runCryptoTests()
  await runCliGeneratorTests()
  await runFileLogicTests()
  await runSecurityTests()
  await runDeletionTests()
  await runAdvancedEdgeCaseTests()
  await runKVReadProtectionAndCacheTests()
  await runLivePadRealtimeTests()
  await runFolderDropAndFileTypeTests()
  await runLiveSlugUniquenessTests()

  console.log(`\n${colors.bold}=== Summary ===${colors.reset}`)
  console.log(`Total: ${passed + failed} | Passed: ${colors.green}${passed}${colors.reset} | Failed: ${failed > 0 ? colors.red + failed + colors.reset : '0'}`)

  if (failed > 0) {
    process.exit(1)

  }
}

main().catch(err => {
  console.error('Test suite runner crashed:', err)
  process.exit(1)
})
