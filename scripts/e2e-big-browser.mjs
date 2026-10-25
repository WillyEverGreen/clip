/**
 * Sharing files of any size and number through the real pages, against the real file bucket.
 *   worker:   cd worker && npx wrangler dev --local --port 8787
 *   frontend: cd frontend && npx vite --port 5199
 *   run:      node scripts/e2e-big-browser.mjs      (or UI=https://clip.foo.ng for the live site)
 * Downloads count against the bucket's daily download allowance: when that is used up, the page must say so clearly,
 * and the byte-for-byte download check is reported as SKIPPED.
 */
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, openSync, ftruncateSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from '../frontend/node_modules/fflate/esm/index.mjs'

const UI = process.env.UI || 'http://localhost:5199'
const LOCAL = /localhost|127\.0\.0\.1/.test(UI)
const MB = 1024 * 1024
const dir = join(tmpdir(), 'clip-big-e2e')
mkdirSync(dir, { recursive: true })
const makeFile = (name, bytes) => {
  const path = join(dir, name)
  if (!existsSync(path) || readFileSync(path).length !== bytes) writeFileSync(path, randomBytes(bytes))
  return path
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

const browser = await chromium.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
let passed = 0
let failed = 0
let skipped = 0
let n = 0
async function test(name, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  // Locally the page and worker share an origin, so a fake client address is fine; against the live site the real one is used
  if (LOCAL) await ctx.setExtraHTTPHeaders({ 'CF-Connecting-IP': `10.71.${Math.floor(Math.random() * 250)}.${++n % 250}` })
  const page = await ctx.newPage()
  const problems = []
  page.on('pageerror', (e) => problems.push(String(e)))
  try {
    const r = await fn(page)
    if (problems.length) throw new Error('page errors: ' + problems.join(' | '))
    if (r === 'skip') { skipped++; console.log(`  \x1b[33m-\x1b[0m ${name} (SKIPPED: daily download allowance used up)`) }
    else { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  } catch (err) {
    failed++
    console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.stack || err}`)
    await page.screenshot({ path: join(dir, `fail-${n}.png`), fullPage: true }).catch(() => undefined)
  } finally { await ctx.close() }
}
async function openFileTab(page) {
  await page.goto(UI + '/'); await page.waitForTimeout(800)
  await page.getByRole('button', { name: /^File$/ }).click()
}
const pick = (page, paths) => page.locator('input[type=file]').first().setInputFiles(paths)
const slugFor = (p) => `${p}-${Date.now().toString(36)}`
const created = []
async function deleteClip(slug) {
  const api = LOCAL ? UI : 'https://clip-worker.saibalkawade10.workers.dev'
  await fetch(`${api}/api/entry/${slug}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ editCode: 'code1234' }) }).catch(() => undefined)
}
async function unlockEditor(page, slug) {
  await page.goto(`${UI}/${slug}/edit`)
  await page.locator('input[type=password]').first().fill('code1234')
  await page.getByRole('button', { name: /Verify/ }).click()
}

const big = makeFile('set-video.bin', 30 * MB)
const small1 = makeFile('set-photo.bin', 1 * MB)
const small2 = makeFile('set-note.txt', 2000)
const mainSlug = slugFor('many')

console.log('\nAny number of files, up to 500 MB, on your own URL')

await test('three files (one over 25 MB) on a custom URL: uploaded straight, listed one by one on the clip page', async (page) => {
  await openFileTab(page)
  await pick(page, [big, small1, small2])
  await page.getByText('3 files selected').waitFor()
  assert.match(await page.locator('body').innerText(), /of 500(\.0)? MB/)
  await page.getByPlaceholder('your-custom-slug').fill(mainSlug)
  await page.getByPlaceholder('Secret edit code').fill('code1234')
  await page.getByRole('button', { name: /Create Link/ }).click()
  await page.waitForURL(new RegExp(`/${mainSlug}$`), { timeout: 180_000 })
  created.push(mainSlug)
  await page.getByTestId('bundle-files').waitFor({ timeout: 20_000 })
  const names = await page.getByTestId('bundle-file').allInnerTexts()
  assert.equal(names.length, 3)
  for (const want of ['set-video.bin', 'set-photo.bin', 'set-note.txt']) assert.ok(names.some((t) => t.includes(want)), want)
  assert.match(await page.locator('body').innerText(), /Auto-deletes in/)
  assert.ok(!/\.zip/i.test(names.join(' ')), 'no zip should appear in the list')
})

