// Clip Beam browser end-to-end: two real Chrome pages send files to each other over WebRTC.
//
// Needs the site (Vite) and worker running locally:
//   npm run dev --prefix frontend      (serves http://localhost:5199, proxies /api to 8787)
//   cd worker && npx wrangler dev --port 8787
// Then: node scripts/e2e-beam-browser.mjs
//
// Env: UI (default http://localhost:5199), CHROME (path to chrome.exe), BEAM_MB (size of the big
// transfer, default 300)
//
// The save dialog cannot be clicked in a headless browser, so the receiver's showSaveFilePicker is
// pointed at the Origin Private File System instead. That is the same streaming
// FileSystemWritableFileStream the real dialog returns, just in a folder the test can read back.
import { chromium } from 'playwright-core'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const UI = process.env.UI || 'http://localhost:5199'
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BIG_MB = Number(process.env.BEAM_MB || 300)
const DIR = join(tmpdir(), 'clip-e2e-beam')
mkdirSync(DIR, { recursive: true })

let passed = 0
let failed = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Writes `mb` MB of non-repeating bytes and returns its path and SHA-256. */
async function makeFile(name, mb) {
  const path = join(DIR, name)
  const hash = createHash('sha256')
  const out = createWriteStream(path)
  const block = randomBytes(1024 * 1024)
  for (let i = 0; i < mb; i++) {
    block.writeUInt32LE(i, (i * 4096) % (block.length - 4)) // every MB differs
    hash.update(block)
    if (!out.write(block)) await new Promise((r) => out.once('drain', r))
  }
  await new Promise((r) => out.end(r))
  return { path, name, size: statSync(path).size, sha256: hash.digest('hex') }
}

// Host candidates are hidden behind mDNS names by default; headless Chrome cannot always resolve them
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
})

const SAVE_TO_OPFS = () => {
  window.showSaveFilePicker = async ({ suggestedName } = {}) => {
    window.__beamPicked = suggestedName
    const root = await navigator.storage.getDirectory()
    return root.getFileHandle(suggestedName, { create: true })
  }
}

const NO_SAVE_PICKER = () => {
  delete window.showSaveFilePicker
  Object.defineProperty(window, 'showSaveFilePicker', { value: undefined })
}

/** Makes this browser unreachable over WebRTC: no ICE candidates go out or come in. */
const BLOCK_ICE = () => {
  const strip = (sdp) => sdp.split('\r\n').filter((l) => !l.startsWith('a=candidate')).join('\r\n')
  const P = RTCPeerConnection.prototype
  Object.defineProperty(P, 'onicecandidate', { configurable: true, get() { return null }, set() {} })
  P.addIceCandidate = async () => {}
  const setRemote = P.setRemoteDescription
  P.setRemoteDescription = function (d) { return setRemote.call(this, d && d.sdp ? { type: d.type, sdp: strip(d.sdp) } : d) }
  const localDesc = Object.getOwnPropertyDescriptor(P, 'localDescription')
  Object.defineProperty(P, 'localDescription', {
    configurable: true,
    get() {
      const d = localDesc.get.call(this)
      return d && { type: d.type, sdp: strip(d.sdp), toJSON() { return { type: d.type, sdp: strip(d.sdp) } } }
    },
  })
}

async function newPage(init, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 860 }, acceptDownloads: true, ...opts })
  for (const script of [].concat(init || [])) await ctx.addInitScript(script)
  const page = await ctx.newPage()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(UI + '/beam')
  return { ctx, page, errors }
}

async function test(name, fn) {
  const opened = []
  const open = async (init, opts) => { const p = await newPage(init, opts); opened.push(p); return p }
  try {
    await fn(open)
    const errs = opened.flatMap((p) => p.errors)
    if (errs.length) throw new Error(`uncaught page errors: ${errs.join(' | ')}`)
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    for (const [i, p] of opened.entries()) {
      await p.page.screenshot({ path: join(DIR, `${name.replace(/[^a-z0-9]+/gi, '_')}_${i}.png`), fullPage: true }).catch(() => {})
    }
    console.log(`  ✗ ${name}\n    ${String(err.message || err).split('\n').slice(0, 4).join('\n    ')}\n    screenshots: ${DIR}`)
  } finally {
    for (const p of opened) await p.ctx.close().catch(() => {})
  }
}

