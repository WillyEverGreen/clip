/**
 * Large-file flow in a real browser, through the real upload screen, against the real bucket.
 *   worker:   cd worker && npx wrangler dev --local --port 8787
 *   frontend: cd frontend && npx vite --port 5199
 *   run:      node scripts/e2e-big-browser.mjs
 * Creates files of 30 MB and 110 MB (sparse, in the temp folder) and deletes everything it uploads.
 */
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const UI = process.env.UI || 'http://localhost:5199'
const MB = 1024 * 1024
const dir = join(tmpdir(), 'clip-big-e2e')
mkdirSync(dir, { recursive: true })
const makeFile = (name, mb) => {
  const path = join(dir, name)
  if (!existsSync(path) || readFileSync(path).length !== mb * MB) writeFileSync(path, randomBytes(mb * MB))
  return path
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

const browser = await chromium.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
let passed = 0
let failed = 0
let n = 0
async function test(name, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  // Locally the page and worker share an origin, so a fake client address is fine; against the live site the real one is used
  if (/localhost|127\.0\.0\.1/.test(UI)) await ctx.setExtraHTTPHeaders({ 'CF-Connecting-IP': `10.71.${Math.floor(Math.random() * 250)}.${++n % 250}` })
  const page = await ctx.newPage()
  const problems = []
  page.on('pageerror', (e) => problems.push(String(e)))
  try { await fn(page); if (problems.length) throw new Error('page errors: ' + problems.join(' | ')); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  catch (err) { failed++; console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.stack || err}`); await page.screenshot({ path: join(dir, `fail-${n}.png`) }).catch(() => undefined) }
  finally { await ctx.close() }
}
async function openFileTab(page) {
  await page.goto(UI + '/'); await page.waitForTimeout(800)
  await page.getByRole('button', { name: /^File$/ }).click()
}
const pick = (page, path) => page.locator('input[type=file]').first().setInputFiles(path)

console.log('\nLarge files in the browser')

await test('a 30 MB file: the upload screen accepts it, offers only 1h/6h/1 day, uploads, and the download page works', async (page) => {
  const path = makeFile('big30.bin', 30)
  await openFileTab(page)
  await pick(page, path)
  await page.getByText('big30.bin').first().waitFor()
  const options = await page.locator('select[aria-label=Expiration] option').allInnerTexts()
  assert.deepEqual(options, ['1 Hour', '6 Hours (Default)', '1 Day'])
  await page.locator('select[aria-label=Expiration]').selectOption('3600')
  await page.getByRole('button', { name: /Create Link/ }).click()
  await page.waitForURL(/\/b\/[a-z2-9]{10}$/, { timeout: 120_000 })
  const slug = page.url().split('/b/')[1]
  await page.getByTestId('big-name').waitFor()
  assert.equal(await page.getByTestId('big-name').innerText(), 'big30.bin')
  assert.match(await page.locator('body').innerText(), /30(\.0)? MB/)
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.getByTestId('big-download').click()])
  const saved = await download.path()
  assert.equal(sha(readFileSync(saved)), sha(readFileSync(path)), 'downloaded file differs')
  assert.equal(download.suggestedFilename(), 'big30.bin')
  assert.equal(await page.getByTestId('big-delete').count(), 1, 'the sender should see Delete now')
  // a different visitor (no token) sees the file but cannot delete it
  const other = await page.context().browser().newContext()
  const p2 = await other.newPage()
  await p2.goto(`${UI}/b/${slug}`); await p2.getByTestId('big-name').waitFor()
  assert.equal(await p2.getByTestId('big-delete').count(), 0, 'a visitor must not see Delete now')
  assert.match(await p2.evaluate(() => document.querySelector('meta[name=robots]')?.content ?? ''), /noindex/)
  await other.close()
  page.once('dialog', (d) => d.accept())
  await page.getByTestId('big-delete').click()
  await page.getByText('File deleted').waitFor()
  await page.reload()
  await page.getByText('This file is gone').waitFor()
})

await test('a 110 MB file goes up in parts with a moving progress bar and downloads identical', async (page) => {
  const path = makeFile('big110.bin', 110)
  await openFileTab(page)
  await pick(page, path)
  await page.getByText('big110.bin').first().waitFor()
  await page.getByRole('button', { name: /Create Link/ }).click()
  const seen = new Set()
  const deadline = Date.now() + 240_000
  while (!/\/b\//.test(page.url()) && Date.now() < deadline) {
    const pct = await page.evaluate(() => { const el = [...document.querySelectorAll('div,span')].find((e) => e.children.length === 0 && /^\d{1,3}%$/.test(e.textContent.trim())); return el ? el.textContent.trim() : null }).catch(() => null)
    if (pct !== null) seen.add(parseInt(pct, 10))
    await page.waitForTimeout(250)
  }
  assert.match(page.url(), /\/b\/[a-z2-9]{10}$/)
  assert.ok(seen.size >= 2, `progress never moved: ${[...seen]}`)
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.getByTestId('big-download').click()])
  assert.equal(sha(readFileSync(await download.path())), sha(readFileSync(path)))
  page.once('dialog', (d) => d.accept())
  await page.getByTestId('big-delete').click()
  await page.getByText('File deleted').waitFor()
})

await test('files over 500 MB, several files with a large one, and password lock are refused with a clear message', async (page) => {
  await openFileTab(page)
  // 600 MB: a sparse file would still be read by the browser lazily, so only its size matters
  const huge = join(dir, 'huge.bin')
  if (!existsSync(huge)) { const fd = (await import('node:fs')).openSync(huge, 'w'); (await import('node:fs')).ftruncateSync(fd, 600 * MB); (await import('node:fs')).closeSync(fd) }
  await pick(page, huge)
  await page.getByText(/is over 500/).waitFor()
  await pick(page, [makeFile('big30.bin', 30), makeFile('small1.bin', 1)])
  await page.getByText(/shared on its own/).waitFor()
  await pick(page, makeFile('big30.bin', 30))
  await page.getByText('big30.bin').first().waitFor()
  await page.getByText('Encrypt paste').click()
  await page.getByPlaceholder('View password...').fill('secret1')
  await page.getByRole('button', { name: /Create Link/ }).click()
  await page.getByText(/Password lock is not available/).waitFor()
})

await test('a normal file under 25 MB still uses the usual share flow', async (page) => {
  await openFileTab(page)
  await pick(page, makeFile('small1.bin', 1))
  await page.getByText('small1.bin').first().waitFor()
  await page.getByPlaceholder('Secret edit code').fill('1234')
  await page.getByRole('button', { name: /Create Link/ }).click()
  await page.waitForURL((u) => !/\/b\//.test(u.pathname) && u.pathname !== '/' && !u.pathname.includes('/b/'), { timeout: 30_000 })
  assert.ok(!page.url().includes('/b/'), page.url())
})

await test('a link that never existed shows the friendly page, not a blank screen', async (page) => {
  await page.goto(UI + '/b/abcdefghij')
  await page.getByText('This file is gone').waitFor({ timeout: 15_000 })
})

await browser.close()
console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed) process.exit(1)