await test('one file downloads identical; "Download all" packs every file into one zip (or the page explains the daily limit)', async (page) => {
  await page.goto(`${UI}/${mainSlug}`)
  await page.getByTestId('bundle-files').waitFor({ timeout: 20_000 })
  const row = page.getByTestId('bundle-file').filter({ hasText: 'set-note.txt' })
  const dl = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null)
  await row.getByRole('button', { name: /Download/ }).click()
  const notice = page.getByTestId('bundle-notice')
  const first = await Promise.race([dl, notice.waitFor({ timeout: 30_000 }).then(() => 'notice')])
  if (first === 'notice') {
    assert.match(await notice.innerText(), /daily download limit/)
    return 'skip'
  }
  assert.equal(sha(readFileSync(await first.path())), sha(readFileSync(small2)))
  const all = page.waitForEvent('download', { timeout: 120_000 })
  await page.getByTestId('bundle-download-all').click()
  const zip = await all
  assert.equal(zip.suggestedFilename(), `${mainSlug}-files.zip`)
  const entries = unzipSync(readFileSync(await zip.path()))
  assert.deepEqual(Object.keys(entries).sort(), ['set-note.txt', 'set-photo.bin', 'set-video.bin'])
  assert.equal(sha(entries['set-video.bin']), sha(readFileSync(big)))
})

await test('the owner adds files to the same URL later, and can remove one', async (page) => {
  await unlockEditor(page, mainSlug)
  await page.getByText(/Existing Files \(3\)/).waitFor({ timeout: 20_000 })
  await page.locator('input[type=file]').first().setInputFiles([makeFile('later-a.bin', 3 * MB), makeFile('later-b.txt', 500)])
  await page.getByRole('button', { name: /Save Changes/ }).click()
  await page.waitForURL(new RegExp(`/${mainSlug}$`), { timeout: 120_000 })
  await page.getByTestId('bundle-files').waitFor({ timeout: 20_000 })
  assert.equal(await page.getByTestId('bundle-file').count(), 5)
  // Remove one in the editor: tick it, then "Remove Selected"
  await unlockEditor(page, mainSlug)
  await page.getByText(/Existing Files \(5\)/).waitFor({ timeout: 20_000 })
  await page.getByText('set-photo.bin', { exact: true }).locator('xpath=ancestor::div[button[@title="Remove file"]][1]').locator('button[title="Remove file"]').click()
  await page.getByText(/Existing Files \(4\)/).waitFor()
  await page.getByRole('button', { name: /Save Changes/ }).click()
  await page.waitForURL(new RegExp(`/${mainSlug}$`), { timeout: 60_000 })
  await page.getByTestId('bundle-files').waitFor({ timeout: 20_000 })
  await page.waitForTimeout(500)
  const names = (await page.getByTestId('bundle-file').allInnerTexts()).join(' ')
  assert.equal(await page.getByTestId('bundle-file').count(), 4, names)
  assert.ok(!names.includes('set-photo.bin'), 'removed file still listed')
})

await test('a taken custom URL is caught before anything is uploaded', async (page) => {
  await openFileTab(page)
  await pick(page, [big])
  await page.getByPlaceholder('your-custom-slug').fill(mainSlug)
  await page.getByPlaceholder('Secret edit code').fill('code1234')
  const t0 = Date.now()
  await page.getByRole('button', { name: /Create Link/ }).click()
  await page.getByText(/already taken/).waitFor({ timeout: 10_000 })
  assert.ok(Date.now() - t0 < 8000, 'it should not have waited for an upload')
})

await test('over 500 MB in total, or password lock on a big set, is refused with a clear message', async (page) => {
  await openFileTab(page)
  const huge = join(dir, 'huge.bin')
  if (!existsSync(huge)) { const fd = openSync(huge, 'w'); ftruncateSync(fd, 600 * MB); closeSync(fd) }
  await pick(page, [huge])
  await page.getByText(/up to 500(\.0)? MB in total/).first().waitFor()
  await pick(page, [big])
  await page.getByText('set-video.bin').first().waitFor()
  await page.getByPlaceholder('Secret edit code').fill('code1234')
  await page.getByText('Encrypt paste').click()
  await page.getByPlaceholder('View password...').fill('secret1')
  await page.getByRole('button', { name: /Create Link/ }).click()
  await page.getByText(/Password lock works for files up to 50 MB/).waitFor()
})

await test('a small set of files still uses the normal flow (previews and all)', async (page) => {
  const slug = slugFor('small')
  await openFileTab(page)
  await pick(page, [small1, small2])
  await page.getByPlaceholder('your-custom-slug').fill(slug)
  await page.getByPlaceholder('Secret edit code').fill('code1234')
  await page.getByRole('button', { name: /Create Link/ }).click()
  await page.waitForURL(new RegExp(`/${slug}$`), { timeout: 60_000 })
  created.push(slug)
  await page.getByText(/Attached Files \(2\)/).waitFor({ timeout: 20_000 })
  assert.equal(await page.getByTestId('bundle-files').count(), 0)
  assert.ok((await page.getByRole('button', { name: /Preview/ }).count()) > 0, 'normal files keep their preview buttons')
})

for (const slug of created) await deleteClip(slug)
await browser.close()
console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped\n`)
if (failed) process.exit(1)
