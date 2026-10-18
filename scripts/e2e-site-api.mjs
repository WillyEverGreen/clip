/**
 * End-to-end check of the whole site's HTTP API against a REAL worker.
 *
 *   1. cd worker && npx wrangler dev --local --port 8787
 *   2. node scripts/e2e-site-api.mjs            (optionally: API=http://127.0.0.1:8787)
 *
 * Not part of `npm test` because it needs a running worker.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

// fflate is a frontend dependency; resolve it from there
const { strFromU8, unzipSync } = createRequire(new URL('../frontend/package.json', import.meta.url))('fflate')

const API = process.env.API || 'http://127.0.0.1:8787'

// The worker rate-limits per client IP. Give every request its own so tests do not trip the limiter
// (Cloudflare sets this header itself in production, so clients cannot spoof it there).
const realFetch = globalThis.fetch
let ipCounter = 1
globalThis.fetch = (url, init = {}) => {
  const headers = new Headers(init.headers || {})
  // Production sits behind Cloudflare, which sets this header itself and rejects client-supplied ones
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(String(url))
  if (local && !headers.has('CF-Connecting-IP')) {
    ipCounter++
    headers.set('CF-Connecting-IP', `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`)
  }
  return realFetch(url, { ...init, headers })
}

let passed = 0
let failed = 0

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  catch (err) { failed++; console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.stack || err}`) }
}

const uid = () => Math.random().toString(36).slice(2, 8)
const J = { Accept: 'application/json' }

async function create(fields = {}, files = []) {
  const fd = new FormData()
  const defaults = { editCode: 'secret-code', ...fields }
  for (const [k, v] of Object.entries(defaults)) if (v !== undefined) fd.append(k, v)
  for (const f of files) fd.append('files', new File([f.body], f.name, { type: f.type }))
  const res = await fetch(`${API}/api/entry`, { method: 'POST', body: fd })
  return { res, json: await res.json().catch(() => null) }
}
const read = async (slug) => {
  const res = await fetch(`${API}/api/entry/${slug}`, { headers: J })
  return { res, json: await res.json().catch(() => null) }
}
const patchEntry = (slug, fields) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  return fetch(`${API}/api/entry/${slug}`, { method: 'PATCH', body: fd })
}
const del = (slug, editCode) => fetch(`${API}/api/entry/${slug}`, {
  method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ editCode }),
})

console.log('\n\x1b[1m\x1b[36mSite API end-to-end (real worker)\x1b[0m')

console.log('\n\x1b[1mBasics\x1b[0m')
await test('health endpoint answers', async () => {
  const res = await fetch(`${API}/api/health`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
})

await test('security headers are present on every response', async () => {
  const res = await fetch(`${API}/api/health`)
  assert.equal(res.headers.get('x-frame-options'), 'DENY')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.ok(res.headers.get('content-security-policy'))
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
})

await test('CORS allows the site origin and echoes allowed origins only', async () => {
  const ok = await fetch(`${API}/api/health`, { headers: { Origin: 'https://clip.foo.ng' } })
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://clip.foo.ng')
  const evil = await fetch(`${API}/api/health`, { headers: { Origin: 'https://evil.example' } })
  assert.notEqual(evil.headers.get('access-control-allow-origin'), 'https://evil.example')
})

await test('quote proxy returns a quote or a clean 502, never a crash', async () => {
  const res = await fetch(`${API}/api/quote`)
  assert.ok([200, 502].includes(res.status))
  const body = await res.json()
  if (res.status === 200) {
    assert.equal(typeof body.text, 'string')
    assert.equal(typeof body.author, 'string')
    assert.ok(body.text.length > 0)
  } else {
    assert.equal(body.error, 'quote_unavailable')
  }
})

console.log('\n\x1b[1mText clips\x1b[0m')
await test('create, read, view counter, raw and short CLI routes', async () => {
  const slug = `t-${uid()}`
  const { res, json } = await create({ content: 'hello **world**', slug, ttl: '600' })
  assert.equal(res.status, 201)
  assert.equal(json.slug, slug)
  assert.ok(Math.abs(json.expiresAt - (Date.now() + 600_000)) < 10_000)

  const first = await read(slug)
  assert.equal(first.res.status, 200)
  assert.equal(first.json.content, 'hello **world**')
  assert.equal(first.json.type, 'text')
  assert.equal(first.json.editCodeHash, undefined, 'edit code hash must never be exposed')
  const second = await read(slug)
  assert.ok(second.json.views > first.json.views, 'views should increase')

  for (const path of [`/r/${slug}`, `/raw/${slug}`, `/${slug}/raw`]) {
    const raw = await fetch(`${API}${path}`)
    assert.equal(raw.status, 200, path)
    assert.match(raw.headers.get('content-type'), /text\/plain/)
    assert.equal(await raw.text(), 'hello **world**')
  }
})

await test('unicode, emoji, tabs and newlines survive a round trip', async () => {
  const content = 'naïve café 🐼😀\nline two\n\ttabbed — “quotes”\n'
  const { json } = await create({ content, slug: `u-${uid()}` })
  const back = await read(json.slug)
  assert.equal(back.json.content, content)
  const raw = await (await fetch(`${API}/r/${json.slug}`)).text()
  assert.equal(raw, content, 'raw output must match exactly, with plain \\n line endings')
})

await test('Windows line endings are normalised so CLI output stays clean', async () => {
  const { json } = await create({ content: 'one\r\ntwo\rthree\nfour', slug: `crlf-${uid()}` })
  assert.equal((await read(json.slug)).json.content, 'one\ntwo\nthree\nfour')
  const slug = `crlf-${uid()}`
  await create({ content: 'x', slug, editCode: 'right-code' })
  await patchEntry(slug, { editCode: 'right-code', content: 'edited\r\nvia patch' })
  assert.equal((await read(slug)).json.content, 'edited\nvia patch')
})

await test('text without a slug gets a generated one', async () => {
  const { res, json } = await create({ content: 'auto slug' })
  assert.equal(res.status, 201)
  assert.match(json.slug, /^[a-z0-9]{6,}$/)
})

await test('slug rules: duplicates, reserved words, bad characters, length', async () => {
  const slug = `d-${uid()}`
  assert.equal((await create({ content: 'one', slug })).res.status, 201)
  const dup = await create({ content: 'two', slug })
  assert.equal(dup.res.status, 409)
  assert.equal(dup.json.error, 'slug_taken')
  for (const reserved of ['about', 'admin', 'live', 'api', 'edit', 'new']) {
    const r = await create({ content: 'x', slug: reserved })
    assert.equal(r.res.status, 400, reserved)
    assert.equal(r.json.error, 'slug_reserved', reserved)
  }
  for (const bad of ['a', 'has space', 'bad!chars', 'x'.repeat(60), '-lead-dash']) {
    const r = await create({ content: 'x', slug: bad })
    assert.equal(r.res.status, 400, bad)
    assert.equal(r.json.error, 'slug_invalid', bad)
  }
})

await test('edit code and content are validated', async () => {
  const noCode = await create({ content: 'x', editCode: undefined })
  assert.equal(noCode.res.status, 400)
  assert.equal(noCode.json.error, 'missing_edit_code')
  const short = await create({ content: 'x', editCode: 'abc' })
  assert.equal(short.res.status, 400)
  const empty = await create({ content: '   ', slug: `e-${uid()}` })
  assert.equal(empty.res.status, 400)
  assert.equal(empty.json.error, 'no_content')
})

await test('text over 2 MB is refused, just under is accepted', async () => {
  const tooBig = await create({ content: 'a'.repeat(2 * 1024 * 1024 + 1), slug: `b-${uid()}` })
  assert.equal(tooBig.res.status, 400)
  assert.equal(tooBig.json.error, 'text_too_large')
  const fits = await create({ content: 'a'.repeat(2 * 1024 * 1024 - 10), slug: `b-${uid()}` })
  assert.equal(fits.res.status, 201)
})

await test('expiry options: custom TTL, permanent, and out-of-range values', async () => {
  const short = await create({ content: 'x', slug: `x-${uid()}`, ttl: '600' })
  assert.ok(short.json.expiresAt - Date.now() < 700_000)
  const perm = await create({ content: 'x', slug: `x-${uid()}`, ttl: 'permanent' })
  assert.ok(perm.json.expiresAt - Date.now() > 10 * 365 * 24 * 3600 * 1000)
  const read1 = await read(perm.json.slug)
  assert.equal(read1.json.isPermanent, true)
  const month = await create({ content: 'x', slug: `x-${uid()}`, ttl: '2592000' })
  assert.ok(month.json.expiresAt - Date.now() > 29 * 24 * 3600 * 1000)
})

await test('unknown and malformed slugs return clean 404s', async () => {
  const missing = await read('does-not-exist-xyz')
  assert.equal(missing.res.status, 404)
  assert.equal(missing.json.error, 'not_found')
  assert.equal((await fetch(`${API}/r/does-not-exist-xyz`)).status, 404)
  assert.equal((await fetch(`${API}/f/does-not-exist-xyz`)).status, 404)
  assert.equal((await fetch(`${API}/z/does-not-exist-xyz`)).status, 404)
})

console.log('\n\x1b[1mEditing and deleting\x1b[0m')
await test('verify, edit, wrong code and delete', async () => {
  const slug = `ed-${uid()}`
  await create({ content: 'original', slug, editCode: 'right-code' })

  const verify = (code) => fetch(`${API}/api/entry/${slug}/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ editCode: code }),
  }).then(r => r.json())
  assert.deepEqual(await verify('right-code'), { valid: true })
  assert.deepEqual(await verify('wrong-code'), { valid: false })
  assert.deepEqual(await verify(''), { valid: false })

  const denied = await patchEntry(slug, { editCode: 'wrong-code', content: 'hacked' })
  assert.equal(denied.status, 403)
  assert.equal((await read(slug)).json.content, 'original')

  const ok = await patchEntry(slug, { editCode: 'right-code', content: 'updated text' })
  assert.equal(ok.status, 200)
  const after = await read(slug)
  assert.equal(after.json.content, 'updated text')
  assert.ok(after.json.updatedAt, 'updatedAt should be set')

  const badDel = await del(slug, 'wrong-code')
  assert.equal(badDel.status, 403)
  assert.equal((await read(slug)).res.status, 200)
  const goodDel = await del(slug, 'right-code')
  assert.equal(goodDel.status, 200)
  assert.equal((await read(slug)).res.status, 404)
  assert.equal((await del(slug, 'right-code')).status, 404)
})

await test('live update stream announces an edit to viewers', async () => {
  const slug = `sse-${uid()}`
  await create({ content: 'before', slug, editCode: 'right-code' })
  const ctrl = new AbortController()
  const res = await fetch(`${API}/api/entry/${slug}/events`, { signal: ctrl.signal })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  const reader = res.body.getReader()
  let received = ''
  const pump = (async () => {
    const dec = new TextDecoder()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        received += dec.decode(value)
      }
    } catch { /* aborted */ }
  })()
  await new Promise(r => setTimeout(r, 400))
  await patchEntry(slug, { editCode: 'right-code', content: 'after' })
  const end = Date.now() + 4000
  while (Date.now() < end && !/update/i.test(received)) await new Promise(r => setTimeout(r, 100))
  ctrl.abort()
  await pump
  assert.match(received, /update/i, `expected an update event, got: ${JSON.stringify(received.slice(0, 200))}`)
})

