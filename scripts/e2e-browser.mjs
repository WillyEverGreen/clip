// Browser end-to-end checks: drives the real UI in Chrome against the running dev site.
//
// Needs the site (Vite) and worker running locally:
//   npm run dev --prefix frontend      (serves http://localhost:5199, proxies /api to 8787)
//   cd worker && npx wrangler dev --port 8787
// Then: node scripts/e2e-browser.mjs
//
// Env: UI (default http://localhost:5199), CHROME (path to chrome.exe), ADMIN_KEY (optional, enables the admin check)
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const UI = process.env.UI || 'http://localhost:5199'
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SHOTS = join(tmpdir(), 'clip-e2e-browser')
mkdirSync(SHOTS, { recursive: true })

// 1x1 PNG, enough for the upload and the image preview
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const PNG_PATH = join(SHOTS, 'photo.png')
writeFileSync(PNG_PATH, PNG)

const rand = () => Math.random().toString(36).slice(2, 8)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
let failed = 0
const browser = await chromium.launch({ executablePath: CHROME, headless: true })

// The worker rate-limits creates per IP (10 per 2 minutes). Every browser context gets its own
// client IP so the suite is not throttled by its own volume. Local dev only: production sits behind
// Cloudflare, which sets this header itself.
let ipCounter = 1
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...opts })
  const ip = `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`
  await ctx.route('**/api/**', (route) =>
    route.continue({ headers: { ...route.request().headers(), 'CF-Connecting-IP': ip } }))
  const page = await ctx.newPage()
  page.setDefaultTimeout(10000)
  return { ctx, page }
}

async function test(name, fn) {
  if (process.env.ONLY && !name.toLowerCase().includes(process.env.ONLY.toLowerCase())) return
  const { ctx, page } = await newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  try {
    await fn(page)
    if (pageErrors.length) throw new Error(`uncaught page errors: ${pageErrors.join(' | ')}`)
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    const shot = join(SHOTS, `${name.replace(/[^a-z0-9]+/gi, '_')}.png`)
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {})
    console.log(`  ✗ ${name}\n    ${String(err.message || err).split('\n').slice(0, 3).join('\n    ')}\n    screenshot: ${shot}`)
  } finally {
    await ctx.close()
  }
}

// Visible text on the page, used for simple "is this shown" checks
async function expectText(page, text, timeout = 10000) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout })
}

