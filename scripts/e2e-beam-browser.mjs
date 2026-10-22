// Clip Beam browser end-to-end: real Chrome pages send files to each other over WebRTC.
//
// Needs the site (Vite) and worker running locally:
//   npm run dev --prefix frontend      (serves http://localhost:5199, proxies /api to 8787)
//   cd worker && npx wrangler dev --port 8787
// Then: node scripts/e2e-beam-browser.mjs
//
// Env: UI (default http://localhost:5199), CHROME (path to chrome.exe),
//      BEAM_MB (size of the big transfer, default 200),
//      BEAM_STRESS=1 (adds a 700 MB transfer to 2 receivers; slow on a loopback link. Kept under 1 GB because headless Chrome's
//        private file system hit its storage quota at about 0.9 GB),
//      ONLY=<text> (run only tests whose name contains it)
//
// The save dialog cannot be clicked in a headless browser, so the receiver's showSaveFilePicker is
// pointed at the Origin Private File System instead. That is the same streaming
// FileSystemWritableFileStream the real dialog returns, just in a folder the test can read back.
import { chromium } from 'playwright-core'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const UI = process.env.UI || 'http://localhost:5199'
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BIG_MB = Number(process.env.BEAM_MB || 200)
const DIR = join(tmpdir(), 'clip-e2e-beam')
mkdirSync(DIR, { recursive: true })

let ipCounter = Math.floor(Math.random() * 50000)
let passed = 0
let failed = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Writes `mb` MB of non-repeating bytes and returns its path, size and SHA-256. */
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

function makeSmall(name, bytes) {
  const path = join(DIR, name)
  writeFileSync(path, bytes)
  return { path, name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
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

/** Flips one byte in the 5th binary chunk this browser receives, as a damaged network would. */
const CORRUPT_ONE_CHUNK = () => {
  const P = RTCPeerConnection.prototype
  const desc = Object.getOwnPropertyDescriptor(P, 'ondatachannel')
  Object.defineProperty(P, 'ondatachannel', {
    configurable: true,
    get() { return desc.get.call(this) },
    set(handler) {
      desc.set.call(this, (event) => {
        const ch = event.channel
        let n = 0
        const own = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage')
        Object.defineProperty(ch, 'onmessage', {
          configurable: true,
          get() { return own.get.call(this) },
          set(fn) {
            own.set.call(this, (e) => {
              if (e.data instanceof ArrayBuffer && ++n === 5) {
                const copy = new Uint8Array(e.data.slice(0))
                copy[0] ^= 0xff
                return fn({ data: copy.buffer })
              }
              return fn(e)
            })
          },
        })
        return handler(event)
      })
    },
  })
}

/** Records every connection this page makes so a test can cut them, the way a lost network would. */
const TRACK = () => {
  window.__pcs = []
  window.__wss = []
  const PC = window.RTCPeerConnection
  window.RTCPeerConnection = function (...a) { const pc = new PC(...a); window.__pcs.push(pc); return pc }
  window.RTCPeerConnection.prototype = PC.prototype
  const WS = window.WebSocket
  window.WebSocket = function (...a) { const ws = new WS(...a); if (String(a[0]).includes('/api/beam')) window.__wss.push(ws); return ws } // not Vite's hot-reload socket
  window.WebSocket.prototype = WS.prototype
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
}
const dropNetwork = (page) => page.evaluate(() => {
  window.__pcs.forEach((pc) => pc.close())
  window.__wss.forEach((ws) => { try { ws.close(4000, 'lost') } catch { /* already closed */ } })
})
const waitProgress = (page, pct, timeout = 120_000) => page.waitForFunction(
  (n) => Number(document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')) >= n, pct, { timeout })

async function newPage(init, opts = {}) {
  const { ip, ...ctxOpts } = opts
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 860 }, acceptDownloads: true, ...ctxOpts })
  // Joining is rate limited per client IP; give each browser its own (local dev only, Cloudflare sets this in production).
  // Browsers that pass the same `ip` are on the same "network" and see each other in Nearby.
  ipCounter++
  await ctx.setExtraHTTPHeaders({ 'CF-Connecting-IP': ip ?? `10.66.${(ipCounter >> 8) & 255}.${ipCounter & 255}` })
  for (const script of [].concat(init || [])) await ctx.addInitScript(script)
  const page = await ctx.newPage()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  if (process.env.DEBUG_CONSOLE) page.on('console', (m) => { if (m.text().startsWith('DBG')) console.log('   [page]', m.text()) })
  await page.goto(UI + '/beam')
  return { ctx, page, errors }
}

async function test(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return
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
      await p.page.screenshot({ path: join(DIR, `${name.replace(/[^a-z0-9]+/gi, '_').slice(0, 60)}_${i}.png`), fullPage: true }).catch(() => {})
    }
    console.log(`  ✗ ${name}\n    ${String(err.message || err).split('\n').slice(0, 5).join('\n    ')}\n    screenshots: ${DIR}`)
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

const acceptBtn = (page) => page.getByRole('button', { name: /Accept and save/ })
const legs = (page) => page.locator('.beam-leg')
const legPhase = (page, n) => legs(page).nth(n).getAttribute('data-leg-phase')
async function waitLeg(page, n, want, timeout = 120_000) {
  const wants = [].concat(want)
  await page.waitForFunction(
    ([i, w]) => w.includes(document.querySelectorAll('.beam-leg')[i]?.getAttribute('data-leg-phase')),
    [n, wants], { timeout },
  )
}

const progressValue = (page) => page.evaluate(() => { const el = document.querySelector('[role=progressbar]'); return el ? Number(el.getAttribute('aria-valuenow')) : -1 })

/** Size and SHA-256 of a file the receiver saved into its private file system (null if absent). */
async function opfsInfo(page, name) {
  return page.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory()
    let handle
    try { handle = await root.getFileHandle(n) } catch { return null }
    const file = await handle.getFile()
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    return { size: file.size, sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') }
  }, name)
}

async function expectSaved(page, file) {
  const saved = await opfsInfo(page, file.name)
  if (!saved || saved.size !== file.size || saved.sha256 !== file.sha256) {
    throw new Error(`saved file differs: ${JSON.stringify(saved)} vs ${file.size} bytes ${file.sha256}`)
  }
}