console.log('\n\x1b[1mFiles\x1b[0m')
await test('upload a file with a note, download it, and fetch the zip', async () => {
  const slug = `f-${uid()}`
  const { res } = await create({ slug, type: 'file', content: 'a note' }, [
    { name: 'hello.txt', body: 'file body here', type: 'text/plain' },
  ])
  assert.equal(res.status, 201)
  const entry = (await read(slug)).json
  assert.equal(entry.type, 'file')
  assert.equal(entry.files.length, 1)
  assert.equal(entry.files[0].fileName, 'hello.txt')
  assert.equal(entry.files[0].fileSize, 14)
  assert.ok(entry.fileExpiresAt, 'files carry their own 48h expiry')

  const dl = await fetch(`${API}/f/${slug}`)
  assert.equal(dl.status, 200)
  assert.equal(await dl.text(), 'file body here')
  assert.match(dl.headers.get('content-disposition') || '', /hello\.txt/)

  const zip = await fetch(`${API}/z/${slug}`)
  assert.equal(zip.status, 200)
  const files = unzipSync(new Uint8Array(await zip.arrayBuffer()))
  const names = Object.keys(files)
  assert.ok(names.includes('hello.txt'), names.join(','))
  assert.equal(strFromU8(files['hello.txt']), 'file body here')
  assert.ok(names.some(n => n.endsWith('.txt') && n !== 'hello.txt'), 'zip should include the text note too')
})

