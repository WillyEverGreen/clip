/**
 * Unit tests for AnalyticsStore Durable Object (SQLite backed)
 * Run with: node scripts/test-analytics-do.mjs
 */
import { register } from 'node:module'
// Mock cloudflare:workers for Node.js test environment
register('data:text/javascript,export function resolve(s,c,n){if(s==="cloudflare:workers")return{url:"data:text/javascript,export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}",shortCircuit:true};return n(s,c);}')

import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

// Dynamic import so the loader hook is in place before module resolution
const { AnalyticsStore } = await import('../worker/src/durable/AnalyticsStore.ts')

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
      // DDL or multi-statement without params
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
      storage: {
        sql,
      },
      blockConcurrencyWhile: async (fn) => fn(),
    },
    env: {},
    db,
  }
}

console.log('\nAnalyticsStore: SQLite schema and storage')

await test('initializes tables views and daily_rollups on construction', () => {
  const { ctx, env, db } = createMockState()
  new AnalyticsStore(ctx, env)

  // Verify tables exist in SQLite master catalog
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
  const names = tables.map(t => t.name)
  assert.ok(names.includes('views'), 'views table should exist')
  assert.ok(names.includes('daily_rollups'), 'daily_rollups table should exist')

  // Verify indexes exist
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all()
  const idxNames = indexes.map(i => i.name)
  assert.ok(idxNames.includes('idx_views_date'), 'idx_views_date index should exist')
  assert.ok(idxNames.includes('idx_views_hash'), 'idx_views_hash index should exist')
})

await test('records events with default values when optional fields are omitted', async () => {
  const { ctx, env, db } = createMockState()
  const store = new AnalyticsStore(ctx, env)

  await store.recordEvent({
    path: '/about',
  })

  const rows = db.prepare('SELECT * FROM views').all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].path, '/about')
  assert.equal(rows[0].referrer, 'direct')
  assert.equal(rows[0].country, 'XX')
  assert.equal(rows[0].device, 'desktop')
  assert.ok(rows[0].timestamp > 0)
  assert.match(rows[0].date, /^\d{4}-\d{2}-\d{2}$/)
})

await test('records events with custom properties and visitor hashes', async () => {
  const { ctx, env, db } = createMockState()
  const store = new AnalyticsStore(ctx, env)

  const fixedTs = Date.parse('2026-11-01T12:00:00Z')
  await store.recordEvent({
    date: '2026-11-01',
    timestamp: fixedTs,
    path: '/:slug',
    referrer: 'google.com',
    country: 'US',
    device: 'mobile',
    visitor_hash: 'hash-abc-123',
  })

  const row = db.prepare('SELECT * FROM views WHERE visitor_hash = ?').all('hash-abc-123')[0]
  assert.ok(row)
  assert.equal(row.path, '/:slug')
  assert.equal(row.referrer, 'google.com')
  assert.equal(row.country, 'US')
  assert.equal(row.device, 'mobile')
  assert.equal(row.timestamp, fixedTs)
})

console.log('\nAnalyticsStore: Aggregation & stats queries')

await test('getStats today returns accurate counts, distinct visitors, and breakdowns', async () => {
  const { ctx, env } = createMockState()
  const store = new AnalyticsStore(ctx, env)
  const today = '2026-11-01'
  const mockNow = new Date('2026-11-01T15:00:00Z')

  // Visitor 1 visits / twice
  await store.recordEvent({ date: today, path: '/', visitor_hash: 'u1', device: 'desktop', country: 'US', referrer: 'google.com' })
  await store.recordEvent({ date: today, path: '/', visitor_hash: 'u1', device: 'desktop', country: 'US', referrer: 'google.com' })
  // Visitor 2 visits / and /beam
  await store.recordEvent({ date: today, path: '/', visitor_hash: 'u2', device: 'mobile', country: 'FR', referrer: 'direct' })
  await store.recordEvent({ date: today, path: '/beam', visitor_hash: 'u2', device: 'mobile', country: 'FR', referrer: 'direct' })
  // Visitor 3 visits /about
  await store.recordEvent({ date: today, path: '/about', visitor_hash: 'u3', device: 'desktop', country: 'US', referrer: 'x.com' })

  // Query stats for today
  const stats = await store.getStats('today', mockNow)
  assert.equal(stats.range, 'today')
  assert.equal(stats.totalViews, 5, 'total views should be 5')
  assert.equal(stats.uniqueVisitors, 3, 'unique visitors should be 3')

  // Top paths
  assert.equal(stats.topPaths[0].path, '/')
  assert.equal(stats.topPaths[0].count, 3)

  // Countries
  const us = stats.topCountries.find(c => c.country === 'US')
  const fr = stats.topCountries.find(c => c.country === 'FR')
  assert.equal(us.count, 3)
  assert.equal(fr.count, 2)

  // Devices
  const desktop = stats.devices.find(d => d.device === 'desktop')
  const mobile = stats.devices.find(d => d.device === 'mobile')
  assert.equal(desktop.count, 3)
  assert.equal(mobile.count, 2)
})