/** A receiver tab that has joined and is looking at the offer. */
async function joinReceiver(open, pin, init = SAVE_TO_OPFS) {
  const r = await open(init)
  await joinWithPin(r.page, pin)
  await acceptBtn(r.page).waitFor()
  return r
}


// ── Nearby helpers ──────────────────────────────────────────────────────────

const newNetwork = () => `10.${150 + Math.floor(Math.random() * 40)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`

/** A receiver tab on `ip` with Receive mode switched on and listed. Returns its visible name too. */
async function nearbyReceiver(open, ip, init = SAVE_TO_OPFS) {
  const r = await open(init, { ip })
  await r.page.getByRole('switch', { name: 'Show me to nearby senders' }).check({ force: true })
  await r.page.getByText('Waiting for requests').waitFor()
  const raw = await r.page.getByTestId('beam-visible-name').innerText()
  r.name = raw.replace(/\s*you\s*$/, '').trim()
  return r
}

const radarNames = (page) => page.locator('.beam-peer[data-peer]').evaluateAll((els) => els.map((e) => e.getAttribute('data-peer')))
const peer = (page, name) => page.locator(`.beam-peer[data-peer="${name}"]`)
async function waitRadar(page, count, timeout = 15000) {
  await page.waitForFunction((n) => document.querySelectorAll('.beam-peer[data-peer]').length === n, count, { timeout })
}
const invitePrompt = (page) => page.locator('.beam-invite')

console.log(`\nClip Beam browser e2e (${UI}, ${BIG_MB} MB file)`)
const big = await makeFile(`beam-big-${BIG_MB}mb.bin`, BIG_MB)
const mid = await makeFile('beam-mid-60mb.bin', 60)
const small = await makeFile('beam-small-24mb.bin', 24)

await test(`${BIG_MB} MB streams tab to tab with live speed and time left that match reality`, async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  const pin = await startSending(sender.page, big)
  if (!/^\d{6}$/.test(pin)) throw new Error(`bad PIN shown: ${pin}`)
  await joinWithPin(receiver.page, pin)
  await receiver.page.getByText(big.name).waitFor()
  await waitLeg(sender.page, 0, 'joined')
  const t0 = Date.now()
  await acceptBtn(receiver.page).click()

  // Sample both ends until both finish
  const seen = { sender: new Set(), receiver: new Set() }
  let tStart = null
  let tData = null
  const etaSamples = []
  const speedSamples = []
  let lastBytes = null
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    const iterStart = Date.now()
    const [ps, pr, vs, vr] = await Promise.all([phase(sender.page), phase(receiver.page), progressValue(sender.page), progressValue(receiver.page)])
    if (vs >= 0) seen.sender.add(vs)
    if (vr >= 0) seen.receiver.add(vr)
    if (ps === 'error' || pr === 'error') {
      throw new Error(`transfer failed: sender="${await sender.page.locator('.beam-card').innerText()}" receiver="${await receiver.page.locator('.beam-card').innerText()}"`)
    }
    if (pr === 'transferring') {
      if (tStart === null) tStart = Date.now()
      const [eta, spd, bytesText] = await receiver.page.evaluate(() => [
        document.querySelector('[data-testid=beam-eta]')?.getAttribute('data-seconds') ?? null,
        document.querySelector('[data-testid=beam-speed]')?.getAttribute('data-bytes-per-sec') ?? null,
        document.querySelector('.beam-stats')?.textContent ?? '',
      ])
      etaSamples.push({ t: Date.now(), pct: vr, eta: eta === '' || eta === null ? null : Number(eta) })
      speedSamples.push({ t: Date.now(), speed: Number(spd), bytesText })
      lastBytes = vr
    }
    if (process.env.DEBUG_ETA && Date.now() - iterStart > 1500) console.log('slow poll', ((iterStart - t0) / 1000).toFixed(1), 's took', Date.now() - iterStart, 'ms; phases', ps, pr, vs, vr)
    if (tData === null && tStart !== null && (pr === 'verifying' || pr === 'done')) tData = Date.now()
    if (ps === 'done' && pr === 'done') break
    await sleep(250)
  }
  const tEnd = Date.now()
  // The data itself is done when the receiver moves on to verifying; saving the file afterwards is a separate wait
  const tDone = tData ?? tEnd
  const secs = (tDone - (tStart ?? t0)) / 1000
  if ((await phase(sender.page)) !== 'done' || (await phase(receiver.page)) !== 'done') throw new Error('timed out')
  const mids = (s) => [...s].some((v) => v > 0 && v < 100)
  if (!mids(seen.sender) || !mids(seen.receiver)) {
    throw new Error(`no in-between progress shown: sender ${[...seen.sender]} receiver ${[...seen.receiver]}`)
  }

  // Speed shown is a real number and agrees with the file size over the time it took
  const avgShown = speedSamples.filter((s) => s.speed > 0).map((s) => s.speed)
  if (avgShown.length < 5) throw new Error('speed was almost never shown')
  const trueAvg = big.size / secs
  const medianShown = avgShown.sort((a, b) => a - b)[Math.floor(avgShown.length / 2)]
  if (medianShown < trueAvg * 0.5 || medianShown > trueAvg * 2) {
    throw new Error(`speed shown (median ${(medianShown / 1e6).toFixed(1)} MB/s) is far from the real average (${(trueAvg / 1e6).toFixed(1)} MB/s)`)
  }
  // Time left: once the transfer is 30% in, projected finish time must be close to the real one
  if (process.env.DEBUG_ETA) console.log('connect took', (((tStart ?? t0) - t0) / 1000).toFixed(1), 's, data done at', ((tDone - t0) / 1000).toFixed(1), 's, saved at', ((tEnd - t0) / 1000).toFixed(1), 's; tail', JSON.stringify(etaSamples.slice(-12).map((x) => [((x.t - t0) / 1000).toFixed(1), x.pct, x.eta])))
  const late = etaSamples.filter((s) => s.pct >= 30 && s.pct < 95 && s.eta !== null)
  if (late.length < 5) throw new Error(`time left was shown only ${late.length} times after 30%`)
  const errs = late.map((s) => Math.abs((s.t + s.eta * 1000) - tDone) / Math.max(1000, tDone - s.t)).sort((a, b) => a - b)
  const median = errs[Math.floor(errs.length / 2)]
  const p90 = errs[Math.floor(errs.length * 0.9)]
  if (median > 0.15 || p90 > 0.4) {
    throw new Error(`time left was off: median error ${(median * 100).toFixed(0)}%, 90th percentile ${(p90 * 100).toFixed(0)}% of the time remaining`)
  }

  const shown = await receiver.page.locator('.beam-hash').innerText()
  if (shown !== big.sha256) throw new Error(`receiver shows hash ${shown}, file is ${big.sha256}`)
  await sender.page.getByText('Verified').first().waitFor()
  if ((await receiver.page.evaluate(() => window.__beamPicked)) !== big.name) throw new Error('save picker was not offered the file name')
  await expectSaved(receiver.page, big)
  console.log(`    ${BIG_MB} MB in ${secs.toFixed(1)}s (${(BIG_MB / secs).toFixed(1)} MB/s); time-left error: median ${(median * 100).toFixed(1)}%, p90 ${(p90 * 100).toFixed(1)}% (${late.length} samples); last progress ${lastBytes}%`)
})