await test('several files in one clip keep their own names and bytes', async () => {
  const slug = `f-${uid()}`
  const bin = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
  const { res } = await create({ slug, type: 'file' }, [
    { name: 'a.txt', body: 'alpha', type: 'text/plain' },
    { name: 'b.bin', body: bin, type: 'application/octet-stream' },
    { name: 'c.json', body: '{"k":1}', type: 'application/json' },
  ])
  assert.equal(res.status, 201)
  const entry = (await read(slug)).json
  assert.deepEqual(entry.files.map(f => f.fileName).sort(), ['a.txt', 'b.bin', 'c.json'])
  const dlB = await fetch(`${API}/api/entry/${slug}/file?fileId=${entry.files.find(f => f.fileName === 'b.bin').id}`)
  assert.equal(dlB.status, 200)
  assert.deepEqual(new Uint8Array(await dlB.arrayBuffer()), bin)
  const zip = unzipSync(new Uint8Array(await (await fetch(`${API}/z/${slug}`)).arrayBuffer()))
  assert.deepEqual(Object.keys(zip).filter(n => ['a.txt', 'b.bin', 'c.json'].includes(n)).sort(), ['a.txt', 'b.bin', 'c.json'])
})

await test('a file whose bytes do not match its type is rejected', async () => {
  const { res, json } = await create({ slug: `m-${uid()}`, type: 'file' }, [
    { name: 'fake.png', body: 'this is not a png at all', type: 'image/png' },
  ])
  assert.equal(res.status, 400)
  assert.equal(json.error, 'mime_mismatch')
})

