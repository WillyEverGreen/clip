/**
 * Unit and integration tests for Worker Analytics API & Exclusion Engine
 * Run with: node scripts/test-analytics-api.mjs
 */
import { register } from 'node:module'
// Mock cloudflare:workers and resolve extensionless .ts imports for Node.js test environment
register(`data:text/javascript,
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return {
      url: "data:text/javascript,export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}",
      shortCircuit: true
    };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !specifier.endsWith(".ts") && !specifier.endsWith(".js") && !specifier.endsWith(".mjs")) {
      try {
        return await nextResolve(specifier + ".ts", context);
      } catch {}
    }
    throw err;
  }
}
`)

import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

// Dynamic import of AnalyticsStore
const { AnalyticsStore } = await import('../worker/src/durable/AnalyticsStore.ts')

// Dynamic import of analytics handlers and helpers (will fail before implementation)
const {
  sanitizePath,
  parseDevice,
  getVisitorHash,
  getExcludedIps,
  handleAnalyticsEvent,
  handleAdminAnalytics,
  handleAdminExcludedIps,
  handleAdminDetectedIp,
} = await import('../worker/src/handlers/analytics.ts')

// Dynamic import of main worker
const workerModule = await import('../worker/src/index.ts')
const worker = workerModule.default

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } catch (err) {
    failed++
    console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.stack || err}`)
  }
}

/**
 * Creates a mock Cloudflare DurableObjectState with SQLite storage backed by node:sqlite DatabaseSync
 */
function createMockState(db = new DatabaseSync(':memory:')) {
  const sql = {
    exec(query, ...params) {
      const q = query.trim()
      if (params.length === 0 && (q.toUpperCase().startsWith('CREATE') || q.includes(';'))) {
        db.exec(query)
        return {
          toArray() { return [] },
          [Symbol.iterator]() { return [][Symbol.iterator]() },
          rowsWritten: 0,
          rowsRead: 0,
        }
      }
      const stmt = db.prepare(query)
      if (q.toUpperCase().startsWith('SELECT') || q.toUpperCase().startsWith('WITH') || q.toUpperCase().startsWith('PRAGMA')) {
        const rows = stmt.all(...params)
        return {
          toArray() { return rows },
          [Symbol.iterator]() { return rows[Symbol.iterator]() },
          rowsWritten: 0,
          rowsRead: rows.length,
        }
      } else {
        const res = stmt.run(...params)
        return {
          toArray() { return [] },
          [Symbol.iterator]() { return [][Symbol.iterator]() },
          rowsWritten: Number(res.changes),
          rowsRead: 0,
        }
      }
    }
  }

  return {
    ctx: {
      storage: { sql },
      blockConcurrencyWhile: async (fn) => fn(),
    },
    env: {},
    db,
  }
}

function createMockKV(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    async get(key, type = 'text') {
      const val = map.get(key)
      if (val === undefined || val === null) return null
      if (type === 'json') return JSON.parse(val)
      return val
    },
    async put(key, value) {
      map.set(key, typeof value === 'string' ? value : JSON.stringify(value))
    },
    async delete(key) {
      map.delete(key)
    },
    _map: map,
  }
}

function createMockEnv(overrides = {}) {
  const { ctx, env, db } = createMockState()
  const store = new AnalyticsStore(ctx, env)
  const kv = createMockKV(overrides.kvInitial || {})

  const analyticsDoNamespace = {
    idFromName(name) { return { name } },
    get(id) { return store }
  }

  return {
    env: {
      PASTE_KV: kv,
      ANALYTICS_DO: analyticsDoNamespace,
      ADMIN_SECRET: 'test-admin-secret-123',
      APP_PEPPER: 'test-pepper-salt',
      FRONTEND_ORIGIN: 'http://localhost:5173',
      ...overrides.env,
    },
    store,
    kv,
    db,
  }
}

console.log('\n--- Unit Tests: Helpers ---')

await test('sanitizePath correctly sanitizes public and private slugs', () => {
  assert.equal(sanitizePath(''), '/')
  assert.equal(sanitizePath('/'), '/')
  assert.equal(sanitizePath('/about'), '/about')
  assert.equal(sanitizePath('/beam'), '/beam')
  assert.equal(sanitizePath('/live'), '/live')
  assert.equal(sanitizePath('/live/room-123'), '/live/:slug')
  assert.equal(sanitizePath('/b/pin-456'), '/b/:slug')
  assert.equal(sanitizePath('/admin'), '/admin')
  assert.equal(sanitizePath('/admin/settings'), '/admin')
  assert.equal(sanitizePath('/f4a5dd3'), '/:slug')
  assert.equal(sanitizePath('/f4a5dd3/edit'), '/:slug/edit')
  assert.equal(sanitizePath('/f4a5dd3?param=secret'), '/:slug')
  assert.equal(sanitizePath('/a/b/c/d'), '/other')
})

await test('parseDevice classifies desktop, tablet, and mobile', () => {
  assert.equal(parseDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'desktop')
  assert.equal(parseDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'desktop')
  assert.equal(parseDevice('Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X)'), 'tablet')
  assert.equal(parseDevice('Mozilla/5.0 (Linux; Android 10; SM-T510) AppleWebKit/537.36'), 'tablet')
  assert.equal(parseDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)'), 'mobile')
  assert.equal(parseDevice('Mozilla/5.0 (Linux; Android 11; Pixel 5 Mobile)'), 'mobile')
  assert.equal(parseDevice(''), 'desktop')
})

await test('getVisitorHash produces 64-char hex hash using monthly salt', async () => {
  const hash1 = await getVisitorHash('192.168.1.1', 'pepper', new Date('2026-11-01T12:00:00Z'))
  const hash2 = await getVisitorHash('192.168.1.1', 'pepper', new Date('2026-11-15T12:00:00Z'))
  const hashOtherMonth = await getVisitorHash('192.168.1.1', 'pepper', new Date('2026-12-01T12:00:00Z'))

  assert.equal(hash1.length, 64)
  assert.equal(hash1, hash2, 'Same month and IP should produce same hash')
  assert.notEqual(hash1, hashOtherMonth, 'Different month should rotate hash')
})

console.log('\n--- Integration Tests: Endpoints & Exclusion Engine ---')

await test('1. POST /api/analytics/event records a view and returns 204 No Content', async () => {
  const { env, store } = createMockEnv()

  const req = new Request('https://clip.test/api/analytics/event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.10',
      'CF-IPCountry': 'CA',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)',
    },
    body: JSON.stringify({ path: '/about', referrer: 'https://news.ycombinator.com/item?id=1' }),
  })

  const res = await worker.fetch(req, env)
  assert.equal(res.status, 204)

  const stats = await store.getStats('today')
  assert.equal(stats.totalViews, 1)
  assert.equal(stats.uniqueVisitors, 1)
  assert.equal(stats.topPaths[0]?.path, '/about')
  assert.equal(stats.topCountries[0]?.country, 'CA')
  assert.equal(stats.devices[0]?.device, 'mobile')
  assert.ok(stats.topReferrers[0]?.referrer.includes('news.ycombinator.com'))
})

await test('2. If IP is in analytics:excluded_ips in KV, POST /api/analytics/event returns 204 without recording', async () => {
  const { env, store } = createMockEnv({
    kvInitial: {
      'analytics:excluded_ips': JSON.stringify(['198.51.100.22', '10.0.0.5']),
    },
  })

  const req = new Request('https://clip.test/api/analytics/event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '198.51.100.22',
      'CF-IPCountry': 'US',
    },
    body: JSON.stringify({ path: '/about' }),
  })

  const res = await worker.fetch(req, env)
  assert.equal(res.status, 204)

  const stats = await store.getStats('today')
  assert.equal(stats.totalViews, 0, 'Excluded IP event must not be recorded')
})

await test('3. If request contains Authorization: Bearer <ADMIN_SECRET>, it is dropped without recording', async () => {
  const { env, store } = createMockEnv()

  const req = new Request('https://clip.test/api/analytics/event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-admin-secret-123',
      'CF-Connecting-IP': '203.0.113.50',
    },
    body: JSON.stringify({ path: '/about' }),
  })

  const res = await worker.fetch(req, env)
  assert.equal(res.status, 204)

  const stats = await store.getStats('today')
  assert.equal(stats.totalViews, 0, 'Admin request must not be recorded')
})

await test('3b. If path is /admin or starts with /admin, it returns 204 without recording', async () => {
  const { env, store } = createMockEnv()

  const req = new Request('https://clip.test/api/analytics/event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.60',
    },
    body: JSON.stringify({ path: '/admin/entries' }),
  })

  const res = await worker.fetch(req, env)
  assert.equal(res.status, 204)

  const stats = await store.getStats('today')
  assert.equal(stats.totalViews, 0, 'Path starting with /admin must not be recorded')
})

await test('4. Slug paths like /f4a5dd3 are masked to /:slug', async () => {
  const { env, store } = createMockEnv()

  const req = new Request('https://clip.test/api/analytics/event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.70',
    },
    body: JSON.stringify({ path: '/f4a5dd3' }),
  })

  const res = await worker.fetch(req, env)
  assert.equal(res.status, 204)

  const stats = await store.getStats('today')
  assert.equal(stats.totalViews, 1)
  assert.equal(stats.topPaths[0]?.path, '/:slug', 'Slug path must be masked to /:slug')
})

await test('5. GET /api/admin/analytics requires admin secret and returns aggregate stats', async () => {
  const { env, store } = createMockEnv()

  // Seed 1 view in store
  await store.recordEvent({ path: '/beam', country: 'US', device: 'desktop' })

  // 1. Without secret -> 401
  const unauthReq = new Request('https://clip.test/api/admin/analytics', { method: 'GET' })
  const unauthRes = await worker.fetch(unauthReq, env)
  assert.equal(unauthRes.status, 401)

  // 2. With valid Bearer secret -> 200 with stats
  const authReq = new Request('https://clip.test/api/admin/analytics?range=today', {
    method: 'GET',
    headers: { Authorization: 'Bearer test-admin-secret-123' },
  })
  const authRes = await worker.fetch(authReq, env)
  assert.equal(authRes.status, 200)
  const json = await authRes.json()
  assert.equal(json.totalViews, 1)
  assert.equal(json.topPaths[0]?.path, '/beam')
})

await test('6. POST & GET /api/admin/analytics/excluded-ips manages excluded IPs list in KV', async () => {
  const { env } = createMockEnv()

  // 1. Unauthenticated -> 401
  const unauthReq = new Request('https://clip.test/api/admin/analytics/excluded-ips', { method: 'GET' })
  assert.equal((await worker.fetch(unauthReq, env)).status, 401)

  // 2. GET initial list -> empty
  const getReq1 = new Request('https://clip.test/api/admin/analytics/excluded-ips', {
    method: 'GET',
    headers: { Authorization: 'Bearer test-admin-secret-123' },
  })
  const getRes1 = await worker.fetch(getReq1, env)
  assert.equal(getRes1.status, 200)
  assert.deepEqual(await getRes1.json(), { excludedIps: [] })

  // 3. Add IP
  const addReq = new Request('https://clip.test/api/admin/analytics/excluded-ips', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-admin-secret-123',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'add', ip: '192.168.1.50' }),
  })
  const addRes = await worker.fetch(addReq, env)
  assert.equal(addRes.status, 200)
  assert.deepEqual(await addRes.json(), { success: true, excludedIps: ['192.168.1.50'] })

  // 4. Add another IP
  const addReq2 = new Request('https://clip.test/api/admin/analytics/excluded-ips', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-admin-secret-123',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'add', ip: '10.0.0.99' }),
  })
  const addRes2 = await worker.fetch(addReq2, env)
  assert.equal(addRes2.status, 200)
  assert.deepEqual(await addRes2.json(), { success: true, excludedIps: ['192.168.1.50', '10.0.0.99'] })

  // 5. Remove first IP
  const removeReq = new Request('https://clip.test/api/admin/analytics/excluded-ips', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-admin-secret-123',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'remove', ip: '192.168.1.50' }),
  })
  const removeRes = await worker.fetch(removeReq, env)
  assert.equal(removeRes.status, 200)
  assert.deepEqual(await removeRes.json(), { success: true, excludedIps: ['10.0.0.99'] })
})

await test('7. GET /api/admin/analytics/detected-ip returns client IP', async () => {
  const { env } = createMockEnv()

  // 1. Unauthenticated -> 401
  const unauthReq = new Request('https://clip.test/api/admin/analytics/detected-ip', { method: 'GET' })
  assert.equal((await worker.fetch(unauthReq, env)).status, 401)

  // 2. Authenticated -> returns IP
  const authReq = new Request('https://clip.test/api/admin/analytics/detected-ip', {
    method: 'GET',
    headers: {
      Authorization: 'Bearer test-admin-secret-123',
      'CF-Connecting-IP': '203.0.113.195',
    },
  })
  const res = await worker.fetch(authReq, env)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ip: '203.0.113.195' })
})

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exit(1)
}
