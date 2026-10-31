/**
 * Unit tests for Admin Analytics API client methods (Task 4)
 * Run with: node scripts/test-admin-analytics-ui.mjs
 */
import assert from 'node:assert/strict'

// Mock global fetch
let fetchCalls = []
let mockResponseData = {}
let mockResponseStatus = 200
let mockResponseOk = true

globalThis.fetch = async (url, opts = {}) => {
  fetchCalls.push({ url: String(url), opts })
  return {
    ok: mockResponseOk,
    status: mockResponseStatus,
    json: async () => mockResponseData,
  }
}

// Target module under test
import * as api from '../frontend/src/lib/api.ts'

const {
  fetchAdminAnalytics,
  fetchAdminDetectedIp,
  fetchAdminExcludedIps,
  addAdminExcludedIp,
  removeAdminExcludedIp,
} = api

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    fetchCalls = []
    mockResponseData = {}
    mockResponseStatus = 200
    mockResponseOk = true
    await fn()
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } catch (err) {
    failed++
    console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.stack || err}`)
  }
}

console.log('\n--- Admin Analytics Client API Tests ---')

await test('1. All expected analytics API methods are exported', () => {
  assert.equal(typeof fetchAdminAnalytics, 'function', 'fetchAdminAnalytics must be exported as a function')
  assert.equal(typeof fetchAdminDetectedIp, 'function', 'fetchAdminDetectedIp must be exported as a function')
  assert.equal(typeof fetchAdminExcludedIps, 'function', 'fetchAdminExcludedIps must be exported as a function')
  assert.equal(typeof addAdminExcludedIp, 'function', 'addAdminExcludedIp must be exported as a function')
  assert.equal(typeof removeAdminExcludedIp, 'function', 'removeAdminExcludedIp must be exported as a function')
})

await test('2. fetchAdminAnalytics formats request with default range=today and returns data', async () => {
  mockResponseData = {
    range: 'today',
    totalViews: 42,
    uniqueVisitors: 15,
    topPaths: [{ path: '/', count: 30 }, { path: '/live', count: 12 }],
    topReferrers: [{ referrer: 'direct', count: 35 }],
    topCountries: [{ country: 'US', count: 20 }],
    devices: [{ device: 'desktop', count: 35 }, { device: 'mobile', count: 7 }],
  }

  const result = await fetchAdminAnalytics('my-secret-key')
  assert.equal(fetchCalls.length, 1)
  const call = fetchCalls[0]
  assert.match(call.url, /\/api\/admin\/analytics\?range=today/)
  assert.match(call.url, /key=my-secret-key/)
  assert.equal(call.opts.headers?.['Authorization'], 'Bearer my-secret-key')
  assert.deepEqual(result, mockResponseData)
})

await test('3. fetchAdminAnalytics passes custom ranges (7d, 30d)', async () => {
  mockResponseData = { range: '7d', totalViews: 100, uniqueVisitors: 50, topPaths: [], topReferrers: [], topCountries: [], devices: [] }
  await fetchAdminAnalytics('sec', '7d')
  assert.match(fetchCalls[0].url, /range=7d/)

  mockResponseData = { range: '30d', totalViews: 500, uniqueVisitors: 200, topPaths: [], topReferrers: [], topCountries: [], devices: [] }
  await fetchAdminAnalytics('sec', '30d')
  assert.match(fetchCalls[1].url, /range=30d/)
})

await test('4. fetchAdminAnalytics throws ApiError on failure', async () => {
  mockResponseOk = false
  mockResponseStatus = 401
  mockResponseData = { error: 'unauthorized', message: 'Invalid admin secret key' }

  await assert.rejects(
    async () => {
      await fetchAdminAnalytics('bad-key')
    },
    (err) => {
      assert.equal(err.error, 'unauthorized')
      return true
    }
  )
})

await test('5. fetchAdminDetectedIp fetches detected client IP', async () => {
  mockResponseData = { ip: '198.51.100.42' }
  const result = await fetchAdminDetectedIp('admin-key-123')

  assert.equal(fetchCalls.length, 1)
  const call = fetchCalls[0]
  assert.match(call.url, /\/api\/admin\/analytics\/detected-ip/)
  assert.match(call.url, /key=admin-key-123/)
  assert.equal(call.opts.headers?.['Authorization'], 'Bearer admin-key-123')
  assert.deepEqual(result, { ip: '198.51.100.42' })
})

await test('6. fetchAdminExcludedIps returns list of excluded IPs', async () => {
  mockResponseData = { excludedIps: ['192.168.1.1', '10.0.0.1'] }
  const result = await fetchAdminExcludedIps('admin-key-123')

  assert.equal(fetchCalls.length, 1)
  const call = fetchCalls[0]
  assert.match(call.url, /\/api\/admin\/analytics\/excluded-ips/)
  assert.equal(call.opts.headers?.['Authorization'], 'Bearer admin-key-123')
  assert.deepEqual(result, { excludedIps: ['192.168.1.1', '10.0.0.1'] })
})

await test('7. addAdminExcludedIp sends POST request with action: "add"', async () => {
  mockResponseData = { success: true, excludedIps: ['1.2.3.4'] }
  const result = await addAdminExcludedIp('admin-key-123', '1.2.3.4')

  assert.equal(fetchCalls.length, 1)
  const call = fetchCalls[0]
  assert.equal(call.opts.method, 'POST')
  assert.match(call.url, /\/api\/admin\/analytics\/excluded-ips/)
  assert.equal(call.opts.headers?.['Authorization'], 'Bearer admin-key-123')
  assert.equal(call.opts.headers?.['Content-Type'], 'application/json')
  assert.equal(call.opts.body, JSON.stringify({ action: 'add', ip: '1.2.3.4' }))
  assert.deepEqual(result, { success: true, excludedIps: ['1.2.3.4'] })
})

await test('8. removeAdminExcludedIp sends POST request with action: "remove"', async () => {
  mockResponseData = { success: true, excludedIps: [] }
  const result = await removeAdminExcludedIp('admin-key-123', '1.2.3.4')

  assert.equal(fetchCalls.length, 1)
  const call = fetchCalls[0]
  assert.equal(call.opts.method, 'POST')
  assert.match(call.url, /\/api\/admin\/analytics\/excluded-ips/)
  assert.equal(call.opts.headers?.['Authorization'], 'Bearer admin-key-123')
  assert.equal(call.opts.headers?.['Content-Type'], 'application/json')
  assert.equal(call.opts.body, JSON.stringify({ action: 'remove', ip: '1.2.3.4' }))
  assert.deepEqual(result, { success: true, excludedIps: [] })
})

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exit(1)
}