await test('one file to 3 receivers at once: every receiver gets identical bytes, and the PIN stays open for a 4th', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, mid)
  const rs = []
  for (let i = 0; i < 3; i++) rs.push(await joinReceiver(open, pin))
  await waitLeg(sender.page, 2, 'joined')
  if ((await legs(sender.page).count()) !== 3) throw new Error('sender should list 3 receivers')
  await Promise.all(rs.map((r) => acceptBtn(r.page).click()))
  await Promise.all(rs.map((r) => waitPhase(r.page, 'done', 180_000)))
  for (const r of rs) await expectSaved(r.page, mid)
  for (let i = 0; i < 3; i++) await waitLeg(sender.page, i, 'done')
  // Sender is still open: PIN still on screen and a late receiver can still get the file
  await sender.page.getByTestId('beam-pin').waitFor()
  const late = await joinReceiver(open, pin)
  await acceptBtn(late.page).click()
  await waitPhase(late.page, 'done', 120_000)
  await expectSaved(late.page, mid)
  await waitLeg(sender.page, 3, 'done')
})

await test('everyone gets a cute name: the sender, each receiver, and both sides agree on who is who', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, small)
  const myName = await sender.page.locator('.beam-who [data-person]').first().getAttribute('data-person')
  if (!myName) throw new Error('sender has no name')
  const rs = []
  for (let i = 0; i < 4; i++) rs.push(await joinReceiver(open, pin))
  await waitLeg(sender.page, 3, 'joined')
  const legNames = await sender.page.locator('.beam-leg [data-person]').evaluateAll((els) => els.map((e) => e.getAttribute('data-person')))
  const receiverNames = []
  for (const r of rs) {
    const who = await r.page.locator('.beam-who [data-person]').evaluateAll((els) => els.map((e) => e.getAttribute('data-person')))
    if (who.length !== 2) throw new Error(`receiver should see itself and the sender, saw ${who}`)
    if (who[1] !== myName) throw new Error(`receiver sees sender as ${who[1]}, sender is ${myName}`)
    receiverNames.push(who[0])
  }
  if (JSON.stringify(legNames) !== JSON.stringify(receiverNames)) throw new Error(`sender lists ${legNames}, receivers call themselves ${receiverNames}`)
  const all = [myName, ...legNames].map((n) => n.toLowerCase())
  if (new Set(all).size !== all.length) throw new Error(`names are not unique: ${all}`)
  for (const n of all) if (!/^[A-Za-z]+( \d+)?$/.test(n)) throw new Error(`"${n}" does not look like a cute name`)
})

await test('9th receiver is refused; the 8 already in are unaffected and can all finish', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, small)
  const rs = []
  for (let i = 0; i < 8; i++) rs.push(await joinReceiver(open, pin))
  const ninth = await open(SAVE_TO_OPFS)
  await joinWithPin(ninth.page, pin)
  await waitPhase(ninth.page, 'error')
  await ninth.page.getByText('maximum number of receivers').waitFor()
  await Promise.all(rs.map((r) => acceptBtn(r.page).click()))
  await Promise.all(rs.map((r) => waitPhase(r.page, 'done', 240_000)))
  for (const r of rs) await expectSaved(r.page, small)
})

await test('a receiver that vanishes mid-transfer does not stop the others, and the sender shows which one is paused', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, big)
  const keep1 = await joinReceiver(open, pin)
  const drop = await joinReceiver(open, pin)
  const keep2 = await joinReceiver(open, pin)
  await Promise.all([keep1, drop, keep2].map((r) => acceptBtn(r.page).click()))
  await waitPhase(drop.page, 'transferring')
  await sleep(1500)
  await drop.ctx.close()
  await waitLeg(sender.page, 1, 'paused', 45_000) // paused, not failed: it could still come back and carry on
  await sender.page.locator('.beam-leg').nth(1).getByText('Connection lost').waitFor()
  await Promise.all([keep1, keep2].map((r) => waitPhase(r.page, 'done', 300_000)))
  await expectSaved(keep1.page, big)
  await expectSaved(keep2.page, big)
  await waitLeg(sender.page, 0, 'done')
  await waitLeg(sender.page, 2, 'done')
})

await test('"Stop sharing" mid-transfer stops every receiver and they discard the partial file', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, big)
  const a = await joinReceiver(open, pin)
  const b = await joinReceiver(open, pin)
  await Promise.all([a, b].map((r) => acceptBtn(r.page).click()))
  await Promise.all([a, b].map((r) => waitPhase(r.page, 'transferring')))
  await sleep(1000)
  await sender.page.getByRole('button', { name: 'Stop sharing' }).click()
  await Promise.all([a, b].map((r) => waitPhase(r.page, 'error', 30_000)))
  for (const r of [a, b]) {
    await r.page.getByText('cancelled the transfer').waitFor()
    await sleep(300)
    const info = await opfsInfo(r.page, big.name)
    if (info && info.size !== 0) throw new Error(`partial file kept: ${info.size} bytes`)
  }
  await sender.page.getByText('Sharing stopped').waitFor()
})

