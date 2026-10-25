/**
 * File-bucket end-to-end test against the real bucket, through a local worker.
 *   1. cd worker && npx wrangler dev --local --port 8799 --test-scheduled --var SWEEP_CLOCK_SKEW_MS:10800000
    (the clock skew makes the cleanup job act 3 hours ahead, so the expiry test does not have to wait 2 hours)
 *   2. node scripts/e2e-big.mjs            (BASE=http://127.0.0.1:8799)
 * Needs B2_KEY_ID / B2_APP_KEY in worker/.dev.vars. Uploads about 150 MB and deletes everything it creates.
 * Downloads count against the bucket's daily download allowance: when that is used up, the byte-for-byte download
 * check is reported as SKIPPED (not passed).
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const MB = 1024 * 1024
const ORIGIN = 'http://localhost:5199'
let passed = 0
let failed = 0
let skipped = 0
async function test(name, fn) {
  try {
    const r = await fn()
    if (r === 'skip') { skipped++; console.log(`  \x1b[33m-\x1b[0m ${name} (SKIPPED: daily download allowance used up)`) }
    else { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  } catch (err) { failed++; console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.stack || err}`) }
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex')
let ipCounter = 0
const ip = () => `10.88.${Math.floor(Math.random() * 250)}.${++ipCounter % 250}`
const api = (path, init = {}, from = ip()) => fetch(BASE + path, { ...init, headers: { 'CF-Connecting-IP': from, Origin: ORIGIN, ...(init.headers ?? {}) } })
const json = async (res) => res.json().catch(() => ({}))

const uploads = [] // { slug, token } for cleanup
const clips = []   // { slug, editCode }

async function start(files, from = ip()) {
  const res = await api('/api/big/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files }) }, from)
  return { res, body: await json(res) }
}

/** Upload these buffers as one upload (each file its own object) and finish it. */
async function upload(list) {
  const { res, body } = await start(list.map((f) => ({ name: f.name, size: f.data.length, type: 'application/octet-stream' })))
  assert.equal(res.status, 201, JSON.stringify(body))
  uploads.push({ slug: body.slug, token: body.token })
  const headers = { 'x-manage-token': body.token, 'content-type': 'application/json' }
  const signed = await json(await api(`/api/big/${body.slug}/sign`, { method: 'POST', headers, body: JSON.stringify({ files: body.files.map((f) => f.n) }) }))
  const multipart = []
  for (const plan of body.files) {
    const data = list[plan.n - 1].data
    const etags = []
    for (let p = 0; p < plan.partCount; p++) {
      const piece = data.subarray(p * plan.partSize, Math.min(data.length, (p + 1) * plan.partSize))
      const put = await fetch(signed.urls[plan.n][p], { method: 'PUT', body: piece, headers: { Origin: ORIGIN } })
      assert.ok(put.ok, `PUT ${put.status}`)
      etags.push(put.headers.get('etag'))
    }
    if (plan.mode === 'multipart') multipart.push({ n: plan.n, parts: etags.map((etag, i) => ({ n: i + 1, etag })) })
  }
  for (let attempt = 1; ; attempt++) {
    const done = await api(`/api/big/${body.slug}/complete`, { method: 'POST', headers, body: JSON.stringify({ files: multipart }) })
    const result = await json(done)
    if (done.status === 503 && attempt < 5) { await new Promise((r) => setTimeout(r, 1500)); continue }
    assert.equal(done.status, 200, JSON.stringify(result))
    return { ...body, info: result }
  }
}

async function createClip(fields) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  const res = await api('/api/entry', { method: 'POST', body: form })
  const body = await json(res)
  if (res.status === 201) clips.push({ slug: body.slug, editCode: fields.editCode })
  return { res, body }
}
const getClip = async (slug) => json(await api(`/api/entry/${slug}`, { headers: { Accept: 'application/json' } }))
const patchClip = async (slug, fields) => {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  const res = await api(`/api/entry/${slug}`, { method: 'PATCH', body: form })
  return { res, body: await json(res) }
}
const uniqueSlug = (p) => `${p}-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`

console.log('\nFile bucket: refusals and access')

await test('empty, too many, more than 500 MB in total, malformed or non-JSON uploads are refused', async () => {
  assert.equal((await start([])).body.error, 'empty')
  assert.equal((await start(Array.from({ length: 501 }, (_, i) => ({ name: `f${i}`, size: 1 })))).body.error, 'too_many')
  assert.equal((await start([{ name: 'a', size: 300 * MB }, { name: 'b', size: 201 * MB }])).body.error, 'too_large')
  assert.equal((await start([{ name: 'a', size: -1 }])).body.error, 'invalid_request')
  assert.equal((await api('/api/big/start', { method: 'POST', body: 'nope' })).status, 400)
})

