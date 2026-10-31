/**
 * Unit tests for Frontend Analytics Beacon Hook & Client Exclusion Switch
 * Run with: node scripts/test-analytics-frontend.mjs
 */
import { register } from 'node:module'
import assert from 'node:assert/strict'

// Mock browser storage and network
let storage = new Map()
let shouldStorageThrow = false

const mockLocalStorage = {
  getItem(key) {
    if (shouldStorageThrow) throw new Error('QuotaExceeded or SecurityError')
    return storage.has(key) ? storage.get(key) : null
  },
  setItem(key, val) {
    if (shouldStorageThrow) throw new Error('QuotaExceeded or SecurityError')
    storage.set(key, String(val))
  },
  removeItem(key) {
    if (shouldStorageThrow) throw new Error('QuotaExceeded or SecurityError')
    storage.delete(key)
  },
  clear() {
    storage.clear()
  },
}

let beaconCalls = []
let fetchCalls = []
let sendBeaconResult = true
let sendBeaconShouldThrow = false
let fetchShouldReject = false

globalThis.window = globalThis
globalThis.document = { referrer: 'https://news.ycombinator.com' }
globalThis.localStorage = mockLocalStorage
Object.defineProperty(globalThis, 'navigator', {
  value: {
    sendBeacon(url, data) {
      if (sendBeaconShouldThrow) throw new Error('sendBeacon error')
      beaconCalls.push({ url, data })
      return sendBeaconResult
    },
  },
  configurable: true,
  writable: true,
})
globalThis.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts })
  if (fetchShouldReject) throw new Error('Network error')
  return { ok: true, status: 204 }
}

globalThis.__testPathname = '/'
globalThis.__runEffects = true

// Register module mocks for browser-only dependencies
register(`data:text/javascript,
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "./api" || specifier.endsWith("/api") || specifier.endsWith("/api.ts")) {
    return {
      url: "data:text/javascript,export const BASE = 'https://clip.test';",
      shortCircuit: true
    };
  }
  if (specifier === "react") {
    return {
      url: "data:text/javascript,export function useEffect(fn, deps) { if (globalThis.__runEffects) { fn(); } }",
      shortCircuit: true
    };
  }
  if (specifier === "react-router-dom") {
    return {
      url: "data:text/javascript,export function useLocation() { return { pathname: globalThis.__testPathname || '/' }; }",
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

// Dynamic import of target module under test (will fail before implementation)
const {
  OPT_OUT_KEY,
  isDeviceExcluded,
  setDeviceExcluded,
  reportPageView,
  useAnalytics,
} = await import('../frontend/src/lib/analytics.ts')

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    // Reset mocks before each test
    storage.clear()
    beaconCalls = []
    fetchCalls = []
    sendBeaconResult = true
    sendBeaconShouldThrow = false
    fetchShouldReject = false
    shouldStorageThrow = false
    globalThis.document.referrer = 'https://news.ycombinator.com'
    globalThis.__testPathname = '/'

    await fn()
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } catch (err) {
    failed++
    console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.stack || err}`)
  }
}

console.log('\n--- Frontend Analytics Unit Tests ---')

await test('1. OPT_OUT_KEY is clip_analytics_opt_out', () => {
  assert.equal(OPT_OUT_KEY, 'clip_analytics_opt_out')
})

await test('2. isDeviceExcluded() correctly reads exclusion flag from localStorage', () => {
  assert.equal(isDeviceExcluded(), false)

  storage.set('clip_analytics_opt_out', '1')
  assert.equal(isDeviceExcluded(), true)

  storage.set('clip_analytics_opt_out', '0')
  assert.equal(isDeviceExcluded(), false)

  storage.delete('clip_analytics_opt_out')
  assert.equal(isDeviceExcluded(), false)
})

await test('3. setDeviceExcluded(true) sets "1", and setDeviceExcluded(false) removes key', () => {
  setDeviceExcluded(true)
  assert.equal(storage.get('clip_analytics_opt_out'), '1')
  assert.equal(isDeviceExcluded(), true)

  setDeviceExcluded(false)
  assert.equal(storage.has('clip_analytics_opt_out'), false)
  assert.equal(isDeviceExcluded(), false)
})

await test('4. isDeviceExcluded and setDeviceExcluded handle storage errors gracefully', () => {
  shouldStorageThrow = true

  // Should not throw and default to false
  assert.equal(isDeviceExcluded(), false)

  // Should not throw
  assert.doesNotThrow(() => {
    setDeviceExcluded(true)
  })
})

await test('5. When opted out, reportPageView performs zero network calls', async () => {
  setDeviceExcluded(true)

  reportPageView('/')
  reportPageView('/live')
  reportPageView('/my-slug')

  assert.equal(beaconCalls.length, 0)
  assert.equal(fetchCalls.length, 0)
})

await test('6. When pathname starts with /admin, reportPageView returns without sending', async () => {
  reportPageView('/admin')
  reportPageView('/admin/analytics')
  reportPageView('/admin/settings')

  assert.equal(beaconCalls.length, 0)
  assert.equal(fetchCalls.length, 0)
})

await test('7. When opted in, reportPageView dispatches payload via navigator.sendBeacon', async () => {
  globalThis.document.referrer = 'https://twitter.com'

  reportPageView('/beam')

  assert.equal(beaconCalls.length, 1)
  const call = beaconCalls[0]
  assert.equal(call.url, 'https://clip.test/api/analytics/event')
  assert.ok(call.data instanceof Blob, 'sendBeacon data must be a Blob')
  assert.equal(call.data.type, 'application/json')

  const text = await call.data.text()
  const payload = JSON.parse(text)
  assert.deepEqual(payload, {
    path: '/beam',
    referrer: 'https://twitter.com',
  })
  assert.equal(fetchCalls.length, 0)
})

await test('8. When sendBeacon returns false, falls back to keepalive fetch', async () => {
  sendBeaconResult = false
  globalThis.document.referrer = ''

  reportPageView('/live/test-room')

  assert.equal(beaconCalls.length, 1)
  assert.equal(fetchCalls.length, 1)

  const fCall = fetchCalls[0]
  assert.equal(fCall.url, 'https://clip.test/api/analytics/event')
  assert.equal(fCall.opts.method, 'POST')
  assert.equal(fCall.opts.keepalive, true)
  assert.equal(fCall.opts.headers['Content-Type'], 'application/json')

  const payload = JSON.parse(fCall.opts.body)
  assert.deepEqual(payload, {
    path: '/live/test-room',
    referrer: '',
  })
})

await test('9. When sendBeacon throws, falls back to keepalive fetch', async () => {
  sendBeaconShouldThrow = true

  reportPageView('/about')

  assert.equal(fetchCalls.length, 1)
  const payload = JSON.parse(fetchCalls[0].opts.body)
  assert.equal(payload.path, '/about')
})

await test('10. Network errors in fetch are caught and silenced', async () => {
  sendBeaconResult = false
  fetchShouldReject = true

  assert.doesNotThrow(() => {
    reportPageView('/fail-path')
  })
})

await test('11. useAnalytics hook reads useLocation() and reports page view', async () => {
  globalThis.__testPathname = '/about'

  useAnalytics()

  assert.equal(beaconCalls.length, 1)
  const text = await beaconCalls[0].data.text()
  assert.deepEqual(JSON.parse(text), {
    path: '/about',
    referrer: 'https://news.ycombinator.com',
  })
})

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exit(1)
}
