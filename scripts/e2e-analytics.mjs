/**
 * End-to-End Analytics Pipeline Test Suite
 *
 * Simulates the full analytics lifecycle across the entire system:
 * Stage 1: Public visitor beacon -> verified in DO SQLite store.
 * Stage 2: Second visit from same IP on same date -> totalViews increments, uniqueVisitors deduplicates.
 * Stage 3: Private paste slug visit -> path dynamically masked to '/:slug'.
 * Stage 4: Admin excluded IP -> subsequent beacon from excluded IP dropped without incrementing.
 * Stage 5: Admin Bearer auth & client opt-out switch -> events dropped without incrementing.
 * Stage 6: Admin analytics query -> verifies aggregate data structure & breakdown fields.
 *
 * Run with: node scripts/e2e-analytics.mjs
 */

import { register } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

// Mock browser globals for client analytics testing
const mockStorage = new Map()
globalThis.window = globalThis
globalThis.localStorage = {
  getItem: (k) => (mockStorage.has(k) ? mockStorage.get(k) : null),
  setItem: (k, v) => mockStorage.set(k, String(v)),
  removeItem: (k) => mockStorage.delete(k),
  clear: () => mockStorage.clear(),
}
globalThis.document = { referrer: 'https://news.ycombinator.com/item?id=123' }

let clientBeaconCalls = []
let clientFetchCalls = []
Object.defineProperty(globalThis, 'navigator', {
  value: {
    sendBeacon: (url, blob) => {
      clientBeaconCalls.push({ url, blob })
      return true
    },
  },
  configurable: true,
  writable: true,
})