await test('a real PNG is accepted', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const { res } = await create({ slug: `p-${uid()}`, type: 'file' }, [{ name: 'x.png', body: png, type: 'image/png' }])
  assert.equal(res.status, 201)
})

await test('files larger than 25 MB are refused', async () => {
  const big = new Uint8Array(25 * 1024 * 1024 + 1)
  const { res, json } = await create({ slug: `big-${uid()}`, type: 'file' }, [{ name: 'big.bin', body: big, type: 'application/octet-stream' }])
  assert.equal(res.status, 400)
  assert.equal(json.error, 'file_too_large')
})

await test('a file clip without a file is refused', async () => {
  const { res, json } = await create({ slug: `nf-${uid()}`, type: 'file' })
  assert.equal(res.status, 400)
  assert.equal(json.error, 'no_content')
})

console.log('\n\x1b[1mLive pads\x1b[0m')
await test('new live slugs are unique, valid and reserved for the room', async () => {
  const a = await (await fetch(`${API}/api/live/new-slug`)).json()
  const b = await (await fetch(`${API}/api/live/new-slug`)).json()
  assert.match(a.slug, /^[a-z0-9]{6,}$/)
  assert.notEqual(a.slug, b.slug)
  // a normal clip may not steal a slug reserved for a live room
  const stolen = await create({ content: 'x', slug: a.slug })
  assert.equal(stolen.res.status, 409)
  assert.equal(stolen.json.error, 'slug_reserved')
})

await test('live pad file upload, download, zip and delete', async () => {
  const { slug } = await (await fetch(`${API}/api/live/new-slug`)).json()
  const upload = async (name, body, type = 'text/plain') => {
    const fd = new FormData()
    fd.append('file', new File([body], name, { type }))
    const res = await fetch(`${API}/api/live/${slug}/upload`, { method: 'POST', body: fd })
    return { res, json: await res.json() }
  }
  const one = await upload('one.txt', 'first file')
  assert.equal(one.res.status, 200, JSON.stringify(one.json))
  const two = await upload('two.txt', 'second file')
  assert.equal(two.res.status, 200)

  const state = await (await fetch(`${API}/api/live/${slug}`)).json()
  assert.equal(state.files.length, 2)
  const id = state.files.find(f => f.fileName === 'one.txt').id
  const dl = await fetch(`${API}/api/live/${slug}/file/${id}`)
  assert.equal(dl.status, 200)
  assert.equal(await dl.text(), 'first file')

  const zip = unzipSync(new Uint8Array(await (await fetch(`${API}/api/live/${slug}/zip`)).arrayBuffer()))
  assert.deepEqual(Object.keys(zip).sort(), ['one.txt', 'two.txt'])

  const rm = await fetch(`${API}/api/live/${slug}/file/${id}`, { method: 'DELETE' })
  assert.equal(rm.status, 200)
  const after = await (await fetch(`${API}/api/live/${slug}`)).json()
  assert.deepEqual(after.files.map(f => f.fileName), ['two.txt'])
  assert.equal((await fetch(`${API}/api/live/${slug}/file/${id}`)).status, 404)

  const batch = await fetch(`${API}/api/live/${slug}/files/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileIds: [after.files[0].id] }),
  })
  assert.equal(batch.status, 200)
  assert.equal((await (await fetch(`${API}/api/live/${slug}`)).json()).files.length, 0)
  const noIds = await fetch(`${API}/api/live/${slug}/files/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })
  assert.equal(noIds.status, 400)
})