// Wait until the page has moved off the home route, then return the slug
async function waitForSlug(page, timeout = 20000) {
  await page.waitForFunction(() => location.pathname.length > 1, null, { timeout })
  return new URL(page.url()).pathname.replace(/^\//, '')
}

// True when a fixed-position overlay (the file preview) is showing a decoded image.
// Plain page images such as the header logo are not in a fixed overlay, so they do not count.
const PREVIEW_OPEN = () => [...document.querySelectorAll('img')].some((i) => {
  if (!i.complete || i.naturalWidth === 0) return false
  for (let el = i; el; el = el.parentElement) {
    if (getComputedStyle(el).position === 'fixed') return i.offsetParent !== null
  }
  return false
})

// Create a text clip on the home page and return its slug (the path after the origin).
// The edit code is required by the form, so every clip gets one.
async function createTextClip(page, text, { slug, password, editCode = 'code1234' } = {}) {
  await page.goto(UI + '/')
  await page.getByPlaceholder(/Paste your text/).fill(text)
  if (slug) await page.getByPlaceholder('your-custom-slug').fill(slug)
  if (password) {
    await page.getByText('Encrypt paste').click()
    await page.getByPlaceholder(/password/i).first().fill(password)
  }
  await page.getByPlaceholder('Secret edit code').fill(editCode)
  await page.getByRole('button', { name: /Create (Clip|Link)/ }).click()
  return waitForSlug(page)
}

console.log('\nBrowser end-to-end')

console.log('\nText clips')
await test('create a text clip and see it on its page', async (page) => {
  const marker = 'browser text ' + rand()
  const slug = await createTextClip(page, marker)
  await page.goto(`${UI}/${slug}`)
  await expectText(page, marker)
})

await test('custom slug with invalid characters shows the hint', async (page) => {
  await page.goto(UI + '/')
  await page.getByPlaceholder('your-custom-slug').fill('Bad Slug!')
  await expectText(page, 'Only lowercase letters, numbers and hyphens are allowed.')
})

await test('custom slug is used as the URL', async (page) => {
  const slug = 'bt-' + rand()
  const got = await createTextClip(page, 'custom url body', { slug })
  if (got !== slug) throw new Error(`expected /${slug}, got /${got}`)
})

await await test('a slug that is already taken is refused', async (page) => {
  const slug = 'dup-' + rand()
  await createTextClip(page, 'first owner', { slug })
  await page.goto(UI + '/')
  await page.getByPlaceholder(/Paste your text/).fill('second owner')
  await page.getByPlaceholder('your-custom-slug').fill(slug)
  await page.getByPlaceholder('Secret edit code').fill('code1234')
  await page.getByRole('button', { name: /Create (Clip|Link)/ }).click()
  await expectText(page, /taken|already/i, 10000)
  if (new URL(page.url()).pathname !== '/') throw new Error('duplicate slug navigated away from the form')
})

await test('an unknown slug shows a not-found state, not a blank page', async (page) => {
  await page.goto(UI + '/nope-' + rand())
  await expectText(page, /not found|expired|doesn.t exist|gone/i, 10000)
})

await test('password-locked text clip needs the right password', async (page) => {
  const slug = await createTextClip(page, 'secret body ' + rand(), { password: 'pw1234' })
  const { ctx, page: viewer } = await newPage()
  try {
    await viewer.goto(`${UI}/${slug}`)
    await viewer.getByPlaceholder(/password/i).first().fill('wrong-pass')
    await viewer.getByRole('button', { name: 'Unlock' }).click()
    await expectText(viewer, 'Wrong password', 8000)
    await viewer.getByPlaceholder(/password/i).first().fill('pw1234')
    await viewer.getByRole('button', { name: 'Unlock' }).click()
    await expectText(viewer, 'secret body')
  } finally {
    await ctx.close()
  }
})

console.log('\nFiles')
await test('file clip: upload, see it, open the image preview', async (page) => {
  await page.goto(UI + '/')
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await page.locator('input[type=file]').first().setInputFiles(PNG_PATH)
  await page.getByPlaceholder('Secret edit code').fill('code1234')
  await page.getByRole('button', { name: /Create (Clip|Link)/ }).click()
  await waitForSlug(page)
  await expectText(page, 'photo.png')
  await page.getByRole('button', { name: 'Preview' }).first().click()
  // the preview must actually decode the image, not just open an empty frame
  await page.waitForFunction(PREVIEW_OPEN, null, { timeout: 10000 })
})

await test('paste a photo on the home page switches to File and lists it', async (page) => {
  await page.goto(UI + '/')
  // wait for the form to mount so the paste listener is attached before the event fires
  await page.getByPlaceholder(/Paste your text/).waitFor()
  const b64 = PNG.toString('base64')
  await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    const file = new File([bytes], 'pasted.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    // A real Ctrl+V lands on the focused element and bubbles to window, so dispatch on the body
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, b64)
  // Pasting stays on the home page: the file is added to the form and the File tab is shown
  await expectText(page, 'pasted.png')
  await expectText(page, '1 file selected')
})

console.log('\nEdit page')
await test('edit page refuses a wrong edit code', async (page) => {
  const slug = await createTextClip(page, 'guarded ' + rand(), { editCode: 'right1234' })
  await page.goto(`${UI}/${slug}/edit`)
  await page.getByPlaceholder(/edit code/i).first().fill('wrong9999')
  await page.getByRole('button', { name: 'Verify' }).click()
  await expectText(page, 'Incorrect edit code', 8000)
})

await test('edit a clip with its edit code and see the change saved', async (page) => {
  const code = 'edit' + rand()
  const slug = await createTextClip(page, 'before edit', { editCode: code })
  await page.goto(`${UI}/${slug}/edit`)
  await page.getByPlaceholder(/edit code/i).first().fill(code)
  await page.getByRole('button', { name: 'Verify' }).click()
  const body = page.locator('textarea').first()
  await body.waitFor({ state: 'visible', timeout: 8000 })
  await body.fill('after edit ' + rand())
  await page.getByRole('button', { name: 'Save Changes' }).click()
  await expectText(page, 'Saved', 8000).catch(() => {})
  await page.goto(`${UI}/${slug}`)
  await expectText(page, 'after edit')
})

console.log('\nLive Pad')
await test('/live creates a room and a second viewer sees live typing', async (page) => {
  await page.goto(UI + '/live')
  await page.waitForFunction(() => /^\/live\/[a-z0-9-]+$/.test(location.pathname), null, { timeout: 20000 })
  const liveUrl = page.url()
  const { ctx, page: other } = await newPage()
  try {
    await other.goto(liveUrl)
    const marker = 'live ' + rand()
    await page.locator('textarea').first().fill(marker)
    await expectText(other, marker, 10000)
  } finally {
    await ctx.close()
  }
})

await test('Live Pad file upload appears for a second viewer', async (page) => {
  await page.goto(UI + '/live')
  await page.waitForFunction(() => /^\/live\/[a-z0-9-]+$/.test(location.pathname), null, { timeout: 20000 })
  const liveUrl = page.url()
  const { ctx, page: other } = await newPage()
  try {
    await other.goto(liveUrl)
    await page.locator('input[type=file]').first().setInputFiles(PNG_PATH)
    await expectText(other, 'photo.png', 15000)
  } finally {
    await ctx.close()
  }
})

await test('Host LivePad from the Create page Live Pad mode', async (page) => {
  await page.goto(UI + '/')
  await page.getByRole('button', { name: 'Live Pad', exact: true }).click()
  await page.getByRole('button', { name: /Host LivePad/ }).click()
  await page.waitForFunction(() => /^\/live\/[a-z0-9-]+$/.test(location.pathname), null, { timeout: 20000 })
})

await test('Launch LivePad from an existing clip', async (page) => {
  const slug = await createTextClip(page, 'launch from clip ' + rand())
  await page.goto(`${UI}/${slug}`)
  await page.getByRole('button', { name: 'Host LivePad' }).click()
  await page.getByRole('button', { name: 'Launch LivePad' }).click()
  await page.waitForFunction(() => /^\/live\/[a-z0-9-]+$/.test(location.pathname), null, { timeout: 20000 })
  await expectText(page, 'launch from clip')
})

await test('Live Pad password: protect, then a viewer must unlock', async (page) => {
  await page.goto(UI + '/live')
  await page.waitForFunction(() => /^\/live\/[a-z0-9-]+$/.test(location.pathname), null, { timeout: 20000 })
  const liveUrl = page.url()
  await page.getByRole('button', { name: /Public|Protected/ }).first().click()
  await page.getByPlaceholder(/min 4 chars/).first().fill('room1234')
  await page.getByRole('button', { name: 'Set Password', exact: true }).click()
  const { ctx, page: other } = await newPage()
  try {
    await other.goto(liveUrl)
    await other.getByPlaceholder(/password/i).first().waitFor({ state: 'visible', timeout: 10000 })
  } finally {
    await ctx.close()
  }
})

console.log('\nLanding and layout')
await test('landing page CTA goes to the Live Pad', async (page) => {
  await page.goto(UI + '/about')
  await page.getByRole('link', { name: 'Start a live pad' }).first().click()
  await page.waitForFunction(() => location.pathname.startsWith('/live'), null, { timeout: 10000 })
})

await test('landing page film: the #film link scrolls to it and a real click plays it', async (page) => {
  await page.goto(UI + '/about#film')
  await page.locator('#film video').waitFor()
  await sleep(1200)
  const top = await page.evaluate(() => document.querySelector('#film').getBoundingClientRect().top)
  if (top < -10 || top > 220) throw new Error(`#film sits ${Math.round(top)}px from the top, so the link did not scroll to it`)
  const poster = await page.locator('#film video').getAttribute('poster')
  if (!poster) throw new Error('the film has no poster image')
  await page.locator('#film video').click()
  await page.waitForFunction(() => { const e = document.querySelector('#film video'); return !e.paused && e.currentTime > 0.5 && e.videoWidth > 0 }, null, { timeout: 12000 })
  // the timeline must be scrubbable: a video served without byte ranges plays but cannot be seeked
  await page.locator('#film video').evaluate((e) => { e.currentTime = 60 })
  await page.waitForFunction(() => document.querySelector('#film video').currentTime >= 60, null, { timeout: 12000 })
})

await test('landing nav: the Film link scrolls to the film', async (page) => {
  await page.goto(UI + '/about')
  await page.locator('.lp-nav a[href="#film"]').click()
  await sleep(2600)
  const top = await page.evaluate(() => document.querySelector('#film').getBoundingClientRect().top)
  if (top < -20 || top > 220) throw new Error(`#film sits ${Math.round(top)}px from the top after clicking Film`)
})

await test('app home: the Watch the film link opens the film on the landing page', async (page) => {
  await page.goto(UI + '/')
  await page.getByRole('link', { name: 'Watch the film' }).click()
  await page.waitForFunction(() => location.pathname === '/about' && location.hash === '#film', null, { timeout: 8000 })
  await sleep(1500)
  const top = await page.evaluate(() => document.querySelector('#film').getBoundingClientRect().top)
  if (top < -20 || top > 220) throw new Error(`#film sits ${Math.round(top)}px from the top after arriving from the home page`)
})

await test('home page has no horizontal scroll on a phone width', async (page) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await page.goto(UI + '/')
  await sleep(500)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  if (overflow > 1) throw new Error(`page is ${overflow}px wider than the screen`)
})