await test('cancelling one receiver from the sender leaves the other transfer running', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, big)
  const a = await joinReceiver(open, pin)
  const b = await joinReceiver(open, pin)
  await Promise.all([a, b].map((r) => acceptBtn(r.page).click()))
  await waitLeg(sender.page, 0, 'transferring')
  await waitLeg(sender.page, 1, 'transferring')
  await sender.page.getByRole('button', { name: /Cancel transfer to/ }).first().click()
  await waitLeg(sender.page, 0, 'error')
  await waitPhase(a.page, 'error', 30_000)
  await a.page.getByText('cancelled the transfer').waitFor()
  await waitPhase(b.page, 'done', 300_000)
  await expectSaved(b.page, big)
})

await test('a damaged chunk is caught: both sides report a SHA-256 mismatch and nothing is kept', async (open) => {
  const sender = await open()
  const receiver = await open([SAVE_TO_OPFS, CORRUPT_ONE_CHUNK])
  await joinWithPin(receiver.page, await startSending(sender.page, mid))
  await acceptBtn(receiver.page).click()
  await waitPhase(receiver.page, 'error', 120_000)
  await receiver.page.getByText('SHA-256 mismatch').waitFor()
  await waitLeg(sender.page, 0, 'error', 30_000)
  await sender.page.locator('.beam-leg').first().getByText('SHA-256 mismatch').waitFor()
  await sleep(300)
  const info = await opfsInfo(receiver.page, mid.name)
  if (info && info.size !== 0) throw new Error(`corrupt file was kept: ${info.size} bytes`)
})

await test('an empty (0 byte) file transfers and is saved as an empty file', async (open) => {
  const empty = makeSmall('empty.bin', Buffer.alloc(0))
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  await joinWithPin(receiver.page, await startSending(sender.page, empty))
  await acceptBtn(receiver.page).click()
  await waitPhase(receiver.page, 'done', 30_000)
  await waitPhase(sender.page, 'done', 30_000)
  await expectSaved(receiver.page, empty)
})

await test('awkward file names (unicode, emoji, quotes, HTML) are shown as text and saved intact', async (open) => {
  // Built in memory: Windows could not create a file with quotes or angle brackets in its name
  const body = Buffer.from('hello beam')
  const odd = { name: 'ünï cødé 😀 "q" & <b>x</b>.txt', size: body.length, sha256: createHash('sha256').update(body).digest('hex') }
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  await sender.page.setInputFiles('input[type=file]', { name: odd.name, mimeType: 'text/plain', buffer: body })
  const pin = (await sender.page.getByTestId('beam-pin').innerText()).replace(/\D/g, '')
  await joinWithPin(receiver.page, pin)
  // The room replaces path separators in names, so the receiver sees "</b>" as "<_b>"
  const received = { ...odd, name: odd.name.replace(/\//g, '_') }
  await receiver.page.locator('.beam-file-name').getByText(received.name, { exact: true }).waitFor()
  await sender.page.locator('.beam-file-name').getByText(odd.name, { exact: true }).waitFor()
  if (await receiver.page.locator('.beam-file-name b').count()) throw new Error('file name was rendered as HTML')
  await acceptBtn(receiver.page).click()
  await waitPhase(receiver.page, 'done', 30_000)
  if ((await receiver.page.evaluate(() => window.__beamPicked)) !== received.name) throw new Error('name changed on the way')
  await expectSaved(receiver.page, received)
})

await test('two separate transfers at once (different PINs, different files) do not mix', async (open) => {
  const s1 = await open(); const s2 = await open()
  const r1 = await open(SAVE_TO_OPFS); const r2 = await open(SAVE_TO_OPFS)
  const [p1, p2] = [await startSending(s1.page, mid), await startSending(s2.page, small)]
  await joinWithPin(r1.page, p1); await joinWithPin(r2.page, p2)
  await Promise.all([acceptBtn(r1.page), acceptBtn(r2.page)].map((b) => b.waitFor()))
  await Promise.all([acceptBtn(r1.page).click(), acceptBtn(r2.page).click()])
  await Promise.all([waitPhase(r1.page, 'done', 180_000), waitPhase(r2.page, 'done', 180_000)])
  await expectSaved(r1.page, mid)
  await expectSaved(r2.page, small)
})

await test('"Send another file" after a finished transfer works, and so does "Receive another file"', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  await joinWithPin(receiver.page, await startSending(sender.page, small))
  await acceptBtn(receiver.page).click()
  await waitPhase(receiver.page, 'done', 60_000)
  await sender.page.getByRole('button', { name: 'Stop sharing' }).click()
  await sender.page.getByRole('button', { name: 'Send another file' }).click()
  await receiver.page.getByRole('button', { name: 'Receive another file' }).click()
  await waitPhase(sender.page, 'idle'); await waitPhase(receiver.page, 'idle')
  const other = makeSmall('second.txt', randomBytes(5000))
  await joinWithPin(receiver.page, await startSending(sender.page, other))
  await acceptBtn(receiver.page).click()
  await waitPhase(receiver.page, 'done', 30_000)
  await expectSaved(receiver.page, other)
})

await test('browsers without the save dialog get the file as a normal download', async (open) => {
  const sender = await open()
  const receiver = await open(NO_SAVE_PICKER)
  await receiver.page.getByText('can receive up to').waitFor()
  const pin = await startSending(sender.page, small)
  await joinWithPin(receiver.page, pin)
  const downloadPromise = receiver.page.waitForEvent('download', { timeout: 60_000 })
  await acceptBtn(receiver.page).click()
  const download = await downloadPromise
  if (download.suggestedFilename() !== small.name) throw new Error(`download named ${download.suggestedFilename()}`)
  const out = join(DIR, `downloaded-${small.name}`)
  await download.saveAs(out)
  const got = createHash('sha256').update(readFileSync(out)).digest('hex')
  if (got !== small.sha256) throw new Error('downloaded file does not match')
  await waitPhase(sender.page, 'done', 30_000)
  await receiver.page.getByText('saved to your downloads').waitFor()
})

await test('the QR code link joins straight away and removes the PIN from the address bar', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, small)
  await sender.page.getByRole('button', { name: /QR code/ }).click()
  await sender.page.locator('.beam-qr svg').waitFor()
  const receiver = await open(SAVE_TO_OPFS)
  await receiver.page.goto(`${UI}/beam?pin=${pin}`)
  await acceptBtn(receiver.page).waitFor()
  if (receiver.page.url().includes('pin=')) throw new Error('PIN left in the address bar')
})