const phase = (page) => page.locator('.beam-page').getAttribute('data-beam-phase')
async function waitPhase(page, want, timeout = 20000) {
  const wants = [].concat(want)
  await page.waitForFunction(
    (w) => w.includes(document.querySelector('.beam-page')?.getAttribute('data-beam-phase')),
    wants, { timeout },
  )
}

/** Sender picks the file, returns the PIN it is shown. */
async function startSending(page, file) {
  await page.setInputFiles('input[type=file]', file.path)
  const pinEl = page.getByTestId('beam-pin')
  await pinEl.waitFor()
  return (await pinEl.innerText()).replace(/\D/g, '')
}

async function joinWithPin(page, pin) {
  await page.locator('#beam-pin').fill(`${pin.slice(0, 3)} ${pin.slice(3)}`)
  await page.getByRole('button', { name: 'Connect' }).click()
}

const progressValue = (page) => page.locator('[role=progressbar]').getAttribute('aria-valuenow').then(Number).catch(() => -1)

/** SHA-256 of a file the receiver saved into its private file system. */
async function opfsSha256(page, name) {
  return page.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory()
    const file = await (await root.getFileHandle(n)).getFile()
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    return { size: file.size, sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') }
  }, name)
}

console.log(`\nClip Beam browser e2e (${UI}, ${BIG_MB} MB file)`)
const big = await makeFile(`beam-big-${BIG_MB}mb.bin`, BIG_MB)
const small = await makeFile('beam-small-24mb.bin', 24)

await test(`${BIG_MB} MB streams tab to tab, straight to disk, with progress on both ends and a matching SHA-256`, async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  const pin = await startSending(sender.page, big)
  if (!/^\d{6}$/.test(pin)) throw new Error(`bad PIN shown: ${pin}`)

  await joinWithPin(receiver.page, pin)
  await receiver.page.getByText(big.name).waitFor()
  await receiver.page.getByText('300.0 MB').or(receiver.page.getByText(big.name)).first().waitFor()
  await waitPhase(sender.page, 'joined')
  const t0 = Date.now()
  await receiver.page.getByRole('button', { name: /Accept and save/ }).click()

  // Watch progress on both sides until both finish
  const seen = { sender: new Set(), receiver: new Set() }
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    const [ps, pr, vs, vr] = await Promise.all([phase(sender.page), phase(receiver.page), progressValue(sender.page), progressValue(receiver.page)])
    if (vs >= 0) seen.sender.add(vs)
    if (vr >= 0) seen.receiver.add(vr)
    if (ps === 'error' || pr === 'error') {
      throw new Error(`transfer failed: sender="${await sender.page.locator('.beam-card').innerText()}" receiver="${await receiver.page.locator('.beam-card').innerText()}"`)
    }
    if (ps === 'done' && pr === 'done') break
    await sleep(250)
  }
  const secs = (Date.now() - t0) / 1000
  if ((await phase(sender.page)) !== 'done' || (await phase(receiver.page)) !== 'done') throw new Error('timed out')
  const mid = (s) => [...s].some((v) => v > 0 && v < 100)
  if (!mid(seen.sender) || !mid(seen.receiver)) {
    throw new Error(`no in-between progress shown: sender ${[...seen.sender]} receiver ${[...seen.receiver]}`)
  }

  for (const p of [sender.page, receiver.page]) {
    await p.getByText('SHA-256 verified on both ends').waitFor()
    const shown = await p.locator('.beam-hash').innerText()
    if (shown !== big.sha256) throw new Error(`page shows hash ${shown}, file is ${big.sha256}`)
  }
  if ((await receiver.page.evaluate(() => window.__beamPicked)) !== big.name) throw new Error('save picker was not offered the file name')
  const saved = await opfsSha256(receiver.page, big.name)
  if (saved.size !== big.size || saved.sha256 !== big.sha256) {
    throw new Error(`saved file differs: ${saved.size} bytes ${saved.sha256} vs ${big.size} bytes ${big.sha256}`)
  }
  console.log(`    ${BIG_MB} MB in ${secs.toFixed(1)}s (${(BIG_MB / secs).toFixed(0)} MB/s), progress samples: sender ${seen.sender.size}, receiver ${seen.receiver.size}`)
})

