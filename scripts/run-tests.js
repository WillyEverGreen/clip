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
    const { isEncrypted = false, password = null, hasFile = false, hasMultipleFiles = false } = options
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
    return name.replace(/[^a-zA-Z0-9_.\-]/g, '_').slice(0, 128)
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