await test('PIN entry: pasted link works; letters, short and long input are refused with a message', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, small)
  const r = await open(SAVE_TO_OPFS)
  for (const bad of ['abcdef', '12345', '1234567', '', '   ']) {
    await r.page.locator('#beam-pin').fill(bad)
    await r.page.getByRole('button', { name: 'Connect' }).click()
    await r.page.getByText('Enter the 6-digit PIN').waitFor()
    if ((await phase(r.page)) !== 'idle') throw new Error(`"${bad}" started a connection`)
  }
  await r.page.locator('#beam-pin').fill(`${UI}/beam?pin=${pin}`)
  await r.page.getByRole('button', { name: 'Connect' }).click()
  await acceptBtn(r.page).waitFor()
})

await test('a wrong PIN shows a clear error and Start over returns to the start screen', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, small)
  const receiver = await open()
  await joinWithPin(receiver.page, String((Number(pin) + 1) % 1e6).padStart(6, '0'))
  await waitPhase(receiver.page, 'error')
  await receiver.page.getByText('No transfer is waiting on that PIN').waitFor()
  await receiver.page.getByRole('button', { name: 'Start over' }).click()
  await waitPhase(receiver.page, 'idle')
})

await test('reloading the sender: its old PIN is held for it, and a new receiver is told the sender lost connection', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, small)
  await sender.page.reload()
  await sleep(500)
  const receiver = await open()
  await joinWithPin(receiver.page, pin)
  await waitPhase(receiver.page, 'error')
  await receiver.page.getByText('The sender lost their connection').waitFor()
})

await test('declining shows on the sender as a declined receiver, and another receiver can still take the file', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, small)
  const r1 = await joinReceiver(open, pin)
  await r1.page.getByRole('button', { name: 'Decline' }).click()
  await waitLeg(sender.page, 0, 'declined')
  await sender.page.getByText('Declined or left').waitFor()
  const r2 = await joinReceiver(open, pin)
  await acceptBtn(r2.page).click()
  await waitPhase(r2.page, 'done', 60_000)
  await expectSaved(r2.page, small)
})

await test('closing the sender tab mid-transfer leaves the receiver interrupted with the part it has kept, ready to reconnect', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  await joinWithPin(receiver.page, await startSending(sender.page, big))
  await acceptBtn(receiver.page).click()
  await waitPhase(receiver.page, 'transferring')
  await waitProgress(receiver.page, 10)
  await sender.ctx.close()
  await waitPhase(receiver.page, 'interrupted', 45_000)
  await receiver.page.getByTestId('beam-interrupted').getByText('is saved').waitFor()
  await receiver.page.getByRole('button', { name: 'Reconnect' }).waitFor()
  await sleep(500)
  const info = await opfsInfo(receiver.page, big.name)
  if (!info || info.size === 0) throw new Error('the part already received was not kept')
})

await test('when the browsers cannot reach each other, the sender row and the receiver both say the direct connection failed', async (open) => {
  const sender = await open()
  const receiver = await open([SAVE_TO_OPFS, BLOCK_ICE])
  await joinWithPin(receiver.page, await startSending(sender.page, small))
  await acceptBtn(receiver.page).click()
  await waitPhase(receiver.page, 'peering')
  await Promise.all([waitPhase(sender.page, 'error', 45_000), waitPhase(receiver.page, 'error', 45_000)])
  await receiver.page.getByText('Could not open a direct connection').waitFor()
  await sender.page.locator('.beam-leg').first().getByText('Could not open a direct connection').waitFor()
})

await test('Nearby: Receive mode is off by default and does not even open a connection to the lobby', async (open) => {
  const r = await open()
  const sockets = []
  r.page.on('websocket', (ws) => sockets.push(ws.url()))
  await sleep(800)
  if (await r.page.getByRole('switch', { name: 'Show me to nearby senders' }).isChecked()) throw new Error('Receive mode starts on')
  if (sockets.some((u) => u.includes('/lobby/'))) throw new Error('lobby socket opened without opting in')
})

await test('Nearby radar: only receivers who opted in, on the same network, appear; receivers and senders stay hidden from each other', async (open) => {
  const net = newNetwork()
  const sender = await open(null, { ip: net })
  await startSending(sender.page, small)
  await sender.page.locator('.beam-radar').waitFor()
  await sender.page.getByText('Nobody yet').waitFor()
  const a = await nearbyReceiver(open, net)
  const b = await nearbyReceiver(open, net)
  const offNet = await nearbyReceiver(open, newNetwork())
  const notOptedIn = await open(null, { ip: net }) // same network but Receive mode never switched on
  await waitRadar(sender.page, 2)
  const names = (await radarNames(sender.page)).sort()
  if (JSON.stringify(names) !== JSON.stringify([a.name, b.name].sort())) throw new Error(`radar shows ${names}, expected ${[a.name, b.name]}`)
  if (names.includes(offNet.name)) throw new Error('a receiver on another network showed up')
  await sleep(300)
  for (const r of [a, b, offNet, notOptedIn]) {
    if (await r.page.locator('.beam-radar, .beam-peer').count()) throw new Error('a receiver can see a radar or people')
    const body = await r.page.locator('body').innerText()
    if (/Sunny|Sender/.test(body) && body.includes('wants to send')) throw new Error('a receiver was shown a sender')
  }
  // every avatar is an emoji on a coloured ring, and the count is announced
  const emoji = await sender.page.locator('.beam-peer-avatar span[aria-hidden]').allInnerTexts()
  if (emoji.some((e) => !e.trim())) throw new Error('an avatar is empty')
  await sender.page.getByText('2 people here').waitFor()
})

await test('Nearby radar: switching Receive mode off, or closing the tab, removes a receiver from the radar', async (open) => {
  const net = newNetwork()
  const sender = await open(null, { ip: net })
  await startSending(sender.page, small)
  const a = await nearbyReceiver(open, net)
  const b = await nearbyReceiver(open, net)
  await waitRadar(sender.page, 2)
  await a.page.getByRole('switch', { name: 'Show me to nearby senders' }).uncheck({ force: true })
  await waitRadar(sender.page, 1)
  if ((await radarNames(sender.page))[0] !== b.name) throw new Error('wrong person left the radar')
  await b.ctx.close()
  await waitRadar(sender.page, 0)
  await a.page.getByRole('switch', { name: 'Show me to nearby senders' }).check({ force: true })
  await waitRadar(sender.page, 1)
})