await test('landing page has no horizontal scroll on a phone width', async (page) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await page.goto(UI + '/about')
  await sleep(500)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  if (overflow > 1) throw new Error(`page is ${overflow}px wider than the screen`)
})

console.log('\nRemaining flows')
await test('wrong view password shows the exact message, right one unlocks', async (page) => {
  const slug = await createTextClip(page, 'exact msg ' + rand(), { password: 'pw5678' })
  const { ctx, page: viewer } = await newPage()
  try {
    await viewer.goto(`${UI}/${slug}`)
    await viewer.getByPlaceholder(/password/i).first().fill('nope0000')
    await viewer.getByRole('button', { name: 'Unlock' }).click()
    await expectText(viewer, 'Wrong password - please try again.', 8000)
    await viewer.getByPlaceholder(/password/i).first().fill('pw5678')
    await viewer.getByRole('button', { name: 'Unlock' }).click()
    await expectText(viewer, 'exact msg')
  } finally {
    await ctx.close()
  }
})

await test('expiry: a 10 minute clip shows a countdown on its page', async (page) => {
  await page.goto(UI + '/')
  await page.getByPlaceholder(/Paste your text/).fill('expires soon ' + rand())
  await page.getByPlaceholder('Secret edit code').fill('code1234')
  await page.getByRole('combobox').filter({ has: page.locator('option[value="600"]') }).selectOption('600')
  await page.getByRole('button', { name: /Create (Clip|Link)/ }).click()
  const slug = await waitForSlug(page)
  await page.goto(`${UI}/${slug}`)
  await expectText(page, /\d{2}:\d{2}(:\d{2})? remaining/, 10000)
  const text = await page.locator('body').innerText()
  const m = text.match(/(\d{2}):(\d{2})(?::(\d{2}))? remaining/)
  const mins = m[3] ? Number(m[1]) * 60 + Number(m[2]) : Number(m[1])
  if (mins > 10 || mins < 8) throw new Error(`10 minute clip shows ${m[0]}`)
})