await test('browsers without the save dialog get the file as a normal download', async (open) => {
  const sender = await open()
  const receiver = await open(NO_SAVE_PICKER)
  await receiver.page.getByText('can receive up to').waitFor()
  const pin = await startSending(sender.page, small)
  await joinWithPin(receiver.page, pin)
  const downloadPromise = receiver.page.waitForEvent('download', { timeout: 60_000 })
  await receiver.page.getByRole('button', { name: /Accept and save/ }).click()
  const download = await downloadPromise
  if (download.suggestedFilename() !== small.name) throw new Error(`download named ${download.suggestedFilename()}`)
  const out = join(DIR, `downloaded-${small.name}`)
  await download.saveAs(out)
  const got = createHash('sha256').update(readFileSync(out)).digest('hex')
  if (got !== small.sha256) throw new Error('downloaded file does not match')
  await waitPhase(sender.page, 'done', 30_000)
  await receiver.page.getByText('saved to your downloads').waitFor()
})

await test('the QR code link joins straight away', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, small)
  await sender.page.getByRole('button', { name: /QR code/ }).click()
  await sender.page.locator('.beam-qr svg').waitFor()
  const receiver = await open(SAVE_TO_OPFS)
  await receiver.page.goto(`${UI}/beam?pin=${pin}`)
  await receiver.page.getByRole('button', { name: /Accept and save/ }).waitFor()
  if (receiver.page.url().includes('pin=')) throw new Error('PIN left in the address bar')
})

await test('a wrong PIN shows a clear error', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, small)
  const receiver = await open()
  await joinWithPin(receiver.page, String((Number(pin) + 1) % 1e6).padStart(6, '0'))
  await waitPhase(receiver.page, 'error')
  await receiver.page.getByText('No transfer is waiting on that PIN').waitFor()
  await receiver.page.getByRole('button', { name: 'Start over' }).click()
  await waitPhase(receiver.page, 'idle')
})

await test('declining tells the sender', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  await joinWithPin(receiver.page, await startSending(sender.page, small))
  await receiver.page.getByRole('button', { name: 'Decline' }).click()
  await waitPhase(sender.page, 'rejected')
  await sender.page.getByText('The receiver declined the file').waitFor()
})

await test('closing the receiver tab mid-transfer shows an error on the sender', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  await joinWithPin(receiver.page, await startSending(sender.page, big))
  await receiver.page.getByRole('button', { name: /Accept and save/ }).click()
  await waitPhase(receiver.page, 'transferring')
  await receiver.ctx.close()
  await waitPhase(sender.page, 'error', 30_000)
  await sender.page.getByText('disconnected before the transfer finished').waitFor()
})

await test('cancelling on the sender stops the receiver and discards the partial file', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  await joinWithPin(receiver.page, await startSending(sender.page, big))
  await receiver.page.getByRole('button', { name: /Accept and save/ }).click()
  await waitPhase(sender.page, 'transferring')
  await sender.page.getByRole('button', { name: 'Cancel' }).click()
  await waitPhase(sender.page, 'cancelled')
  await waitPhase(receiver.page, 'error')
  await receiver.page.getByText('cancelled the transfer').waitFor()
  await sleep(500)
  const size = await receiver.page.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory()
    return (await (await root.getFileHandle(n)).getFile()).size
  }, big.name)
  if (size !== 0) throw new Error(`partial file kept: ${size} bytes`)
})

await test('when the browsers cannot reach each other, both sides say the direct connection failed', async (open) => {
  const sender = await open()
  const receiver = await open([SAVE_TO_OPFS, BLOCK_ICE])
  await joinWithPin(receiver.page, await startSending(sender.page, small))
  await receiver.page.getByRole('button', { name: /Accept and save/ }).click()
  await waitPhase(receiver.page, 'peering')
  await Promise.all([waitPhase(sender.page, 'error', 45_000), waitPhase(receiver.page, 'error', 45_000)])
  for (const p of [sender.page, receiver.page]) await p.getByText('Could not open a direct connection').waitFor()
})

await test('phone width: no horizontal scroll on the start screen or while sharing a PIN', async (open) => {
  const { page } = await open(null, { viewport: { width: 375, height: 812 } })
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  if (await overflow()) throw new Error('start screen scrolls sideways')
  await startSending(page, small)
  if (await overflow()) throw new Error('PIN screen scrolls sideways')
})

await browser.close()
console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
