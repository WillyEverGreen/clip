/**
 * Large-file end-to-end test against the real bucket, through a local worker.
 *   1. cd worker && npx wrangler dev --local --port 8799 --test-scheduled
 *   2. node scripts/e2e-big.mjs            (BASE=http://127.0.0.1:8799)
 * Needs B2_KEY_ID / B2_APP_KEY in worker/.dev.vars. Uploads about 150 MB and deletes everything it creates.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const MB = 1024 * 1024
const ORIGIN = 'http://localhost:5199'
let passed = 0
let failed = 0
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  catch (err) { failed++; console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.stack || err}`) }
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex')
let ipCounter = 0
const ip = () => `10.88.${Math.floor(Math.random() * 250)}.${++ipCounter % 250}`
const api = (path, init = {}, from = ip()) => fetch(BASE + path, { ...init, headers: { 'CF-Connecting-IP': from, Origin: ORIGIN, ...(init.headers ?? {}) } })
const json = async (res) => res.json()

const created = [] // { slug, token }
async function start(size, extra = {}, from = ip()) {
  const res = await api('/api/big/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'test file.bin', size, type: 'application/octet-stream', ...extra }) }, from)
  return { res, body: await json(res) }
}
async function putTo(url, data) {
  const res = await fetch(url, { method: 'PUT', body: data, headers: { Origin: ORIGIN } })
  assert.ok(res.ok, `PUT ${res.status} ${await res.text().catch(() => '')}`)
  return res.headers.get('etag')
}
async function uploadFile(data, extra = {}) {
  const { res, body } = await start(data.length, extra)
  assert.equal(res.status, 201, JSON.stringify(body))
  created.push({ slug: body.slug, token: body.token })
  const etags = []
  for (let i = 0; i < body.urls.length; i++) {
    const part = data.subarray(i * body.partSize, Math.min(data.length, (i + 1) * body.partSize))
    etags.push(await putTo(body.urls[i], part))
  }
  const done = await api(`/api/big/${body.slug}/complete`, {
    method: 'POST', headers: { 'x-manage-token': body.token, 'content-type': 'application/json' },
    body: JSON.stringify({ parts: body.mode === 'multipart' ? etags.map((etag, i) => ({ n: i + 1, etag })) : undefined }),
  })
  return { body, done, doneBody: await json(done) }
}
async function download(slug) {
  const res = await api(`/api/big/${slug}/download`, { redirect: 'manual' })
  assert.equal(res.status, 302, `download status ${res.status}`)
  const file = await fetch(res.headers.get('location'))
  assert.ok(file.ok, `storage GET ${file.status}`)
  return { file, bytes: Buffer.from(await file.arrayBuffer()) }
}

console.log('\nLarge files: validation and access')

await test('requests below 25 MB, above 500 MB, with a bad expiry or bad JSON are refused', async () => {
  assert.equal((await start(10 * MB)).body.error, 'too_small')
  assert.equal((await start(501 * MB)).body.error, 'too_large')
  assert.equal((await start(60 * MB, { ttl: 5 })).body.error, 'bad_ttl')
  const bad = await api('/api/big/start', { method: 'POST', body: 'not json' })
  assert.equal(bad.status, 400)
})

await test('unknown or malformed slugs are not found, and public info never shows a half-finished upload', async () => {
  assert.equal((await api('/api/big/zzzzzzzzzz')).status, 404)
  assert.equal((await api('/api/big/../../etc')).status, 404)
  const { body } = await start(30 * MB)
  created.push({ slug: body.slug, token: body.token })
  assert.equal((await api(`/api/big/${body.slug}`)).status, 404, 'an unfinished upload must not be visible')
  assert.equal((await api(`/api/big/${body.slug}/download`, { redirect: 'manual' })).status, 404)
})

await test('only the uploader (with the token) can finish or delete an upload', async () => {
  const { body } = await start(30 * MB)
  created.push({ slug: body.slug, token: body.token })
  const noTok = await api(`/api/big/${body.slug}/complete`, { method: 'POST', body: '{}' })
  assert.equal(noTok.status, 403)
  const wrong = await api(`/api/big/${body.slug}`, { method: 'DELETE', headers: { 'x-manage-token': 'wrong' } })
  assert.equal(wrong.status, 403)
})

await test('the rate limit slows someone starting many uploads', async () => {
  const same = ip()
  let limited = false
  for (let i = 0; i < 9; i++) {
    const { res, body } = await start(30 * MB, {}, same)
    if (res.status === 201) created.push({ slug: body.slug, token: body.token })
    if (res.status === 429) { limited = true; break }
  }
  assert.ok(limited, 'never rate limited')
})

console.log('\nLarge files: a real upload and download')

const small = randomBytes(30 * MB)
let smallSlug = null

await test('a 30 MB file uploads in one piece, is listed with the right details, and downloads identical', async () => {
  const { body, doneBody } = await uploadFile(small)
  assert.equal(body.mode, 'single')
  assert.equal(doneBody.status, 'ready')
  assert.equal(doneBody.size, small.length)
  smallSlug = body.slug
  const info = await json(await api(`/api/big/${body.slug}`))
  assert.equal(info.name, 'test file.bin')
  assert.ok(info.expiresAt > Date.now() && info.expiresAt <= Date.now() + 6 * 3600 * 1000 + 5000)
  assert.ok(!JSON.stringify(info).includes('big/'), 'storage key leaked')
  const { file, bytes } = await download(body.slug)
  assert.equal(bytes.length, small.length)
  assert.equal(sha(bytes), sha(small))
  assert.match(file.headers.get('content-disposition') ?? '', /^attachment; filename="test file\.bin"/)
  assert.equal(file.headers.get('content-type'), 'application/octet-stream')
})

await test('the browser permission check (CORS) on the bucket allows uploads from the site and exposes the ETag', async () => {
  const { body } = await start(30 * MB)
  created.push({ slug: body.slug, token: body.token })
  const pre = await fetch(body.urls[0], { method: 'OPTIONS', headers: { Origin: 'https://clip.foo.ng', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' } })
  assert.ok(pre.ok, `preflight ${pre.status}`)
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://clip.foo.ng')
  const evil = await fetch(body.urls[0], { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PUT' } })
  assert.notEqual(evil.headers.get('access-control-allow-origin'), 'https://evil.example')
})

await test('a 110 MB file goes up in two parts, is assembled, and downloads identical', async () => {
  const big = randomBytes(110 * MB)
  const { body, doneBody } = await uploadFile(big, { ttl: 3600 })
  assert.equal(body.mode, 'multipart'); assert.equal(body.urls.length, 2)
  assert.equal(doneBody.status, 'ready')
  const { bytes } = await download(body.slug)
  assert.equal(bytes.length, big.length)
  assert.equal(sha(bytes), sha(big))
})

await test('finishing with the wrong size is caught and the file is thrown away', async () => {
  const { body } = await start(40 * MB)
  created.push({ slug: body.slug, token: body.token })
  await putTo(body.urls[0], randomBytes(30 * MB)) // announced 40, sent 30
  const done = await api(`/api/big/${body.slug}/complete`, { method: 'POST', headers: { 'x-manage-token': body.token }, body: '{}' })
  assert.equal(done.status, 400)
  assert.equal((await json(done)).error, 'size_mismatch')
  assert.equal((await api(`/api/big/${body.slug}`)).status, 404)
})

console.log('\nLarge files: deleting')

await test('the uploader can delete early; afterwards the link is gone and the stored object is too', async () => {
  const entry = created.find((c) => c.slug === smallSlug)
  const del = await api(`/api/big/${smallSlug}`, { method: 'DELETE', headers: { 'x-manage-token': entry.token } })
  assert.equal(del.status, 200)
  assert.equal((await api(`/api/big/${smallSlug}`)).status, 404)
  assert.equal((await api(`/api/big/${smallSlug}/download`, { redirect: 'manual' })).status, 404)
})

await test('the scheduled sweep deletes files whose time is up (and leaves the others)', async () => {
  const keep = await uploadFile(randomBytes(26 * MB), { ttl: 86400 })
  const expire = await uploadFile(randomBytes(26 * MB), { ttl: 3600 })
  // Move one file's deadline into the past directly in the local store, then run the sweep
  const key = `big:${expire.body.slug}`
  const kv = (args) => execFileSync('npx', ['wrangler', 'kv', 'key', ...args, '--binding', 'PASTE_KV', '--local', '--preview', 'false'], { cwd: new URL('../worker', import.meta.url), shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const raw = kv(['get', key])
  const rec = JSON.parse(raw.slice(raw.indexOf('{')))
  rec.expiresAt = Date.now() - 1000
  const tmp = join(tmpdir(), `big-${rec.slug}.json`)
  writeFileSync(tmp, JSON.stringify(rec))
  kv(['put', key, '--path', tmp])
  unlinkSync(tmp)
  const run = await fetch(BASE + '/__scheduled?cron=*/10+*+*+*+*')
  assert.ok(run.ok, `scheduled ${run.status}`)
  await new Promise((r) => setTimeout(r, 4000))
  assert.equal((await api(`/api/big/${expire.body.slug}`)).status, 404, 'expired file is still listed')
  assert.equal((await api(`/api/big/${keep.body.slug}`)).status, 200, 'a file that has not expired was removed')
})

// Clean up everything this run created
for (const { slug, token } of created) {
  await api(`/api/big/${slug}`, { method: 'DELETE', headers: { 'x-manage-token': token } }).catch(() => undefined)
}

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed) process.exit(1)