await test('getStats 7d and 30d correctly filter past days', async () => {
  const { ctx, env } = createMockState()
  const store = new AnalyticsStore(ctx, env)
  const mockNow = new Date('2026-11-10T12:00:00Z') // Day 10

  // Event today (Day 10)
  await store.recordEvent({ date: '2026-11-10', path: '/', visitor_hash: 'u1' })
  // Event 4 days ago (Day 6 - inside 7d & 30d)
  await store.recordEvent({ date: '2026-11-06', path: '/beam', visitor_hash: 'u2' })
  // Event 15 days ago (Day 26 of prev month - inside 30d, outside 7d)
  await store.recordEvent({ date: '2026-10-26', path: '/about', visitor_hash: 'u3' })
  // Event 40 days ago (outside 30d)
  await store.recordEvent({ date: '2026-10-01', path: '/old', visitor_hash: 'u4' })

  const statsToday = await store.getStats('today', mockNow)
  assert.equal(statsToday.totalViews, 1)

  const stats7d = await store.getStats('7d', mockNow)
  assert.equal(stats7d.totalViews, 2, '7d should include day 10 and day 6')
  assert.equal(stats7d.uniqueVisitors, 2)

  const stats30d = await store.getStats('30d', mockNow)
  assert.equal(stats30d.totalViews, 3, '30d should include day 10, day 6, day 26')
  assert.equal(stats30d.uniqueVisitors, 3)
})

console.log('\nAnalyticsStore: Rollup and Retention Pruning')

await test('rollup creates daily_rollups summary and prune deletes events older than 30 days', async () => {
  const { ctx, env, db } = createMockState()
  const store = new AnalyticsStore(ctx, env)
  const targetDate = '2026-10-01'

  await store.recordEvent({ date: targetDate, path: '/', visitor_hash: 'u1', country: 'DE', device: 'desktop' })
  await store.recordEvent({ date: targetDate, path: '/', visitor_hash: 'u2', country: 'DE', device: 'mobile' })
  await store.recordEvent({ date: targetDate, path: '/live', visitor_hash: 'u1', country: 'DE', device: 'desktop' })

  // Run rollup
  await store.rollup(targetDate)

  const rollupRow = db.prepare('SELECT * FROM daily_rollups WHERE date = ?').all(targetDate)[0]
  assert.ok(rollupRow, 'daily_rollups row should be inserted')
  assert.equal(rollupRow.total_views, 3)
  assert.equal(rollupRow.unique_visitors, 2)

  const parsed = JSON.parse(rollupRow.data_json)
  assert.equal(parsed.paths[0].path, '/')
  assert.equal(parsed.paths[0].count, 2)
  assert.equal(parsed.countries[0].country, 'DE')

  // Pruning: events older than 30 days relative to 2026-11-05
  const mockNow = new Date('2026-11-05T00:00:00Z')
  // targetDate (2026-10-01) is 35 days older than 2026-11-05
  await store.prune(30, mockNow)

  const remainingViews = db.prepare('SELECT COUNT(*) as count FROM views WHERE date = ?').all(targetDate)[0]
  assert.equal(remainingViews.count, 0, 'raw views for targetDate should be pruned')

  // Verify daily_rollups still has the data
  const preservedRollup = db.prepare('SELECT COUNT(*) as count FROM daily_rollups WHERE date = ?').all(targetDate)[0]
  assert.equal(preservedRollup.count, 1, 'rollup row must remain preserved')
})

console.log('\nAnalyticsStore: Fetch HTTP API')

await test('fetch POST /event records event and returns 204', async () => {
  const { ctx, env, db } = createMockState()
  const store = new AnalyticsStore(ctx, env)

  const req = new Request('https://worker.internal/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: '/b/xyz',
      referrer: 'https://news.ycombinator.com',
      country: 'JP',
      device: 'desktop',
      visitor_hash: 'jp-user-1',
    }),
  })

  const res = await store.fetch(req)
  assert.equal(res.status, 204)

  const rows = db.prepare('SELECT * FROM views WHERE visitor_hash = ?').all('jp-user-1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].path, '/b/xyz')
})

await test('fetch GET /stats returns summary json', async () => {
  const { ctx, env } = createMockState()
  const store = new AnalyticsStore(ctx, env)

  await store.recordEvent({ path: '/', visitor_hash: 'u1' })

  const req = new Request('https://worker.internal/stats?range=today', { method: 'GET' })
  const res = await store.fetch(req)
  assert.equal(res.status, 200)

  const data = await res.json()
  assert.equal(data.totalViews, 1)
  assert.equal(data.uniqueVisitors, 1)
  assert.equal(data.range, 'today')
})

await test('fetch returns 404 for unknown route', async () => {
  const { ctx, env } = createMockState()
  const store = new AnalyticsStore(ctx, env)

  const req = new Request('https://worker.internal/unknown', { method: 'GET' })
  const res = await store.fetch(req)
  assert.equal(res.status, 404)
})

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