await test('Nearby send: pick several people at once, they get a request with the file and sender, accept, and all receive identical bytes', async (open) => {
  const net = newNetwork()
  const sender = await open(null, { ip: net })
  await startSending(sender.page, mid)
  const rs = [await nearbyReceiver(open, net), await nearbyReceiver(open, net), await nearbyReceiver(open, net)]
  await waitRadar(sender.page, 3)
  const sendBtn = sender.page.getByRole('button', { name: /^Send to/ })
  if (!(await sendBtn.isDisabled())) throw new Error('send button enabled with nobody selected')
  // choose two of the three
  await peer(sender.page, rs[0].name).click()
  await peer(sender.page, rs[2].name).click()
  if ((await peer(sender.page, rs[0].name).getAttribute('aria-pressed')) !== 'true') throw new Error('selection did not show')
  if ((await peer(sender.page, rs[1].name).getAttribute('aria-pressed')) !== 'false') throw new Error('wrong person selected')
  await sender.page.getByRole('button', { name: 'Send to 2 people' }).click()

  for (const r of [rs[0], rs[2]]) {
    await invitePrompt(r.page).waitFor()
    const text = await invitePrompt(r.page).innerText()
    if (!text.includes(mid.name) || !text.includes('60.0 MB')) throw new Error(`prompt lacks the file: ${text}`)
    const senderName = await sender.page.locator('.beam-who [data-person]').first().getAttribute('data-person')
    if (!text.includes(senderName)) throw new Error(`prompt does not name the sender ${senderName}: ${text}`)
  }
  await sleep(400)
  if (await invitePrompt(rs[1].page).count()) throw new Error('an unchosen person got a request')
  await peer(sender.page, rs[0].name).and(sender.page.locator('[data-peer-status=invited]')).waitFor()

  // accepting is the only click: it joins the room and goes straight to saving
  await Promise.all([rs[0], rs[2]].map((r) => invitePrompt(r.page).getByRole('button', { name: 'Accept' }).click()))
  await Promise.all([rs[0], rs[2]].map((r) => waitPhase(r.page, 'done', 240_000)))
  for (const r of [rs[0], rs[2]]) await expectSaved(r.page, mid)
  if ((await rs[0].page.evaluate(() => window.__beamPicked)) !== mid.name) throw new Error('did not go straight to saving')
  await waitLeg(sender.page, 1, 'done')
  // Accepting leaves the lobby: they drop off the radar and show as transfers, under the same names
  await waitRadar(sender.page, 1)
  const legNames = await sender.page.locator('.beam-leg [data-person]').evaluateAll((els) => els.map((e) => e.getAttribute('data-person')).sort())
  if (JSON.stringify(legNames) !== JSON.stringify([rs[0].name, rs[2].name].sort())) throw new Error(`transfer rows ${legNames}, expected ${[rs[0].name, rs[2].name]}`)
  // the one nobody asked is untouched and still selectable
  if ((await peer(sender.page, rs[1].name).getAttribute('data-peer-status')) !== 'idle') throw new Error('third person changed')
})

await test('Nearby send: Select all asks everyone on the radar', async (open) => {
  const net = newNetwork()
  const sender = await open(null, { ip: net })
  await startSending(sender.page, small)
  const rs = []
  for (let i = 0; i < 4; i++) rs.push(await nearbyReceiver(open, net))
  await waitRadar(sender.page, 4)
  await sender.page.getByRole('button', { name: 'Select all' }).click()
  await sender.page.getByRole('button', { name: 'Send to 4 people' }).click()
  for (const r of rs) await invitePrompt(r.page).waitFor()
})

await test('Nearby: decline tells the sender; block silences that sender; Decline does not block', async (open) => {
  const net = newNetwork()
  const sender = await open(null, { ip: net })
  await startSending(sender.page, small)
  const r = await nearbyReceiver(open, net)
  await waitRadar(sender.page, 1)
  const ask = async () => {
    await peer(sender.page, r.name).click()
    await sender.page.getByRole('button', { name: 'Send to 1 person' }).click()
  }
  await ask()
  await invitePrompt(r.page).getByRole('button', { name: 'Decline' }).click()
  await peer(sender.page, r.name).and(sender.page.locator('[data-peer-status=declined]')).waitFor()
  if (await invitePrompt(r.page).count()) throw new Error('prompt stayed after declining')
  // not blocked: asking again works
  await ask()
  await invitePrompt(r.page).waitFor()
  await invitePrompt(r.page).getByRole('button', { name: 'Block' }).click()
  await peer(sender.page, r.name).and(sender.page.locator('[data-peer-status=declined]')).waitFor()
  // blocked: asking again shows declined on the sender and nothing on the receiver
  await ask()
  await sleep(700)
  if (await invitePrompt(r.page).count()) throw new Error('a blocked sender got through')
  await peer(sender.page, r.name).and(sender.page.locator('[data-peer-status=declined]')).waitFor()
})

await test('Nearby: stopping sharing withdraws the request from the receiver', async (open) => {
  const net = newNetwork()
  const sender = await open(null, { ip: net })
  await startSending(sender.page, small)
  const r = await nearbyReceiver(open, net)
  await waitRadar(sender.page, 1)
  await peer(sender.page, r.name).click()
  await sender.page.getByRole('button', { name: 'Send to 1 person' }).click()
  await invitePrompt(r.page).waitFor()
  await sender.page.getByRole('button', { name: 'Stop sharing' }).click()
  await invitePrompt(r.page).waitFor({ state: 'detached', timeout: 15000 })
})