await test('drag and drop a file onto the drop zone attaches it', async (page) => {
  await page.goto(UI + '/')
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await page.locator('.dropzone').first().waitFor()
  const b64 = PNG.toString('base64')
  await page.locator('.dropzone').first().evaluate((el, data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }))
    el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }))
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, b64)
  await expectText(page, 'dropped.png', 10000)
  await expectText(page, '1 file selected')
})

await test('Live Pad: delete a file asks first; cancel keeps it, confirm removes it for everyone', async (page) => {
  await page.goto(UI + '/live')
  await page.waitForFunction(() => /^\/live\/[a-z0-9-]+$/.test(location.pathname), null, { timeout: 20000 })
  const liveUrl = page.url()
  const { ctx, page: other } = await newPage()
  try {
    await other.goto(liveUrl)
    await page.locator('input[type=file]').first().setInputFiles(PNG_PATH)
    await expectText(other, 'photo.png', 15000)
    // cancel the confirm: file must stay
    other.once('dialog', (d) => d.dismiss())
    await other.getByText('photo.png').first().click()
    await other.getByTitle('Delete file').click()
    await sleep(800)
    await expectText(other, 'photo.png')
    // confirm: file must go for both viewers
    other.once('dialog', (d) => d.accept())
    await other.getByTitle('Delete file').click()
    await page.getByText('photo.png').first().waitFor({ state: 'detached', timeout: 15000 })
    await other.getByText('photo.png').first().waitFor({ state: 'detached', timeout: 15000 })
  } finally {
    await ctx.close()
  }
})

