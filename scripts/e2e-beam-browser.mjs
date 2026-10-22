// Clip Beam browser end-to-end: real Chrome pages send files to each other over WebRTC.
//
// Needs the site (Vite) and worker running locally:
//   npm run dev --prefix frontend      (serves http://localhost:5199, proxies /api to 8787)
//   cd worker && npx wrangler dev --port 8787
// Then: node scripts/e2e-beam-browser.mjs
//
// Env: UI (default http://localhost:5199), CHROME (path to chrome.exe),
//      BEAM_MB (size of the big transfer, default 200),
//      BEAM_STRESS=1 (adds a 1 GB transfer; slow on a loopback link),
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

async function newPage(init, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 860 }, acceptDownloads: true, ...opts })
  // Joining is rate limited per client IP; give each browser its own (local dev only, Cloudflare sets this in production)
  ipCounter++
  await ctx.setExtraHTTPHeaders({ 'CF-Connecting-IP': `10.66.${(ipCounter >> 8) & 255}.${ipCounter & 255}` })
  for (const script of [].concat(init || [])) await ctx.addInitScript(script)
  const page = await ctx.newPage()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
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

await test('a receiver that vanishes mid-transfer does not stop the others, and the sender names which one dropped', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, big)
  const keep1 = await joinReceiver(open, pin)
  const drop = await joinReceiver(open, pin)
  const keep2 = await joinReceiver(open, pin)
  await Promise.all([keep1, drop, keep2].map((r) => acceptBtn(r.page).click()))
  await waitPhase(drop.page, 'transferring')
  await sleep(1500)
  await drop.ctx.close()
  await waitLeg(sender.page, 1, 'error', 45_000)
  await sender.page.locator('.beam-leg').nth(1).getByText('disconnected').waitFor()
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

await test('reloading the sender kills its room: the old PIN stops working', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, small)
  await sender.page.reload()
  await sleep(500)
  const receiver = await open()
  await joinWithPin(receiver.page, pin)
  await waitPhase(receiver.page, 'error')
  await receiver.page.getByText('No transfer is waiting on that PIN').waitFor()
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

await test('closing the sender tab mid-transfer shows the receiver an error and discards the partial file', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  await joinWithPin(receiver.page, await startSending(sender.page, big))
  await acceptBtn(receiver.page).click()
  await waitPhase(receiver.page, 'transferring')
  await sleep(1000)
  await sender.ctx.close()
  await waitPhase(receiver.page, 'error', 45_000)
  await receiver.page.getByText('sender disconnected').waitFor()
  await sleep(300)
  const info = await opfsInfo(receiver.page, big.name)
  if (info && info.size !== 0) throw new Error(`partial file kept: ${info.size} bytes`)
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
  await test('stress: 1 GB to 2 receivers, hashes match on both', async (open) => {
    const gig = await makeFile('beam-1gb.bin', 1024)
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