// Register custom module loader hook for Cloudflare & client dependencies
register(`data:text/javascript,
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return {
      url: "data:text/javascript,export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}",
      shortCircuit: true
    };
  }
  if (specifier === "./api" || specifier.endsWith("/api") || specifier.endsWith("/api.ts")) {
    return {
      url: "data:text/javascript,export const BASE = 'https://clip.test';",
      shortCircuit: true
    };
  }
  if (specifier === "react") {
    return {
      url: "data:text/javascript,export function useEffect(fn, deps) { fn(); }",
      shortCircuit: true
    };
  }
  if (specifier === "react-router-dom") {
    return {
      url: "data:text/javascript,export function useLocation() { return { pathname: '/' }; }",
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

// Dynamic imports after module loader registration
const { AnalyticsStore } = await import('../worker/src/durable/AnalyticsStore.ts')
const { default: worker } = await import('../worker/src/index.ts')
const {
  isDeviceExcluded,
  setDeviceExcluded,
  reportPageView,
  OPT_OUT_KEY,
} = await import('../frontend/src/lib/analytics.ts')

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

// ── Shared End-to-End Pipeline Environment ───────────────────────────────────
const { ctx, env: doEnv } = createMockState()
const store = new AnalyticsStore(ctx, doEnv)
const kv = createMockKV()

const env = {
  PASTE_KV: kv,
  ANALYTICS_DO: {
    idFromName(name) { return { name } },
    get(id) { return store },
  },
  ADMIN_SECRET: 'test-admin-secret-123',
  APP_PEPPER: 'test-pepper-salt',
  FRONTEND_ORIGIN: 'http://localhost:5173',
}

console.log('\n=== Analytics End-to-End Pipeline Verification ===\n')

// ── Stage 1 ──────────────────────────────────────────────────────────────────
await test('Stage 1: Sends public beacon from IP 198.51.100.1 visiting /about -> DO records 1 view, 1 visitor', async () => {
  const req = new Request('https://clip.test/api/analytics/event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '198.51.100.1',
      'CF-IPCountry': 'US',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    },
    body: JSON.stringify({
      path: '/about',
      referrer: 'https://news.ycombinator.com/item?id=123',
    }),
  })

  const res = await worker.fetch(req, env)
  assert.equal(res.status, 204, 'Beacon endpoint must respond with 204 No Content')

  const stats = await store.getStats('today')
  assert.equal(stats.totalViews, 1, 'Total views should be 1')
  assert.equal(stats.uniqueVisitors, 1, 'Unique visitors should be 1')
  assert.equal(stats.topPaths[0]?.path, '/about')
  assert.equal(stats.topPaths[0]?.count, 1)
  assert.equal(stats.topCountries[0]?.country, 'US')
  assert.equal(stats.devices[0]?.device, 'desktop')
  assert.equal(stats.topReferrers[0]?.referrer, 'news.ycombinator.com')
})

// ── Stage 2 ──────────────────────────────────────────────────────────────────
await test('Stage 2: Sends second beacon from same IP visiting /live on same date -> DO records 2 totalViews, 1 unique visitor (deduplication)', async () => {
  const req = new Request('https://clip.test/api/analytics/event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '198.51.100.1',
      'CF-IPCountry': 'US',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    },
    body: JSON.stringify({
      path: '/live',
      referrer: 'https://github.com/repo',
    }),
  })

  const res = await worker.fetch(req, env)
  assert.equal(res.status, 204)

  const stats = await store.getStats('today')
  assert.equal(stats.totalViews, 2, 'Total views should increment to 2')
  assert.equal(stats.uniqueVisitors, 1, 'Unique visitors should remain 1 due to daily deduplication of same IP hash')

  const paths = stats.topPaths.map((p) => p.path)
  assert.ok(paths.includes('/about'), '/about should be in topPaths')
  assert.ok(paths.includes('/live'), '/live should be in topPaths')
})

// ── Stage 3 ──────────────────────────────────────────────────────────────────
await test('Stage 3: Sends beacon visiting a private paste slug /f4a5dd3 -> path is masked to /:slug', async () => {
  const req = new Request('https://clip.test/api/analytics/event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.88',
      'CF-IPCountry': 'DE',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)',
    },
    body: JSON.stringify({
      path: '/f4a5dd3',
      referrer: '',
    }),
  })

  const res = await worker.fetch(req, env)
  assert.equal(res.status, 204)

  // Also test private slug with edit subpath (/f4a5dd3/edit) and random slug (/my-random-test-slug)
  const reqEdit = new Request('https://clip.test/api/analytics/event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.88',
      'CF-IPCountry': 'DE',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)',
    },
    body: JSON.stringify({
      path: '/f4a5dd3/edit',
    }),
  })
  await worker.fetch(reqEdit, env)

  const reqRandom = new Request('https://clip.test/api/analytics/event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.88',
      'CF-IPCountry': 'DE',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)',
    },
    body: JSON.stringify({
      path: '/my-random-test-slug',
    }),
  })
  await worker.fetch(reqRandom, env)

  const stats = await store.getStats('today')
  assert.equal(stats.totalViews, 5, 'Total views should now be 5')
  assert.equal(stats.uniqueVisitors, 2, 'Unique visitors should now be 2 (second visitor IP)')

  // Privacy verification: neither /f4a5dd3 nor /my-random-test-slug must EVER appear in topPaths
  const recordedPaths = stats.topPaths.map((p) => p.path)
  assert.ok(!recordedPaths.includes('/f4a5dd3'), 'Raw private slug /f4a5dd3 must never be stored')
  assert.ok(!recordedPaths.includes('/f4a5dd3/edit'), 'Raw private slug /f4a5dd3/edit must never be stored')
  assert.ok(!recordedPaths.includes('/my-random-test-slug'), 'Raw private slug /my-random-test-slug must never be stored')
  assert.ok(recordedPaths.includes('/:slug'), '/:slug masked pattern must be stored')
  assert.ok(recordedPaths.includes('/:slug/edit'), '/:slug/edit masked pattern must be stored')
})

// ── Stage 4 ──────────────────────────────────────────────────────────────────
await test('Stage 4: Excludes IP 198.51.100.1 via admin API -> sends beacon from that IP -> view count does NOT increment', async () => {
  // 1. Add IP to excluded list via Admin API
  const addReq = new Request('https://clip.test/api/admin/analytics/excluded-ips', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-admin-secret-123',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'add', ip: '198.51.100.1' }),
  })
  const addRes = await worker.fetch(addReq, env)
  assert.equal(addRes.status, 200)
  const addJson = await addRes.json()
  assert.equal(addJson.success, true)
  assert.ok(addJson.excludedIps.includes('198.51.100.1'))

  // 2. Verify GET /api/admin/analytics/excluded-ips confirms exclusion
  const getReq = new Request('https://clip.test/api/admin/analytics/excluded-ips', {
    method: 'GET',
    headers: { Authorization: 'Bearer test-admin-secret-123' },
  })
  const getRes = await worker.fetch(getReq, env)
  assert.equal(getRes.status, 200)
  const getJson = await getRes.json()
  assert.ok(getJson.excludedIps.includes('198.51.100.1'))

  // 3. Record baseline totalViews
  const statsBefore = await store.getStats('today')
  const viewsBefore = statsBefore.totalViews

  // 4. Send beacon from excluded IP
  const beaconReq = new Request('https://clip.test/api/analytics/event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '198.51.100.1',
      'CF-IPCountry': 'US',
    },
    body: JSON.stringify({ path: '/about' }),
  })
  const beaconRes = await worker.fetch(beaconReq, env)
  assert.equal(beaconRes.status, 204, 'Must return 204 even when excluded to avoid leaking info')

  // 5. Verify totalViews did NOT increment
  const statsAfter = await store.getStats('today')
  assert.equal(statsAfter.totalViews, viewsBefore, 'Views must not increment for excluded IP')
})

// ── Stage 5 ──────────────────────────────────────────────────────────────────
await test('Stage 5: Sends beacon with Admin Bearer auth or from opted-out client -> view count does NOT increment', async () => {
  const statsBefore = await store.getStats('today')
  const viewsBefore = statsBefore.totalViews

  // 5A: Request with Admin Bearer auth header is dropped without recording
  const adminReq = new Request('https://clip.test/api/analytics/event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-admin-secret-123',
      'CF-Connecting-IP': '203.0.113.200',
    },
    body: JSON.stringify({ path: '/beam' }),
  })
  const adminRes = await worker.fetch(adminReq, env)
  assert.equal(adminRes.status, 204)
  const statsAfterAdmin = await store.getStats('today')
  assert.equal(statsAfterAdmin.totalViews, viewsBefore, 'Admin request must not increment views')

  // 5B: Beacon with admin path is dropped without recording
  const adminPathReq = new Request('https://clip.test/api/analytics/event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.200',
    },
    body: JSON.stringify({ path: '/admin' }),
  })
  const adminPathRes = await worker.fetch(adminPathReq, env)
  assert.equal(adminPathRes.status, 204)
  const statsAfterAdminPath = await store.getStats('today')
  assert.equal(statsAfterAdminPath.totalViews, viewsBefore, '/admin visits must not increment views')

  // 5C: Client-side opt-out switch simulation
  clientBeaconCalls = []
  clientFetchCalls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    clientFetchCalls.push({ url, opts })
    return { ok: true, status: 204 }
  }

  // When opted out, reportPageView must never dispatch network requests
  setDeviceExcluded(true)
  assert.equal(isDeviceExcluded(), true, 'isDeviceExcluded must return true')
  reportPageView('/live')
  assert.equal(clientBeaconCalls.length, 0, 'Opted-out client must make 0 beacon calls')
  assert.equal(clientFetchCalls.length, 0, 'Opted-out client must make 0 fetch calls')

  // When opted in, reportPageView dispatches beacon call
  setDeviceExcluded(false)
  assert.equal(isDeviceExcluded(), false, 'isDeviceExcluded must return false after clearing')
  reportPageView('/live')
  assert.equal(clientBeaconCalls.length, 1, 'Opted-in client dispatches beacon call')

  // Restore fetch
  globalThis.fetch = originalFetch

  const finalStats = await store.getStats('today')
  assert.equal(finalStats.totalViews, viewsBefore, 'Total views in DB must remain completely unchanged across Stage 5')
})

// ── Stage 6 ──────────────────────────────────────────────────────────────────
await test('Stage 6: Queries admin analytics endpoint (GET /api/admin/analytics?range=today) -> verifies complete aggregate structure', async () => {
  // 1. Unauthenticated request must return 401 Unauthorized
  const unauthReq = new Request('https://clip.test/api/admin/analytics?range=today', { method: 'GET' })
  const unauthRes = await worker.fetch(unauthReq, env)
  assert.equal(unauthRes.status, 401, 'Unauthenticated request must be rejected')

  // 2. Authenticated request
  const req = new Request('https://clip.test/api/admin/analytics?range=today', {
    method: 'GET',
    headers: { Authorization: 'Bearer test-admin-secret-123' },
  })
  const res = await worker.fetch(req, env)
  assert.equal(res.status, 200, 'Authenticated request must return 200 OK')

  const data = await res.json()

  // Validate root fields
  assert.equal(data.range, 'today')
  assert.equal(typeof data.totalViews, 'number')
  assert.equal(typeof data.uniqueVisitors, 'number')
  assert.equal(data.totalViews, 5, 'totalViews should accurately reflect the 5 recorded events')
  assert.equal(data.uniqueVisitors, 2, 'uniqueVisitors should accurately reflect the 2 distinct visitor IPs')

  // Validate topPaths breakdown
  assert.ok(Array.isArray(data.topPaths), 'topPaths must be an array')
  assert.ok(data.topPaths.length > 0, 'topPaths must not be empty')
  for (const item of data.topPaths) {
    assert.equal(typeof item.path, 'string')
    assert.equal(typeof item.count, 'number')
  }

  // Validate topReferrers breakdown
  assert.ok(Array.isArray(data.topReferrers), 'topReferrers must be an array')
  assert.ok(data.topReferrers.some((r) => r.referrer === 'news.ycombinator.com'), 'news.ycombinator.com should be in topReferrers')

  // Validate topCountries breakdown
  assert.ok(Array.isArray(data.topCountries), 'topCountries must be an array')
  const countries = data.topCountries.map((c) => c.country)
  assert.ok(countries.includes('US'), 'US should be in topCountries')
  assert.ok(countries.includes('DE'), 'DE should be in topCountries')

  // Validate devices breakdown
  assert.ok(Array.isArray(data.devices), 'devices must be an array')
  const devices = data.devices.map((d) => d.device)
  assert.ok(devices.includes('desktop'), 'desktop should be in devices')
  assert.ok(devices.includes('mobile'), 'mobile should be in devices')

  // Validate deviceBreakdown map
  assert.equal(typeof data.deviceBreakdown, 'object')
  assert.ok(data.deviceBreakdown.desktop >= 1)
  assert.ok(data.deviceBreakdown.mobile >= 1)

  // Verify other ranges (7d and 30d) execute cleanly
  const res7d = await worker.fetch(
    new Request('https://clip.test/api/admin/analytics?range=7d', {
      headers: { Authorization: 'Bearer test-admin-secret-123' },
    }),
    env
  )
  assert.equal(res7d.status, 200)
  const data7d = await res7d.json()
  assert.equal(data7d.range, '7d')

  const res30d = await worker.fetch(
    new Request('https://clip.test/api/admin/analytics?range=30d', {
      headers: { Authorization: 'Bearer test-admin-secret-123' },
    }),
    env
  )
  assert.equal(res30d.status, 200)
  const data30d = await res30d.json()
  assert.equal(data30d.range, '30d')

  // Validate detected IP endpoint
  const detectedReq = new Request('https://clip.test/api/admin/analytics/detected-ip', {
    headers: {
      Authorization: 'Bearer test-admin-secret-123',
      'CF-Connecting-IP': '198.51.100.1',
    },
  })
  const detectedRes = await worker.fetch(detectedReq, env)
  assert.equal(detectedRes.status, 200)
  const detectedJson = await detectedRes.json()
  assert.equal(detectedJson.ip, '198.51.100.1')
})

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exit(1)
}