await test('creating clips past the limit shows the rate-limit message', async (page) => {
  // one context keeps one client IP, so the 11th create in a row is limited
  await page.goto(UI + '/')
  let limited = false
  for (let i = 0; i < 12 && !limited; i++) {
    await page.goto(UI + '/')
    await page.getByPlaceholder(/Paste your text/).fill('burst ' + i)
    await page.getByPlaceholder('Secret edit code').fill('code1234')
    await page.getByRole('button', { name: /Create (Clip|Link)/ }).click()
    await sleep(700)
    limited = await page.getByText('Too many clips created from this network').isVisible()
  }
  if (!limited) throw new Error('no rate-limit message after 12 rapid creates')
})

console.log('\nPhone width')
for (const [name, url] of [['create page', '/'], ['live pad', '/live'], ['about page', '/about']]) {
  await test(`${name} has no horizontal scroll at 375px`, async (page) => {
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto(UI + url)
    await sleep(700)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    if (overflow > 1) throw new Error(`${overflow}px wider than the screen`)
  })
}

console.log('\nEdge cases: validation')
await test('empty content is refused with a clear message', async (page) => {
  await page.goto(UI + '/')
  await page.getByPlaceholder('Secret edit code').fill('code1234')
  await page.getByRole('button', { name: /Create (Clip|Link)/ }).click()
  await expectText(page, 'Please add some content or upload a file.', 8000)
  if (new URL(page.url()).pathname !== '/') throw new Error('navigated away with empty content')
})

await test('edit code shorter than 4 characters is refused', async (page) => {
  await page.goto(UI + '/')
  await page.getByPlaceholder(/Paste your text/).fill('short code body')
  await page.getByPlaceholder('Secret edit code').fill('abc')
  await page.getByRole('button', { name: /Create (Clip|Link)/ }).click()
  // the browser blocks the submit with its own validation bubble; the field must say it is too short
  const tooShort = await page.getByPlaceholder('Secret edit code').evaluate((el) => el.validity.tooShort)
  if (!tooShort) throw new Error('3-character edit code was not flagged as too short')
  if (new URL(page.url()).pathname !== '/') throw new Error('form submitted with a short edit code')
})

await test('view password shorter than 4 characters is refused', async (page) => {
  await page.goto(UI + '/')
  await page.getByPlaceholder(/Paste your text/).fill('short pw body')
  await page.getByText('Encrypt paste').click()
  await page.getByPlaceholder(/password/i).first().fill('ab')
  await page.getByPlaceholder('Secret edit code').fill('code1234')
  await page.getByRole('button', { name: /Create (Clip|Link)/ }).click()
  const tooShort = await page.getByPlaceholder(/password/i).first().evaluate((el) => el.validity.tooShort)
  if (!tooShort) throw new Error('2-character view password was not flagged as too short')
  if (new URL(page.url()).pathname !== '/') throw new Error('form submitted with a short view password')
})