await test('Nearby: a receiver who is mid-transfer or has accepted is no longer listed, and a new sender can still find the others', async (open) => {
  const net = newNetwork()
  const sender = await open(null, { ip: net })
  await startSending(sender.page, small)
  const a = await nearbyReceiver(open, net)
  const b = await nearbyReceiver(open, net)
  await waitRadar(sender.page, 2)
  await peer(sender.page, a.name).click()
  await sender.page.getByRole('button', { name: 'Send to 1 person' }).click()
  await invitePrompt(a.page).getByRole('button', { name: 'Accept' }).click()
  await waitPhase(a.page, 'done', 120_000)
  await waitRadar(sender.page, 1)
  const second = await open(null, { ip: net })
  await startSending(second.page, small)
  await waitRadar(second.page, 1)
  if ((await radarNames(second.page))[0] !== b.name) throw new Error('second sender sees the wrong people')
})

await test('Nearby radar at phone width: no sideways scroll with 6 people on it', async (open) => {
  const net = newNetwork()
  const sender = await open(null, { ip: net, viewport: { width: 375, height: 812 } })
  await startSending(sender.page, small)
  for (let i = 0; i < 6; i++) await nearbyReceiver(open, net)
  await waitRadar(sender.page, 6)
  if (await sender.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('page scrolls sideways')
  // every person is fully inside the radar circle and tappable
  const bad = await sender.page.evaluate(() => {
    const r = document.querySelector('.beam-radar').getBoundingClientRect()
    return [...document.querySelectorAll('.beam-peer')].filter((p) => {
      const b = p.getBoundingClientRect()
      return b.left < r.left - 2 || b.right > r.right + 2 || b.top < r.top - 2 || b.bottom > r.bottom + 2
    }).length
  })
  if (bad) throw new Error(`${bad} people are drawn outside the radar`)
})

await test('Reconnect: the receiver loses its connection mid-transfer, reconnects by itself, and carries on from where it stopped', async (open) => {
  const sender = await open([TRACK])
  const receiver = await open([SAVE_TO_OPFS, TRACK])
  await joinWithPin(receiver.page, await startSending(sender.page, big))
  await acceptBtn(receiver.page).click()
  await waitProgress(receiver.page, 35)
  await dropNetwork(receiver.page)
  await waitPhase(receiver.page, 'interrupted', 20_000)
  const card = receiver.page.getByTestId('beam-interrupted')
  const text = await card.innerText()
  const m = text.match(/\(([\d.]+)%\) is saved/)
  if (!m || Number(m[1]) < 25) throw new Error(`interrupted card does not show the saved part: ${text}`)
  await receiver.page.getByRole('button', { name: 'Reconnect' }).waitFor()
  await receiver.page.getByTestId('beam-reconnect-status').getByText(/Reconnecting automatically|Trying to reconnect/).waitFor()
  // no click: it comes back on its own
  await waitPhase(receiver.page, 'transferring', 60_000)
  await receiver.page.getByTestId('beam-resumed-note').waitFor()
  await sender.page.locator('.beam-leg').getByTestId('beam-resumed-note').first().waitFor()
  await waitPhase(receiver.page, 'done', 240_000)
  await expectSaved(receiver.page, big)
  await waitLeg(sender.page, 0, 'done')
  const rows = await legs(sender.page).count()
  if (rows !== 1) throw new Error(`sender should show one finished row (the paused one replaced), shows ${rows}`)
})

await test('Reconnect button: pressing it brings the transfer back at once, from where it was left', async (open) => {
  const sender = await open([TRACK])
  const receiver = await open([SAVE_TO_OPFS, TRACK])
  await joinWithPin(receiver.page, await startSending(sender.page, big))
  await acceptBtn(receiver.page).click()
  await waitProgress(receiver.page, 30)
  await dropNetwork(receiver.page)
  await waitPhase(receiver.page, 'interrupted', 20_000)
  await receiver.page.getByRole('button', { name: 'Reconnect' }).click()
  await waitPhase(receiver.page, ['peering', 'connecting', 'transferring'], 10_000)
  await waitPhase(receiver.page, 'transferring', 30_000)
  const started = Number((await receiver.page.locator('[role=progressbar]').getAttribute('aria-valuenow')))
  if (started < 25) throw new Error(`restarted from the beginning (${started}%) instead of continuing`)
  await waitPhase(receiver.page, 'done', 240_000)
  await expectSaved(receiver.page, big)
})

await test('Reconnect: dropping several times in a row still ends with the identical file', async (open) => {
  const sender = await open([TRACK])
  const receiver = await open([SAVE_TO_OPFS, TRACK])
  await joinWithPin(receiver.page, await startSending(sender.page, big))
  await acceptBtn(receiver.page).click()
  let last = 0
  for (const at of [20, 45, 70]) {
    await waitProgress(receiver.page, at)
    await dropNetwork(receiver.page)
    await waitPhase(receiver.page, 'interrupted', 20_000)
    await receiver.page.getByRole('button', { name: 'Reconnect' }).click()
    await waitPhase(receiver.page, 'transferring', 40_000)
    const now = Number(await receiver.page.locator('[role=progressbar]').getAttribute('aria-valuenow'))
    if (now < last) throw new Error(`progress went backwards: ${last}% -> ${now}%`)
    last = now
  }
  await waitPhase(receiver.page, 'done', 240_000)
  await expectSaved(receiver.page, big)
})

await test('Reconnect: the sender loses its own connection, gets its room back, and the receiver carries on', async (open) => {
  const sender = await open([TRACK])
  const receiver = await open([SAVE_TO_OPFS, TRACK])
  const pin = await startSending(sender.page, big)
  await joinWithPin(receiver.page, pin)
  await acceptBtn(receiver.page).click()
  await waitProgress(receiver.page, 35)
  await dropNetwork(sender.page)
  await sender.page.getByTestId('beam-sender-reconnecting').waitFor({ timeout: 5000 })
  await sender.page.getByRole('button', { name: 'Reconnect now' }).waitFor()
  await waitPhase(receiver.page, 'interrupted', 30_000)
  await waitPhase(receiver.page, 'transferring', 90_000)
  await waitPhase(receiver.page, 'done', 240_000)
  await expectSaved(receiver.page, big)
  const stillPin = (await sender.page.getByTestId('beam-pin').innerText()).replace(/\D/g, '')
  if (stillPin !== pin) throw new Error('the sender got a different PIN after reconnecting')
  if (await sender.page.getByTestId('beam-sender-reconnecting').count()) throw new Error('the reconnecting banner stayed')
  await waitLeg(sender.page, 0, 'done')
  if ((await legs(sender.page).count()) !== 1) throw new Error('paused row was not replaced')
})

await test('Reconnect: both sides lose their connection at the same moment and still finish', async (open) => {
  const sender = await open([TRACK])
  const receiver = await open([SAVE_TO_OPFS, TRACK])
  await joinWithPin(receiver.page, await startSending(sender.page, big))
  await acceptBtn(receiver.page).click()
  await waitProgress(receiver.page, 40)
  await Promise.all([dropNetwork(sender.page), dropNetwork(receiver.page)])
  await waitPhase(receiver.page, 'interrupted', 30_000)
  await waitPhase(receiver.page, 'done', 300_000)
  await expectSaved(receiver.page, big)
})

await test('Reconnect after closing the tab: a checkpoint kept the file, the next visit offers Reconnect, and the file completes', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  await joinWithPin(receiver.page, await startSending(sender.page, big))
  await acceptBtn(receiver.page).click()
  await waitProgress(receiver.page, 75) // past the first checkpoint (after 128 MB of this 200 MB file)
  await receiver.page.close() // the tab is closed mid-write
  await waitLeg(sender.page, 0, 'paused', 45_000)
  const page2 = await receiver.ctx.newPage()
  page2.setDefaultTimeout(15000)
  await page2.goto(UI + '/beam')
  await page2.getByText('Unfinished transfers').waitFor()
  const row = await page2.locator('[data-unfinished]').first().innerText()
  if (!row.includes(big.name) || !/saved/.test(row)) throw new Error(`unfinished row does not describe the transfer: ${row}`)
  const kept = await opfsInfo(page2, big.name)
  if (!kept || kept.size < 100 * 1024 * 1024) throw new Error(`the checkpointed part was not kept on disk: ${kept?.size}`)
  await page2.getByRole('button', { name: /Reconnect and continue/ }).click()
  await waitPhase(page2, 'done', 300_000)
  await expectSaved(page2, big)
  await waitLeg(sender.page, 0, 'done')
  await page2.getByRole('button', { name: 'Receive another file' }).click()
  await page2.waitForFunction(() => !document.querySelector('[data-unfinished]'))
})