await test('live upload rejects a missing file and oversize files', async () => {
  const { slug } = await (await fetch(`${API}/api/live/new-slug`)).json()
  const empty = await fetch(`${API}/api/live/${slug}/upload`, { method: 'POST', body: new FormData() })
  assert.equal(empty.status, 400)
  const fd = new FormData()
  fd.append('file', new File([new Uint8Array(25 * 1024 * 1024 + 1)], 'big.bin'))
  const big = await fetch(`${API}/api/live/${slug}/upload`, { method: 'POST', body: fd })
  assert.equal(big.status, 400)
})

await test('saving a live pad as a link keeps its slug and works with the room reservation', async () => {
  const { slug } = await (await fetch(`${API}/api/live/new-slug`)).json()
  const { res } = await create({ content: 'saved from a pad', slug, fromLiveRoom: 'true' })
  assert.equal(res.status, 201)
  assert.equal((await read(slug)).json.content, 'saved from a pad')
})

await test('locked live pads refuse uploads without the password', async () => {
  const { slug } = await (await fetch(`${API}/api/live/new-slug`)).json()
  const sec = await fetch(`${API}/api/live/${slug}/security`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isProtected: true, salt: 'salt1', authHash: 'a'.repeat(64) }),
  })
  assert.equal(sec.status, 200)
  const fd = new FormData()
  fd.append('file', new File(['secret'], 'x.txt', { type: 'text/plain' }))
  const res = await fetch(`${API}/api/live/${slug}/upload`, { method: 'POST', body: fd })
  assert.equal(res.status, 401)
  const state = await (await fetch(`${API}/api/live/${slug}`)).json()
  assert.equal(state.isProtected, true)
  assert.notEqual(state.text, 'secret')
})

await test('protected live pads: files work with the right password only (upload, download, zip, delete)', async () => {
  const { createHash } = await import('node:crypto')
  const { slug } = await (await fetch(`${API}/api/live/new-slug`)).json()
  const salt = 'e2e-salt'
  const authHash = createHash('sha256').update(`pw-correct:${salt}`).digest('hex')   // same format the browser uses
  const sec = await fetch(`${API}/api/live/${slug}/security`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isProtected: true, salt, authHash }),
  })
  assert.equal(sec.status, 200)

  const upload = (password) => {
    const fd = new FormData()
    fd.append('file', new File(['locked file body'], 'locked.txt', { type: 'text/plain' }))
    return fetch(`${API}/api/live/${slug}/upload`, { method: 'POST', body: fd, headers: password ? { 'x-password': password } : {} })
  }
  assert.equal((await upload()).status, 401)
  assert.equal((await upload('pw-wrong')).status, 401)
  const ok = await upload('pw-correct')
  assert.equal(ok.status, 200)
  const { file } = await ok.json()

  const get = (password) => fetch(`${API}/api/live/${slug}/file/${file.id}`, { headers: password ? { 'x-password': password } : {} })
  assert.notEqual((await get()).status, 200)
  assert.notEqual((await get('pw-wrong')).status, 200)
  const dl = await get('pw-correct')
  assert.equal(dl.status, 200)
  assert.equal(await dl.text(), 'locked file body')

  const zipRes = await fetch(`${API}/api/live/${slug}/zip`, { headers: { 'x-password': 'pw-correct' } })
  assert.equal(zipRes.status, 200)
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await zipRes.arrayBuffer()))), ['locked.txt'])
  assert.notEqual((await fetch(`${API}/api/live/${slug}/zip`)).status, 200)

  const rm = (password) => fetch(`${API}/api/live/${slug}/file/${file.id}`, { method: 'DELETE', headers: password ? { 'x-password': password } : {} })
  assert.equal((await rm('pw-wrong')).status, 401)
  assert.equal((await rm('pw-correct')).status, 200)
  assert.equal((await get('pw-correct')).status, 404)
})