console.log('\nEdge cases: content')
await test('script in a clip is shown as text and never runs', async (page) => {
  const marker = 'xss-' + rand()
  const payload = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>${marker}`
  const slug = await createTextClip(page, payload)
  let dialogs = 0
  page.on('dialog', (d) => { dialogs++; d.dismiss() })
  await page.goto(`${UI}/${slug}`)
  await expectText(page, marker)
  await sleep(500)
  const ran = await page.evaluate(() => window.__xss ?? null)
  if (ran !== null) throw new Error(`injected script ran (window.__xss=${ran})`)
  if (dialogs) throw new Error('a dialog opened from clip content')
  const raw = await page.evaluate(() => !!document.querySelector('img[src="x"][onerror]'))
  if (raw) throw new Error('raw injected element is in the DOM')
})

await test('Unicode and emoji survive a round trip', async (page) => {
  const text = 'Привет 世界 🚀 café naïve — “quotes” ' + rand()
  const slug = await createTextClip(page, text)
  await page.goto(`${UI}/${slug}`)
  await expectText(page, text)
})

await test('Markdown renders: bold and a code block', async (page) => {
  const marker = 'md-' + rand()
  const slug = await createTextClip(page, `**bold ${marker}**\n\n\`\`\`\ncode line\n\`\`\``)
  await page.goto(`${UI}/${slug}`)
  await page.locator('strong', { hasText: marker }).first().waitFor({ state: 'visible', timeout: 10000 })
  await expectText(page, 'code line')
})

await test('a permanent clip shows no countdown', async (page) => {
  await page.goto(UI + '/')
  await page.getByPlaceholder(/Paste your text/).fill('forever ' + rand())
  await page.getByPlaceholder('Secret edit code').fill('code1234')
  await page.getByRole('combobox').filter({ has: page.locator('option[value="permanent"]') }).selectOption('permanent')
  await page.getByRole('button', { name: /Create (Clip|Link)/ }).click()
  const slug = await waitForSlug(page)
  await page.goto(`${UI}/${slug}`)
  await expectText(page, 'forever')
  const text = await page.locator('body').innerText()
  if (/\d{2}:\d{2}(:\d{2})? remaining/.test(text)) throw new Error('permanent clip shows a countdown')
})

console.log('\nEdge cases: Live Pad and dialogs')
await test('two people typing into a Live Pad converge on the same text', async (page) => {
  await page.goto(UI + '/live')
  await page.waitForFunction(() => /^\/live\/[a-z0-9-]+$/.test(location.pathname), null, { timeout: 20000 })
  const liveUrl = page.url()
  const { ctx, page: other } = await newPage()
  try {
    await other.goto(liveUrl)
    await other.locator('textarea').first().waitFor()
    const a = 'alpha-' + rand()
    const b = 'beta-' + rand()
    await page.locator('textarea').first().click()
    await page.keyboard.type(a + ' ')
    await other.locator('textarea').first().click()
    await other.keyboard.type(b)
    await expectText(page, b, 10000)
    await expectText(other, a, 10000)
    const x = await page.locator('textarea').first().inputValue()
    const y = await other.locator('textarea').first().inputValue()
    if (x !== y) throw new Error(`texts diverged:\n  A: ${x}\n  B: ${y}`)
  } finally {
    await ctx.close()
  }
})

await test('Escape closes the file preview', async (page) => {
  await page.goto(UI + '/')
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await page.locator('input[type=file]').first().setInputFiles(PNG_PATH)
  await page.getByPlaceholder('Secret edit code').fill('code1234')
  await page.getByRole('button', { name: /Create (Clip|Link)/ }).click()
  await waitForSlug(page)
  await page.getByRole('button', { name: 'Preview' }).first().click()
  await page.waitForFunction(PREVIEW_OPEN, null, { timeout: 10000 })
  await page.keyboard.press('Escape')
  for (let i = 0; i < 25 && (await page.evaluate(PREVIEW_OPEN)); i++) await sleep(200)
  if (await page.evaluate(PREVIEW_OPEN)) throw new Error('Escape did not close the preview')
})

if (process.env.ADMIN_KEY) {
  await test('admin panel opens with the admin key', async (page) => {
    await page.goto(UI + '/admin')
    await page.getByPlaceholder(/key|secret|password/i).first().fill(process.env.ADMIN_KEY)
    await page.getByRole('button', { name: /unlock|enter|sign in|continue/i }).first().click()
    await expectText(page, 'clips', 10000)
  })
} else {
  console.log('  - admin panel check skipped (set ADMIN_KEY to run it)')
}

await browser.close()
console.log(`\n  ${passed} passed, ${failed} failed`)
if (failed) console.log(`  screenshots of failures: ${SHOTS}`)
process.exit(failed ? 1 : 0)