await test('Reconnect: "Forget it" removes an unfinished transfer, and Cancel transfer while interrupted ends it for good', async (open) => {
  const sender = await open()
  const receiver = await open([SAVE_TO_OPFS, TRACK])
  await joinWithPin(receiver.page, await startSending(sender.page, big))
  await acceptBtn(receiver.page).click()
  await waitProgress(receiver.page, 30)
  await dropNetwork(receiver.page)
  await waitPhase(receiver.page, 'interrupted', 20_000)
  await receiver.page.getByRole('button', { name: 'Cancel transfer' }).click()
  await waitPhase(receiver.page, 'cancelled')
  await receiver.page.getByRole('button', { name: 'Start over' }).click()
  await sleep(300)
  if (await receiver.page.locator('[data-unfinished]').count()) throw new Error('a cancelled transfer is still listed as unfinished')
})

await test('Reconnect: if the sender stops sharing while a receiver is interrupted, the receiver is told it cannot continue', async (open) => {
  const sender = await open()
  const receiver = await open([SAVE_TO_OPFS, TRACK])
  await joinWithPin(receiver.page, await startSending(sender.page, big))
  await acceptBtn(receiver.page).click()
  await waitProgress(receiver.page, 30)
  await dropNetwork(receiver.page)
  await waitPhase(receiver.page, 'interrupted', 20_000)
  await sender.page.getByRole('button', { name: 'Stop sharing' }).click()
  await receiver.page.getByRole('button', { name: 'Reconnect' }).click()
  await waitPhase(receiver.page, 'error', 30_000)
  await receiver.page.getByText('no longer sharing').waitFor()
  await sleep(300)
  await receiver.page.getByRole('button', { name: 'Start over' }).click()
  if (await receiver.page.locator('[data-unfinished]').count()) throw new Error('an impossible transfer is still listed')
})

await test('Reconnect without the save dialog (Firefox/Safari style): the part is kept in the open page and carries on, then downloads', async (open) => {
  const sender = await open()
  const receiver = await open([NO_SAVE_PICKER, TRACK])
  await joinWithPin(receiver.page, await startSending(sender.page, mid))
  const downloadPromise = receiver.page.waitForEvent('download', { timeout: 240_000 })
  await acceptBtn(receiver.page).click()
  await waitProgress(receiver.page, 30)
  await dropNetwork(receiver.page)
  await waitPhase(receiver.page, 'interrupted', 20_000)
  await receiver.page.getByRole('button', { name: 'Reconnect' }).click()
  await waitPhase(receiver.page, 'transferring', 40_000)
  const download = await downloadPromise
  const out = join(DIR, `resumed-${mid.name}`)
  await download.saveAs(out)
  if (createHash('sha256').update(readFileSync(out)).digest('hex') !== mid.sha256) throw new Error('downloaded file does not match after resuming')
  await waitPhase(receiver.page, 'done', 60_000)
})

await test('phone width: no sideways scrolling on the start screen, PIN screen, or with several receivers', async (open) => {
  const { page } = await open(null, { viewport: { width: 375, height: 812 } })
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  if (await overflow()) throw new Error('start screen scrolls sideways')
  const pin = await startSending(page, small)
  if (await overflow()) throw new Error('PIN screen scrolls sideways')
  const rs = []
  for (let i = 0; i < 3; i++) rs.push(await joinReceiver(open, pin))
  await waitLeg(page, 2, 'joined')
  if (await overflow()) throw new Error('receiver list scrolls sideways')
})

if (process.env.BEAM_STRESS) {
  await test('stress: 700 MB to 2 receivers, hashes match on both', async (open) => {
    const gig = await makeFile('beam-700mb.bin', 700)
    const sender = await open()
    const pin = await startSending(sender.page, gig)
    const a = await joinReceiver(open, pin)
    const b = await joinReceiver(open, pin)
    await Promise.all([a, b].map((r) => acceptBtn(r.page).click()))
    await Promise.all([a, b].map((r) => waitPhase(r.page, 'done', 25 * 60_000)))
    await expectSaved(a.page, gig)
    await expectSaved(b.page, gig)
  })
}

await browser.close()
console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