console.log('\n\x1b[1mRobustness\x1b[0m')
await test('rate limiting kicks in for a client that hammers the create endpoint', async () => {
  const ip = `203.0.113.${1 + Math.floor(Math.random() * 250)}`   // fresh bucket on every run
  const statuses = []
  let retryAfter = null
  for (let i = 0; i < 60; i++) {
    const fd = new FormData()
    fd.append('content', `spam ${i}`)
    fd.append('editCode', 'secret-code')
    const res = await fetch(`${API}/api/entry`, { method: 'POST', body: fd, headers: { 'CF-Connecting-IP': ip } })
    statuses.push(res.status)
    if (res.status === 429) {
      retryAfter = res.headers.get('retry-after')
      break
    }
  }
  assert.ok(statuses.includes(429), `expected a 429 within 60 creates, got ${[...new Set(statuses)]}`)
  assert.ok(statuses.slice(0, 5).every(s => s === 201), 'normal use must not be limited')
  assert.ok(Number(retryAfter) > 0, 'Retry-After header should tell the client when to come back')
  // a different client is unaffected
  const other = await create({ content: 'fine' })
  assert.equal(other.res.status, 201)
})

await test('garbage requests get clean errors, not crashes', async () => {
  const notForm = await fetch(`${API}/api/entry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"x":1}' })
  assert.ok([400, 415].includes(notForm.status), String(notForm.status))
  const badJson = await fetch(`${API}/api/entry/some-slug`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: 'not json' })
  assert.equal(badJson.status, 400)
  const unknown = await fetch(`${API}/api/nope/at/all`)
  assert.ok(unknown.status >= 400 && unknown.status < 500)
  assert.equal((await fetch(`${API}/api/health`)).status, 200, 'worker still healthy afterwards')
})

console.log('\n\x1b[1mAdmin and live-pad passwords\x1b[0m')
await test('admin list is locked without the key and open with it', async () => {
  const key = process.env.ADMIN_KEY
  const none = await fetch(`${API}/api/admin/entries`)
  assert.equal(none.status, 401)
  const wrong = await fetch(`${API}/api/admin/entries`, { headers: { Authorization: 'Bearer definitely-wrong' } })
  assert.equal(wrong.status, 401)
  if (!key) {
    console.log('    (set ADMIN_KEY to also check the right key; skipped)')
    return
  }
  const ok = await fetch(`${API}/api/admin/entries`, { headers: { Authorization: `Bearer ${key}` } })
  assert.equal(ok.status, 200)
})

await test('live pad password: set, change with the current hash, refuse without it', async () => {
  const { createHash } = await import('node:crypto')
  const h = (pw, salt) => createHash('sha256').update(`${pw}:${salt}`).digest('hex')
  const { slug } = await (await fetch(`${API}/api/live/new-slug`)).json()
  const set = (body) => fetch(`${API}/api/live/${slug}/security`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await set({ isProtected: true, salt: 'salt-a', authHash: h('first-pass', 'salt-a') })).status, 200)
  const salt = (await (await fetch(`${API}/api/live/${slug}`)).json()).salt
  assert.equal(salt, 'salt-a')
  // The worker lets an empty room be reset without a password, so put content in it first
  await fetch(`${API}/api/live/${slug}/seed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'locked content' }) })
  const refused = await set({ isProtected: true, salt: 'salt-b', authHash: h('second-pass', 'salt-b'), currentHash: h('not-the-pass', 'salt-a') })
  assert.equal(refused.status, 403)
  const changed = await set({ isProtected: true, salt: 'salt-b', authHash: h('second-pass', 'salt-b'), currentHash: h('first-pass', 'salt-a') })
  assert.equal(changed.status, 200)
  assert.equal((await (await fetch(`${API}/api/live/${slug}`)).json()).salt, 'salt-b')
  const removed = await set({ isProtected: false, currentHash: h('second-pass', 'salt-b') })
  assert.equal(removed.status, 200)
  assert.equal((await (await fetch(`${API}/api/live/${slug}`)).json()).isProtected, false)
})

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