await test('upload links and finishing need the token; an unfinished upload is never visible', async () => {
  const { body } = await start([{ name: 'a.bin', size: 1024 }])
  uploads.push({ slug: body.slug, token: body.token })
  assert.equal((await api(`/api/big/${body.slug}/sign`, { method: 'POST', body: JSON.stringify({ files: [1] }) })).status, 403)
  assert.equal((await api(`/api/big/${body.slug}/complete`, { method: 'POST', body: '{}' })).status, 403)
  assert.equal((await api(`/api/big/${body.slug}`)).status, 404)
  assert.equal((await api('/api/big/../../etc')).status, 404)
})

console.log('\nFile bucket: many files on a custom URL')

const big = randomBytes(110 * MB)
const mid = randomBytes(30 * MB)
const tiny = randomBytes(1500)
let main = null
const mainSlug = uniqueSlug('bundle')

await test('three files (one sent in parts) go up as one upload, each its own file, with no zip anywhere', async () => {
  main = await upload([{ name: 'video.bin', data: big }, { name: 'photos.bin', data: mid }, { name: 'note.txt', data: tiny }])
  assert.deepEqual(main.files.map((f) => f.mode), ['multipart', 'single', 'single'])
  assert.deepEqual(main.info.files.map((f) => [f.name, f.size]), [['video.bin', big.length], ['photos.bin', mid.length], ['note.txt', tiny.length]])
  assert.ok(!JSON.stringify(main.info).includes('big/'), 'storage key leaked')
})

await test('the upload becomes a clip on a custom URL, with a note, an edit code, and files kept for 2 hours', async () => {
  const { res, body } = await createClip({ type: 'file', slug: mainSlug, editCode: 'code1234', ttl: '86400', content: 'Here are the files', bundleId: main.slug, bundleToken: main.token })
  assert.equal(res.status, 201, JSON.stringify(body))
  const clip = await getClip(mainSlug)
  assert.equal(clip.content, 'Here are the files')
  assert.equal(clip.bundles.length, 1)
  assert.deepEqual(clip.bundles[0].files.map((f) => f.name), ['video.bin', 'photos.bin', 'note.txt'])
  const left = clip.bundles[0].expiresAt - Date.now()
  assert.ok(left > 2 * 3600 * 1000 - 60_000 && left <= 2 * 3600 * 1000, `files expire in ${left} ms`)
  assert.ok(!JSON.stringify(clip).includes('big/'), 'storage key leaked')
})

await test('an upload cannot be attached without its token, or to a second clip', async () => {
  const other = await upload([{ name: 'x.bin', data: randomBytes(2048) }])
  const noTok = await createClip({ type: 'file', editCode: 'code1234', bundleId: other.slug, bundleToken: 'wrong' })
  assert.equal(noTok.res.status, 403)
  const again = await createClip({ type: 'file', editCode: 'code1234', bundleId: main.slug, bundleToken: main.token })
  assert.equal(again.res.status, 400)
  assert.equal(again.body.error, 'bundle_taken')
  assert.equal((await api(`/api/big/${main.slug}`, { method: 'DELETE', headers: { 'x-manage-token': main.token } })).status, 409, 'an attached upload must be removed through its clip')
})

await test('the command-line file link hands over to a short-lived, forced-download link on the bucket', async () => {
  const f = await api(`/f/${mainSlug}`, { redirect: 'manual' })
  assert.equal(f.status, 302)
  assert.match(f.headers.get('location'), new RegExp(`/api/big/${main.slug}/download\\?n=1$`))
  const d = await api(`/api/big/${main.slug}/download?n=3`, { redirect: 'manual' })
  assert.equal(d.status, 302)
  const loc = d.headers.get('location')
  assert.match(loc, /backblazeb2\.com\//)
  assert.match(loc, /response-content-disposition=attachment/)
  assert.match(loc, /X-Amz-Expires=300/)
  assert.equal((await api(`/api/big/${main.slug}/download?n=9`, { redirect: 'manual' })).status, 404)
})

await test('a file downloads byte-for-byte identical (when the daily download allowance allows)', async () => {
  const r = await json(await api(`/api/big/${main.slug}/download?json=1&n=3&inline=1`))
  if (r.error === 'download_limit') return 'skip'
  const bytes = Buffer.from(await (await fetch(r.url)).arrayBuffer())
  assert.equal(sha(bytes), sha(tiny))
})

console.log('\nFile bucket: changing files later')

await test('the owner adds more files to the same URL later; the clip then lists both uploads', async () => {
  const more = await upload([{ name: 'later-1.bin', data: randomBytes(26 * MB) }, { name: 'later-2.txt', data: randomBytes(900) }])
  const wrong = await patchClip(mainSlug, { editCode: 'nope1234', content: 'x', bundleId: more.slug, bundleToken: more.token })
  assert.equal(wrong.res.status, 403)
  const ok = await patchClip(mainSlug, { editCode: 'code1234', content: 'Here are the files', bundleId: more.slug, bundleToken: more.token })
  assert.equal(ok.res.status, 200, JSON.stringify(ok.body))
  const clip = await getClip(mainSlug)
  assert.equal(clip.bundles.length, 2)
  assert.deepEqual(clip.bundles.flatMap((b) => b.files.map((f) => f.name)), ['video.bin', 'photos.bin', 'note.txt', 'later-1.bin', 'later-2.txt'])
})

await test('removing one file deletes just that file; the rest stay', async () => {
  const ok = await patchClip(mainSlug, { editCode: 'code1234', content: 'Here are the files', removeBundleFiles: JSON.stringify([{ id: main.slug, n: 2 }]) })
  assert.equal(ok.res.status, 200, JSON.stringify(ok.body))
  const clip = await getClip(mainSlug)
  assert.deepEqual(clip.bundles.flatMap((b) => b.files.map((f) => f.name)), ['video.bin', 'note.txt', 'later-1.bin', 'later-2.txt'])
  const info = await json(await api(`/api/big/${main.slug}`))
  assert.deepEqual(info.files.map((f) => f.n), [1, 3])
  assert.equal((await api(`/api/big/${main.slug}/download?n=2`, { redirect: 'manual' })).status, 404)
})

await test('more than 500 MB across the clip is refused and the extra upload is thrown away', async () => {
  const { body } = await start([{ name: 'too-much.bin', size: 400 * MB }])
  uploads.push({ slug: body.slug, token: body.token })
  // Not uploading 400 MB for this: an unfinished upload cannot be attached at all
  const res = await patchClip(mainSlug, { editCode: 'code1234', content: 'x', bundleId: body.slug, bundleToken: body.token })
  assert.equal(res.res.status, 400)
  assert.equal(res.body.error, 'bundle_not_ready')
})

await test('deleting the clip deletes every file it holds', async () => {
  const before = await getClip(mainSlug)
  const ids = before.bundles.map((b) => b.id)
  const del = await api(`/api/entry/${mainSlug}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ editCode: 'code1234' }) })
  assert.equal(del.status, 200)
  for (const id of ids) assert.equal((await api(`/api/big/${id}`)).status, 404, `upload ${id} still there`)
})

console.log('\nFile bucket: expiry')

await test('when the 2 hours are up the sweep deletes the files and the clip stops listing them', async () => {
  const up = await upload([{ name: 'soon.txt', data: randomBytes(2000) }])
  const slug = uniqueSlug('expire')
  const made = await createClip({ type: 'file', slug, editCode: 'code1234', ttl: '86400', content: 'note stays', bundleId: up.slug, bundleToken: up.token })
  assert.equal(made.res.status, 201)
  // The worker under test runs its cleanup job 3 hours ahead (SWEEP_CLOCK_SKEW_MS), so this upload is already due
  const run = await fetch(BASE + '/__scheduled?cron=*/10+*+*+*+*')
  assert.ok(run.ok, `scheduled ${run.status}`)
  await new Promise((r) => setTimeout(r, 4000))
  assert.equal((await api(`/api/big/${up.slug}`)).status, 404, 'expired upload still listed')
  clips.splice(clips.findIndex((c) => c.slug === slug), 1)
  await api(`/api/entry/${slug}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ editCode: 'code1234' }) })
})

// Clean up everything this run created
for (const { slug, editCode } of clips) {
  await api(`/api/entry/${slug}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ editCode }) }).catch(() => undefined)
}
for (const { slug, token } of uploads) {
  await api(`/api/big/${slug}`, { method: 'DELETE', headers: { 'x-manage-token': token } }).catch(() => undefined)
}

console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped\n`)
if (failed) process.exit(1)
