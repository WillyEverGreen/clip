// Clip Beam browser end-to-end: real Chrome pages connect to each other over WebRTC and trade files.
//
// Needs the site (Vite) and worker running locally:
//   npm run dev --prefix frontend      (serves http://localhost:5199, proxies /api to 8787)
//   cd worker && npx wrangler dev --port 8787
// Then: node scripts/e2e-beam-browser.mjs
//
// Env: UI (default http://localhost:5199), CHROME (path to chrome.exe),
//      BEAM_MB (size of the big transfer, default 200),
//      BEAM_STRESS=1 (adds a 400 MB transfer to 2 receivers; slow on a loopback link),
//      ONLY=<text> (run only tests whose name contains it), DEBUG_ETA=1 (print time-left samples)
//
// The save dialog and folder picker cannot be clicked in a headless browser, so they are pointed at the
// Origin Private File System instead: the same streaming FileSystemWritableFileStream the real dialogs
// return, in a place the test can read back. A stub can also make them fail or be cancelled.
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

// ── Browser stubs ───────────────────────────────────────────────────────────

const SAVE_TO_OPFS = () => {
  window.showSaveFilePicker = async ({ suggestedName } = {}) => {
    window.__beamPicked = suggestedName
    const root = await navigator.storage.getDirectory()
    return root.getFileHandle(suggestedName, { create: true })
  }
  window.showDirectoryPicker = async () => {
    window.__beamFolderPicked = (window.__beamFolderPicked || 0) + 1
    const root = await navigator.storage.getDirectory()
    return root.getDirectoryHandle('inbox', { create: true })
  }
}

/** A browser like Firefox or Safari: no save dialog and no folder picker. */
const NO_PICKERS = () => {
  Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })
  Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true })
}

/** Save dialog works, but the folder picker is closed without choosing. */
const FOLDER_PICKER_CANCELLED = () => {
  SAVE_TO_OPFS_INLINE()
  window.showDirectoryPicker = async () => { throw new DOMException('closed', 'AbortError') }
  function SAVE_TO_OPFS_INLINE() {
    window.showSaveFilePicker = async ({ suggestedName } = {}) => (await navigator.storage.getDirectory()).getFileHandle(suggestedName, { create: true })
  }
}

/** The chosen folder stops accepting files (permission revoked, folder removed). */
const FOLDER_BROKEN = () => {
  window.showSaveFilePicker = async ({ suggestedName } = {}) => (await navigator.storage.getDirectory()).getFileHandle(suggestedName, { create: true })
  window.showDirectoryPicker = async () => ({ name: 'broken', keys: async function* () {}, getFileHandle: async () => { throw new DOMException('gone', 'NotFoundError') } })
}

/** The save dialog is closed without choosing the first time, then works. */
const SAVE_CANCELLED_ONCE = () => {
  let first = true
  window.showSaveFilePicker = async ({ suggestedName } = {}) => {
    if (first) { first = false; throw new DOMException('closed', 'AbortError') }
    return (await navigator.storage.getDirectory()).getFileHandle(suggestedName, { create: true })
  }
  window.showDirectoryPicker = undefined
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
  // Makes this page go silent on the direct connection (it can still hear), like a path that quietly died
  const send = RTCDataChannel.prototype.send
  window.__mute = () => { RTCDataChannel.prototype.send = function () {} }
  window.__unmute = () => { RTCDataChannel.prototype.send = send }
}
const dropNetwork = (page) => page.evaluate(() => {
  window.__pcs.forEach((pc) => pc.close())
  window.__wss.forEach((ws) => { try { ws.close(4000, 'lost') } catch { /* already closed */ } })
})
/** Only the signalling link goes down; the direct connection is untouched. */
const dropSignalling = (page) => page.evaluate(() => window.__wss.forEach((ws) => { try { ws.close(4000, 'lost') } catch { /* already closed */ } }))

// ── Page helpers ────────────────────────────────────────────────────────────

async function newPage(init, opts = {}) {
  const { ip, ...ctxOpts } = opts
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true, ...ctxOpts })
  // Joining is rate limited per client IP; give each browser its own (local dev only, Cloudflare sets this in production).
  // Browsers that pass the same `ip` are on the same "network" and see each other in Nearby.
  ipCounter++
  await ctx.setExtraHTTPHeaders({ 'CF-Connecting-IP': ip ?? `10.66.${(ipCounter >> 8) & 255}.${ipCounter & 255}` })
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
const waitProgress = (page, pct, timeout = 120_000) => page.waitForFunction(
  (n) => Number(document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')) >= n, pct, { timeout })

/** Sender picks files on the start screen, returns the PIN it is shown. */
async function startSending(page, files) {
  await page.setInputFiles('input[type=file]', [].concat(files).map((f) => f.path))
  const pinEl = page.getByTestId('beam-pin')
  await pinEl.waitFor()
  return (await pinEl.innerText()).replace(/\D/g, '')
}
const addFiles = (page, files) => page.getByTestId('beam-add-input').setInputFiles([].concat(files).map((f) => f.path))

/** The start screen shows Send and Receive side by side; older layouts had a Receive tab. */
async function openReceive(page) {
  const tab = page.getByRole('tab', { name: 'Receive' })
  if (await tab.count()) await tab.click()
}

async function joinWithPin(page, pin) {
  await openReceive(page)
  await page.locator('#beam-pin').fill(`${pin.slice(0, 3)} ${pin.slice(3)}`)
  await page.getByRole('button', { name: 'Connect' }).click()
}

const acceptBtn = (page) => page.getByRole('button', { name: /Accept and (save|download)/ })
const offered = (page) => page.locator('[data-incoming-phase=offered]')
const hist = (page, status) => page.locator(`[data-hist-status=${status}]`)
const legs = (page) => page.locator('.beam-leg')
const legPhase = (page, n) => legs(page).nth(n).getAttribute('data-leg-phase')
async function waitLeg(page, n, want, timeout = 60_000) {
  const wants = [].concat(want)
  await page.waitForFunction(
    ([i, w]) => w.includes(document.querySelectorAll('.beam-leg')[i]?.getAttribute('data-leg-phase')),
    [n, wants], { timeout },
  )
}
/** Waits until at least `n` files with `status` are listed for this page (receiver) or this receiver row (sender). */
async function waitHist(page, status, n, timeout = 120_000, legIndex = null) {
  await page.waitForFunction(
    ([s, count, li]) => {
      const root = li === null ? document : document.querySelectorAll('.beam-leg')[li]
      return (root?.querySelectorAll(`[data-hist-status=${s}]`).length ?? 0) >= count
    },
    [status, n, legIndex], { timeout })
}

/** A receiver tab that has connected (by PIN) and is looking at the first offer. */
async function connectReceiver(open, pin, init = SAVE_TO_OPFS, opts) {
  const r = await open(init, opts)
  await joinWithPin(r.page, pin)
  await r.page.locator('[data-receiver-session=connected]').waitFor({ timeout: 30_000 })
  return r
}

/** Size and SHA-256 of a file the receiver saved into its private file system (null if absent). */
async function opfsInfo(page, name, dir = null) {
  return page.evaluate(async ([n, d]) => {
    let root = await navigator.storage.getDirectory()
    try { if (d) root = await root.getDirectoryHandle(d) } catch { return null }
    let handle
    try { handle = await root.getFileHandle(n) } catch { return null }
    const file = await handle.getFile()
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    return { size: file.size, sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') }
  }, [name, dir])
}
async function expectSaved(page, file, dir = null, savedName = null) {
  const saved = await opfsInfo(page, savedName ?? file.name, dir)
  if (!saved || saved.size !== file.size || saved.sha256 !== file.sha256) {
    throw new Error(`saved file differs: ${JSON.stringify(saved)} vs ${file.size} bytes ${file.sha256}`)
  }
}
/** Accept the file on offer with the save dialog, and wait until it is in the history as done. */
async function takeFile(page, nth = 1) {
  await offered(page).waitFor({ timeout: 30_000 })
  await acceptBtn(page).click()
  await waitHist(page, 'done', nth, 240_000)
}

console.log(`\nClip Beam browser e2e (${UI}, ${BIG_MB} MB file)`)
const big = await makeFile(`beam-big-${BIG_MB}mb.bin`, BIG_MB)
const med = await makeFile('beam-med-100mb.bin', 100)
const mid = await makeFile('beam-mid-60mb.bin', 60)
const small = await makeFile('beam-small-24mb.bin', 24)
const tiny = (n, text) => makeSmall(`tiny-${n}.txt`, Buffer.from(text ?? `tiny file number ${n} ${randomBytes(6).toString('hex')}`))

// ═══ One file, one receiver ═════════════════════════════════════════════════

await test(`${BIG_MB} MB streams tab to tab with live speed and time left that match reality`, async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  const pin = await startSending(sender.page, big)
  if (!/^\d{6}$/.test(pin)) throw new Error(`bad PIN shown: ${pin}`)
  await joinWithPin(receiver.page, pin)
  await receiver.page.getByText(big.name).first().waitFor()
  await offered(receiver.page).waitFor()
  await acceptBtn(receiver.page).click()

  const seen = { sender: new Set(), receiver: new Set() }
  const etaSamples = []
  const speedSamples = []
  let tStart = null
  let tData = null
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    const [pr, vs, vr] = await Promise.all([phase(receiver.page), receiver.page.evaluate(progress), sender.page.evaluate(progress)])
    if (vs >= 0) seen.receiver.add(vs)
    if (vr >= 0) seen.sender.add(vr)
    if (pr === 'transferring') {
      if (tStart === null) tStart = Date.now()
      const [eta, spd] = await receiver.page.evaluate(() => [
        document.querySelector('[data-testid=beam-eta]')?.getAttribute('data-seconds') ?? null,
        document.querySelector('[data-testid=beam-speed]')?.getAttribute('data-bytes-per-sec') ?? null,
      ])
      etaSamples.push({ t: Date.now(), pct: vs, eta: eta === '' || eta === null ? null : Number(eta) })
      speedSamples.push(Number(spd))
    }
    if (tData === null && tStart !== null && (pr === 'verifying' || pr === 'done')) tData = Date.now()
    if (pr === 'done') break
    await sleep(250)
  }
  const tDone = tData ?? Date.now()
  const secs = (tDone - (tStart ?? tDone)) / 1000
  if ((await phase(receiver.page)) !== 'done') throw new Error('timed out')
  const mids = (s) => [...s].some((v) => v > 0 && v < 100)
  if (!mids(seen.sender) || !mids(seen.receiver)) throw new Error(`no in-between progress: sender ${[...seen.sender]} receiver ${[...seen.receiver]}`)

  const shown = speedSamples.filter((s) => s > 0).sort((a, b) => a - b)
  if (shown.length < 5) throw new Error('speed was almost never shown')
  const trueAvg = big.size / secs
  const medianShown = shown[Math.floor(shown.length / 2)]
  if (medianShown < trueAvg * 0.5 || medianShown > trueAvg * 2) {
    throw new Error(`speed shown (median ${(medianShown / 1e6).toFixed(1)} MB/s) is far from the real average (${(trueAvg / 1e6).toFixed(1)} MB/s)`)
  }
  const late = etaSamples.filter((s) => s.pct >= 30 && s.pct < 95 && s.eta !== null)
  if (late.length < 5) throw new Error(`time left was shown only ${late.length} times after 30%`)
  const errs = late.map((s) => Math.abs((s.t + s.eta * 1000) - tDone) / Math.max(1000, tDone - s.t)).sort((a, b) => a - b)
  const median = errs[Math.floor(errs.length / 2)]
  const p90 = errs[Math.floor(errs.length * 0.9)]
  if (process.env.DEBUG_ETA) console.log('    errors', errs.map((e) => e.toFixed(2)).join(' '))
  if (median > 0.2 || p90 > 0.4) { // loaded machines (several browsers at once) measured 4% to 16%
    throw new Error(`time left was off: median error ${(median * 100).toFixed(0)}%, 90th percentile ${(p90 * 100).toFixed(0)}%`)
  }
  await expectSaved(receiver.page, big)
  await waitHist(sender.page, 'done', 1, 30_000, 0)
  console.log(`    ${BIG_MB} MB in ${secs.toFixed(1)}s (${(BIG_MB / secs).toFixed(1)} MB/s); time-left error: median ${(median * 100).toFixed(1)}%, p90 ${(p90 * 100).toFixed(1)}%`)
})
function progress() { const el = document.querySelector('[role=progressbar]'); return el ? Number(el.getAttribute('aria-valuenow')) : -1 }

await test('connecting does not send anything until the receiver accepts: the file is only offered', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  await joinWithPin(receiver.page, await startSending(sender.page, mid))
  await offered(receiver.page).waitFor()
  await sleep(1500)
  if (await receiver.page.locator('[role=progressbar]').count()) throw new Error('bytes flowed before the receiver accepted')
  await sender.page.locator('[data-transfer-status=offered]').waitFor()
  if ((await opfsInfo(receiver.page, mid.name)) !== null) throw new Error('a file was created before accepting')
})

await test('an empty (0 byte) file transfers and is saved as an empty file', async (open) => {
  const empty = makeSmall('empty.bin', Buffer.alloc(0))
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  await joinWithPin(receiver.page, await startSending(sender.page, empty))
  await takeFile(receiver.page)
  await expectSaved(receiver.page, empty)
})

await test('awkward file names (unicode, emoji, quotes, HTML, slashes) are shown as text and saved intact', async (open) => {
  const body = Buffer.from('hello beam')
  const odd = { name: 'ünï cødé 😀 "q" & <b>x</b>.txt', size: body.length, sha256: createHash('sha256').update(body).digest('hex') }
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  await sender.page.setInputFiles('input[type=file]', { name: odd.name, mimeType: 'text/plain', buffer: body })
  const pin = (await sender.page.getByTestId('beam-pin').innerText()).replace(/\D/g, '')
  await joinWithPin(receiver.page, pin)
  // The receiver's engine replaces path separators, so "</b>" arrives as "<_b>"
  const received = { ...odd, name: odd.name.replace(/\//g, '_') }
  await receiver.page.locator('.beam-incoming .beam-file-name').getByText(received.name, { exact: true }).waitFor()
  await sender.page.locator('.beam-queue-item .beam-file-name').getByText(odd.name, { exact: true }).waitFor()
  if (await receiver.page.locator('.beam-incoming .beam-file-name b').count()) throw new Error('file name was rendered as HTML')
  await acceptBtn(receiver.page).click()
  await waitHist(receiver.page, 'done', 1, 30_000)
  if ((await receiver.page.evaluate(() => window.__beamPicked)) !== received.name) throw new Error('name changed on the way')
  await expectSaved(receiver.page, received)
})

await test('closing the save dialog without choosing leaves the file on offer; choosing the second time works', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_CANCELLED_ONCE)
  await joinWithPin(receiver.page, await startSending(sender.page, small))
  await offered(receiver.page).waitFor()
  await acceptBtn(receiver.page).click()
  await sleep(700)
  if (!(await offered(receiver.page).count())) throw new Error('the offer vanished after cancelling the save dialog')
  await acceptBtn(receiver.page).click()
  await waitHist(receiver.page, 'done', 1, 60_000)
  await expectSaved(receiver.page, small)
})

await test('browsers without the save dialog (Firefox/Safari style) get each file as a normal download', async (open) => {
  const sender = await open()
  const receiver = await open(NO_PICKERS)
  const pin = await startSending(sender.page, [small, tiny(1)])
  await joinWithPin(receiver.page, pin)
  await receiver.page.getByText('keeps each file in memory').waitFor().catch(() => {})
  await offered(receiver.page).waitFor()
  const downloadPromise = receiver.page.waitForEvent('download', { timeout: 60_000 })
  await receiver.page.getByRole('button', { name: 'Accept and download' }).click()
  const download = await downloadPromise
  if (download.suggestedFilename() !== small.name) throw new Error(`download named ${download.suggestedFilename()}`)
  const out = join(DIR, `downloaded-${small.name}`)
  await download.saveAs(out)
  if (createHash('sha256').update(readFileSync(out)).digest('hex') !== small.sha256) throw new Error('downloaded file does not match')
  await waitHist(receiver.page, 'done', 1, 30_000)
  await receiver.page.getByText('saved to your downloads').first().waitFor()
  // "Accept all" there just means every file downloads on its own, with no folder question
  const second = receiver.page.waitForEvent('download', { timeout: 60_000 })
  await receiver.page.getByRole('switch', { name: 'Accept all files' }).click()
  await receiver.page.locator('[data-accept-all=on]').waitFor()
  await second
  await waitHist(receiver.page, 'done', 2, 60_000)
})

await test('a damaged chunk fails only that file (SHA-256 mismatch); the connection stays and the next file arrives', async (open) => {
  const sender = await open()
  const receiver = await open([SAVE_TO_OPFS, CORRUPT_ONE_CHUNK])
  const tail = tiny(2, 'a file that follows the damaged one')
  const pin = await startSending(sender.page, [mid, tail])
  await joinWithPin(receiver.page, pin)
  await offered(receiver.page).waitFor()
  await acceptBtn(receiver.page).click()
  await waitHist(receiver.page, 'failed', 1, 120_000)
  await receiver.page.locator('[data-hist-status=failed]').getByText('SHA-256 mismatch').waitFor()
  await waitHist(sender.page, 'error', 1, 30_000, 0)
  await sender.page.locator('[data-hist-status=error]').getByText('SHA-256 mismatch').waitFor()
  await sleep(300)
  const info = await opfsInfo(receiver.page, mid.name)
  if (info && info.size !== 0) throw new Error(`corrupt file was kept: ${info.size} bytes`)
  await offered(receiver.page).waitFor()
  await acceptBtn(receiver.page).click()
  await waitHist(receiver.page, 'done', 1, 30_000)
  await expectSaved(receiver.page, tail)
})

// ═══ A session: several files, one connection ═══════════════════════════════

await test('several files queued up front arrive one after another over one connection, each accepted separately', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  const files = [tiny(11), tiny(12), small]
  await joinWithPin(receiver.page, await startSending(sender.page, files))
  for (let i = 0; i < files.length; i++) {
    await offered(receiver.page).waitFor()
    const shown = await receiver.page.locator('.beam-incoming .beam-file-name').innerText()
    if (shown !== files[i].name) throw new Error(`file ${i + 1} should be ${files[i].name} but ${shown} was offered`)
    await acceptBtn(receiver.page).click()
    await waitHist(receiver.page, 'done', i + 1, 60_000)
    await expectSaved(receiver.page, files[i])
  }
  await waitHist(sender.page, 'done', 3, 30_000, 0)
  if ((await sender.page.locator('[data-file-count]').getAttribute('data-file-count')) !== '3') throw new Error('queue count wrong')
  await sender.page.getByText('All sent and verified').waitFor()
})

await test('the sender keeps adding files after the connection is up, and each is offered', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  await joinWithPin(receiver.page, await startSending(sender.page, tiny(21)))
  await takeFile(receiver.page, 1)
  await sleep(500)
  if (await offered(receiver.page).count()) throw new Error('something was offered although the queue was empty')
  await receiver.page.getByTestId('beam-waiting').waitFor()
  const later = [tiny(22), tiny(23)]
  await addFiles(sender.page, later)
  await takeFile(receiver.page, 2)
  await takeFile(receiver.page, 3)
  await expectSaved(receiver.page, later[0])
  await expectSaved(receiver.page, later[1])
  if ((await sender.page.locator('[data-file-count]').getAttribute('data-file-count')) !== '3') throw new Error('the queue does not show 3 files')
})

await test('files can be added while another is still transferring, and the new one waits its turn', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  const extra = tiny(31)
  await joinWithPin(receiver.page, await startSending(sender.page, med))
  await offered(receiver.page).waitFor()
  await acceptBtn(receiver.page).click()
  await waitProgress(receiver.page, 20)
  await addFiles(sender.page, extra)
  if (await offered(receiver.page).count()) throw new Error('a second file was offered while the first was still transferring')
  await waitHist(receiver.page, 'done', 1, 120_000)
  await takeFile(receiver.page, 2)
  await expectSaved(receiver.page, med)
  await expectSaved(receiver.page, extra)
})

await test('the receiver can decline one file and accept the next; the connection stays open', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  const keep = tiny(41)
  await joinWithPin(receiver.page, await startSending(sender.page, [tiny(40), keep]))
  await offered(receiver.page).waitFor()
  await receiver.page.getByRole('button', { name: 'Decline' }).click()
  await waitHist(receiver.page, 'declined', 1, 15_000)
  await waitHist(sender.page, 'declined', 1, 15_000, 0)
  await takeFile(receiver.page, 1)
  await expectSaved(receiver.page, keep)
  await waitLeg(sender.page, 0, 'connected')
})

await test('"Accept all" asks for one folder, saves every later file there, and renames duplicates', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  const dup = tiny(51, 'same name twice')
  await joinWithPin(receiver.page, await startSending(sender.page, dup))
  await offered(receiver.page).waitFor()
  // turning it on while a file is waiting accepts that file too
  await receiver.page.getByRole('switch', { name: 'Accept all files' }).click()
  await receiver.page.locator('[data-accept-all=on]').waitFor()
  await receiver.page.getByText('into "inbox"').waitFor()
  await waitHist(receiver.page, 'done', 1, 30_000)
  await addFiles(sender.page, [dup, tiny(52)])
  await waitHist(receiver.page, 'done', 3, 60_000)
  if ((await receiver.page.evaluate(() => window.__beamFolderPicked)) !== 1) throw new Error('the folder was asked for more than once')
  if ((await receiver.page.locator('[data-hist-saved-as="tiny-51 (2).txt"]').count()) !== 1) throw new Error('the duplicate was not renamed to "name (2)"')
  await expectSaved(receiver.page, dup, 'inbox')
  await expectSaved(receiver.page, dup, 'inbox', 'tiny-51 (2).txt')
  // and no save dialog was needed for any of them
  if ((await receiver.page.evaluate(() => window.__beamPicked)) !== undefined) throw new Error('the save dialog was used in accept-all mode')
})

await test('switching "Accept all" off goes back to asking about each file', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  await joinWithPin(receiver.page, await startSending(sender.page, tiny(61)))
  await receiver.page.getByRole('switch', { name: 'Accept all files' }).click()
  await receiver.page.locator('[data-accept-all=on]').waitFor()
  await waitHist(receiver.page, 'done', 1, 30_000)
  await receiver.page.getByRole('switch', { name: 'Accept all files' }).click()
  await receiver.page.locator('[data-accept-all=off]').waitFor()
  await addFiles(sender.page, tiny(62))
  await offered(receiver.page).waitFor()
  await sleep(800)
  if ((await hist(receiver.page, 'done').count()) !== 1) throw new Error('a file was accepted automatically after switching accept-all off')
})

await test('"Accept all": if the folder picker is closed it stays off; if the folder breaks mid-session files fall back to downloads', async (open) => {
  const sender = await open()
  const cancelled = await open(FOLDER_PICKER_CANCELLED)
  const broken = await open(FOLDER_BROKEN)
  const pin = await startSending(sender.page, [tiny(71), tiny(72)])
  await joinWithPin(cancelled.page, pin)
  await offered(cancelled.page).waitFor()
  await cancelled.page.getByRole('switch', { name: 'Accept all files' }).click()
  await sleep(600)
  if ((await cancelled.page.locator('[data-accept-all]').getAttribute('data-accept-all')) !== 'off') throw new Error('accept-all turned on although no folder was chosen')
  if (!(await offered(cancelled.page).count())) throw new Error('the offer was lost')
  await joinWithPin(broken.page, pin)
  await offered(broken.page).waitFor()
  const dl = broken.page.waitForEvent('download', { timeout: 30_000 })
  await broken.page.getByRole('switch', { name: 'Accept all files' }).click()
  const d = await dl
  if (!d.suggestedFilename().startsWith('tiny-')) throw new Error(`unexpected download ${d.suggestedFilename()}`)
  await waitHist(broken.page, 'done', 1, 30_000)
  await broken.page.getByText('saved to your downloads').first().waitFor()
})

await test('cancelling a file mid-transfer from the receiver keeps the connection, discards the partial, and the next file arrives', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  const next = tiny(81)
  await joinWithPin(receiver.page, await startSending(sender.page, [med, next]))
  await offered(receiver.page).waitFor()
  await acceptBtn(receiver.page).click()
  await waitProgress(receiver.page, 15)
  await receiver.page.getByTestId('beam-cancel-file').click()
  await waitHist(receiver.page, 'cancelled', 1, 15_000)
  await waitHist(sender.page, 'cancelled', 1, 15_000, 0)
  await sleep(400)
  const info = await opfsInfo(receiver.page, med.name)
  if (info && info.size !== 0) throw new Error(`partial file kept after cancelling: ${info.size} bytes`)
  await takeFile(receiver.page, 1)
  await expectSaved(receiver.page, next)
  await waitLeg(sender.page, 0, 'connected')
})

await test('cancelling a file mid-transfer from the sender keeps the connection and moves on to the next file', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  const next = tiny(91)
  await joinWithPin(receiver.page, await startSending(sender.page, [med, next]))
  await offered(receiver.page).waitFor()
  await acceptBtn(receiver.page).click()
  await waitProgress(receiver.page, 15)
  await sender.page.getByRole('button', { name: /^Cancel .* for / }).click()
  await waitHist(receiver.page, 'cancelled', 1, 15_000)
  await waitHist(sender.page, 'cancelled', 1, 15_000, 0)
  await takeFile(receiver.page, 1)
  await expectSaved(receiver.page, next)
})

await test('the sender can withdraw a file that has been offered but not accepted yet', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  const next = tiny(95)
  await joinWithPin(receiver.page, await startSending(sender.page, [tiny(94), next]))
  await offered(receiver.page).waitFor()
  await sender.page.getByRole('button', { name: /^Cancel .* for / }).click()
  await waitHist(receiver.page, 'cancelled', 1, 15_000)
  await takeFile(receiver.page, 1)
  await expectSaved(receiver.page, next)
})

// ═══ Ending the connection ══════════════════════════════════════════════════

await test('the receiver ends the connection: both sides say so, and nothing half-received is kept', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  await joinWithPin(receiver.page, await startSending(sender.page, med))
  await offered(receiver.page).waitFor()
  await acceptBtn(receiver.page).click()
  await waitProgress(receiver.page, 15)
  await receiver.page.getByTestId('beam-disconnect').click()
  await receiver.page.locator('[data-receiver-session=ended]').waitFor()
  await receiver.page.getByRole('heading', { name: 'You ended the connection' }).waitFor()
  await waitLeg(sender.page, 0, 'ended', 15_000)
  await sender.page.getByText('They ended the connection').waitFor()
  await sleep(400)
  const info = await opfsInfo(receiver.page, med.name)
  if (info && info.size !== 0) throw new Error(`partial file kept: ${info.size} bytes`)
  await sender.page.getByRole('button', { name: /^Dismiss / }).click()
  await legs(sender.page).first().waitFor({ state: 'detached' })
})

await test('the sender ends the connection with one receiver; the other keeps receiving', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, [tiny(101), small])
  const a = await connectReceiver(open, pin)
  const b = await connectReceiver(open, pin)
  await waitLeg(sender.page, 1, 'connected')
  await sender.page.getByRole('button', { name: new RegExp(`^Disconnect ${await a.page.locator('.beam-who [data-person]').first().getAttribute('data-person')}$`) }).click()
  await a.page.locator('[data-receiver-session=ended]').waitFor({ timeout: 15_000 })
  await a.page.getByRole('heading', { name: /ended the connection/ }).waitFor()
  await takeFile(b.page, 1)
  await takeFile(b.page, 2)
  await expectSaved(b.page, small)
})

await test('"Stop sharing" ends every receiver at once', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, med)
  const rs = [await connectReceiver(open, pin), await connectReceiver(open, pin)]
  await acceptBtn(rs[0].page).click()
  await waitProgress(rs[0].page, 10)
  await sender.page.getByRole('button', { name: 'Stop sharing' }).click()
  for (const r of rs) {
    await r.page.locator('[data-receiver-session=ended]').waitFor({ timeout: 20_000 })
    await r.page.getByRole('heading', { name: /ended the connection/ }).waitFor()
  }
  await sender.page.getByText('Sharing stopped').waitFor()
  await sleep(300)
  const info = await opfsInfo(rs[0].page, med.name)
  if (info && info.size !== 0) throw new Error(`partial file kept: ${info.size} bytes`)
})

await test('"Send another file" / "Start over" after ending returns to a clean start screen and works again', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  await joinWithPin(receiver.page, await startSending(sender.page, tiny(111)))
  await takeFile(receiver.page, 1)
  await sender.page.getByRole('button', { name: 'Stop sharing' }).click()
  await receiver.page.locator('[data-receiver-session=ended]').waitFor({ timeout: 15_000 })
  await sender.page.getByRole('button', { name: 'Send another file' }).click()
  await receiver.page.getByRole('button', { name: 'Start over' }).click()
  await waitPhase(sender.page, 'idle'); await waitPhase(receiver.page, 'idle')
  const second = tiny(112)
  await joinWithPin(receiver.page, await startSending(sender.page, second))
  await takeFile(receiver.page, 1)
  await expectSaved(receiver.page, second)
})

// ═══ Several receivers ═════════════════════════════════════════════════════

await test('one set of files to 3 receivers at once: each decides for itself and gets identical bytes; a late 4th still gets them', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, [mid, tiny(121)])
  const rs = []
  for (let i = 0; i < 3; i++) rs.push(await connectReceiver(open, pin))
  await waitLeg(sender.page, 2, 'connected')
  await Promise.all(rs.map((r) => offered(r.page).waitFor()))
  await Promise.all(rs.map((r) => acceptBtn(r.page).click()))
  await Promise.all(rs.map((r) => waitHist(r.page, 'done', 1, 240_000)))
  for (const r of rs) await expectSaved(r.page, mid)
  await Promise.all(rs.map((r) => takeFile(r.page, 2)))
  await sender.page.getByTestId('beam-pin').waitFor()
  const late = await connectReceiver(open, pin)
  await takeFile(late.page, 1)
  await takeFile(late.page, 2)
  await expectSaved(late.page, mid)
})

await test('receivers decide independently: one accepts a file, another declines the same file', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, tiny(131))
  const a = await connectReceiver(open, pin)
  const b = await connectReceiver(open, pin)
  await offered(a.page).waitFor(); await offered(b.page).waitFor()
  await acceptBtn(a.page).click()
  await b.page.getByRole('button', { name: 'Decline' }).click()
  await waitHist(a.page, 'done', 1, 30_000)
  await waitHist(b.page, 'declined', 1, 15_000)
  await waitHist(sender.page, 'done', 1, 15_000, 0)
  await waitHist(sender.page, 'declined', 1, 15_000, 1)
})

await test('9th receiver is refused; the 8 already in are unaffected and can all finish', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, tiny(141))
  const rs = []
  for (let i = 0; i < 8; i++) rs.push(await connectReceiver(open, pin))
  const ninth = await open(SAVE_TO_OPFS)
  await joinWithPin(ninth.page, pin)
  await waitPhase(ninth.page, 'error')
  await ninth.page.getByText('maximum number of receivers').waitFor()
  await Promise.all(rs.map((r) => offered(r.page).waitFor()))
  await Promise.all(rs.map((r) => acceptBtn(r.page).click()))
  await Promise.all(rs.map((r) => waitHist(r.page, 'done', 1, 120_000)))
})

await test('a receiver that vanishes mid-transfer does not stop the others, and the sender shows which one is paused', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, big)
  const keep1 = await connectReceiver(open, pin)
  const drop = await connectReceiver(open, pin)
  const keep2 = await connectReceiver(open, pin)
  await Promise.all([keep1, drop, keep2].map((r) => acceptBtn(r.page).click()))
  await waitProgress(drop.page, 10)
  await drop.ctx.close()
  await waitLeg(sender.page, 1, 'paused', 45_000)
  await sender.page.locator('.beam-leg').nth(1).getByText('Connection lost').waitFor()
  await Promise.all([keep1, keep2].map((r) => waitHist(r.page, 'done', 1, 300_000)))
  await expectSaved(keep1.page, big)
  await expectSaved(keep2.page, big)
})

// ═══ Joining and discovering ═══════════════════════════════════════════════

await test('the QR code link joins straight away, shows the sender, and removes the PIN from the address bar', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, small)
  // the QR code is shown by default; the button only toggles it
  if (!(await sender.page.locator('.beam-qr').count())) await sender.page.getByRole('button', { name: /QR code/ }).click()
  await sender.page.locator('.beam-qr svg').waitFor()
  const receiver = await open(SAVE_TO_OPFS)
  await receiver.page.goto(`${UI}/beam?pin=${pin}`)
  await offered(receiver.page).waitFor({ timeout: 30_000 })
  if (receiver.page.url().includes('pin=')) throw new Error('PIN left in the address bar')
})

await test('PIN entry: a pasted link works; letters, short and long input are refused with a message', async (open) => {
  const sender = await open()
  const pin = await startSending(sender.page, small)
  const r = await open(SAVE_TO_OPFS)
  await openReceive(r.page)
  for (const bad of ['abcdef', '12345', '1234567', '', '   ']) {
    await r.page.locator('#beam-pin').fill(bad)
    await r.page.getByRole('button', { name: 'Connect' }).click()
    await r.page.getByText('Enter the 6-digit PIN').waitFor()
    if ((await phase(r.page)) !== 'idle') throw new Error(`"${bad}" started a connection`)
  }
  await r.page.locator('#beam-pin').fill(`${UI}/beam?pin=${pin}`)
  await r.page.getByRole('button', { name: 'Connect' }).click()
  await offered(r.page).waitFor({ timeout: 30_000 })
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

await test('when the browsers cannot reach each other, both sides say the direct connection failed', async (open) => {
  const sender = await open()
  const receiver = await open([SAVE_TO_OPFS, BLOCK_ICE])
  await joinWithPin(receiver.page, await startSending(sender.page, small))
  await waitPhase(receiver.page, 'error', 60_000)
  await receiver.page.getByText('Could not open a direct connection').waitFor()
  await waitLeg(sender.page, 0, 'error', 60_000)
  await sender.page.locator('.beam-leg').first().getByText('Could not open a direct connection').waitFor()
  // the sender can carry on: a working receiver still connects afterwards
  const pin = (await sender.page.getByTestId('beam-pin').innerText()).replace(/\D/g, '')
  const ok = await connectReceiver(open, pin)
  await takeFile(ok.page, 1)
})

// ═══ Nearby (radar) ═════════════════════════════════════════════════════════

const newNetwork = () => `10.${150 + Math.floor(Math.random() * 40)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`

/** A receiver tab on `ip` with Receive mode switched on and listed. Returns its visible name too. */
async function nearbyReceiver(open, ip, init = SAVE_TO_OPFS) {
  const r = await open(init, { ip })
  await openReceive(r.page)
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

await test('Nearby: Receive mode is off by default and does not even open a connection to the lobby', async (open) => {
  const r = await open()
  const sockets = []
  r.page.on('websocket', (ws) => sockets.push(ws.url()))
  await openReceive(r.page)
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
  const notOptedIn = await open(null, { ip: net })
  await waitRadar(sender.page, 2)
  const names = (await radarNames(sender.page)).sort()
  if (JSON.stringify(names) !== JSON.stringify([a.name, b.name].sort())) throw new Error(`radar shows ${names}, expected ${[a.name, b.name]}`)
  if (names.includes(offNet.name)) throw new Error('a receiver on another network showed up')
  await sleep(300)
  for (const r of [a, b, offNet, notOptedIn]) {
    if (await r.page.locator('.beam-radar, .beam-peer').count()) throw new Error('a receiver can see a radar or people')
  }
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

await test('Nearby send: pick several people, they get a request, Connect, then each file is offered to them separately', async (open) => {
  const net = newNetwork()
  const sender = await open(null, { ip: net })
  const files = [mid, tiny(151)]
  await startSending(sender.page, files)
  const rs = [await nearbyReceiver(open, net), await nearbyReceiver(open, net), await nearbyReceiver(open, net)]
  await waitRadar(sender.page, 3)
  const sendBtn = sender.page.getByRole('button', { name: /^Send to/ })
  if (!(await sendBtn.isDisabled())) throw new Error('send button enabled with nobody selected')
  await peer(sender.page, rs[0].name).click()
  await peer(sender.page, rs[2].name).click()
  if ((await peer(sender.page, rs[0].name).getAttribute('aria-pressed')) !== 'true') throw new Error('selection did not show')
  if ((await peer(sender.page, rs[1].name).getAttribute('aria-pressed')) !== 'false') throw new Error('wrong person selected')
  await sender.page.getByRole('button', { name: 'Send to 2 people' }).click()

  for (const r of [rs[0], rs[2]]) {
    await invitePrompt(r.page).waitFor()
    const text = await invitePrompt(r.page).innerText()
    if (!text.includes('2 files') || !text.includes('60.0 MB')) throw new Error(`prompt does not summarise the files: ${text}`)
    const senderName = await sender.page.locator('.beam-who [data-person]').first().getAttribute('data-person')
    if (!text.includes(senderName)) throw new Error(`prompt does not name the sender ${senderName}: ${text}`)
  }
  await sleep(400)
  if (await invitePrompt(rs[1].page).count()) throw new Error('an unchosen person got a request')
  await peer(sender.page, rs[0].name).and(sender.page.locator('[data-peer-status=invited]')).waitFor()

  await Promise.all([rs[0], rs[2]].map((r) => invitePrompt(r.page).getByRole('button', { name: 'Connect' }).click()))
  for (const r of [rs[0], rs[2]]) {
    await offered(r.page).waitFor({ timeout: 30_000 })
    if (await r.page.evaluate(() => window.__beamPicked)) throw new Error('the save dialog opened before the user chose to accept a file')
  }
  await Promise.all([rs[0], rs[2]].map(async (r) => { await acceptBtn(r.page).click(); await waitHist(r.page, 'done', 1, 240_000) }))
  await Promise.all([rs[0], rs[2]].map((r) => takeFile(r.page, 2)))
  for (const r of [rs[0], rs[2]]) await expectSaved(r.page, mid)
  await waitRadar(sender.page, 1)
  const legNames = await sender.page.locator('.beam-leg [data-person]').evaluateAll((els) => els.map((e) => e.getAttribute('data-person')).sort())
  if (JSON.stringify(legNames) !== JSON.stringify([rs[0].name, rs[2].name].sort())) throw new Error(`rows ${legNames}`)
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
  await ask()
  await invitePrompt(r.page).waitFor()
  await invitePrompt(r.page).getByRole('button', { name: 'Block' }).click()
  await peer(sender.page, r.name).and(sender.page.locator('[data-peer-status=declined]')).waitFor()
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

await test('Nearby: a connected receiver leaves the radar and shows as a connection; others stay; a second sender finds them', async (open) => {
  const net = newNetwork()
  const sender = await open(null, { ip: net })
  await startSending(sender.page, small)
  const a = await nearbyReceiver(open, net)
  const b = await nearbyReceiver(open, net)
  await waitRadar(sender.page, 2)
  await peer(sender.page, a.name).click()
  await sender.page.getByRole('button', { name: 'Send to 1 person' }).click()
  await invitePrompt(a.page).getByRole('button', { name: 'Connect' }).click()
  await takeFile(a.page, 1)
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
  const bad = await sender.page.evaluate(() => {
    const r = document.querySelector('.beam-radar').getBoundingClientRect()
    return [...document.querySelectorAll('.beam-peer')].filter((p) => {
      const b = p.getBoundingClientRect()
      return b.left < r.left - 2 || b.right > r.right + 2 || b.top < r.top - 2 || b.bottom > r.bottom + 2
    }).length
  })
  if (bad) throw new Error(`${bad} people are drawn outside the radar`)
})

// ═══ Connection trouble ═════════════════════════════════════════════════════

await test('Reconnect: the receiver loses its connection mid-file, reconnects by itself, and carries on from where it stopped', async (open) => {
  const sender = await open([TRACK])
  const receiver = await open([SAVE_TO_OPFS, TRACK])
  await joinWithPin(receiver.page, await startSending(sender.page, [tiny(201), med]))
  await takeFile(receiver.page, 1) // a finished file first: it must not be sent again after the drop
  await offered(receiver.page).waitFor()
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
  await waitPhase(receiver.page, 'transferring', 90_000) // no click: it comes back on its own
  await receiver.page.getByTestId('beam-resumed-note').waitFor()
  await waitHist(receiver.page, 'done', 2, 240_000)
  await expectSaved(receiver.page, med)
  if ((await hist(receiver.page, 'done').count()) !== 2) throw new Error('a finished file was delivered twice after reconnecting')
  await waitLeg(sender.page, 0, 'connected')
  if ((await legs(sender.page).count()) !== 1) throw new Error('the paused row was not replaced by the returning receiver')
  if ((await sender.page.locator('.beam-leg [data-hist-status=done]').count()) !== 2) throw new Error('sender history lost its earlier file')
})

await test('Reconnect button: pressing it brings the connection back at once, from where the file was left', async (open) => {
  const sender = await open([TRACK])
  const receiver = await open([SAVE_TO_OPFS, TRACK])
  await joinWithPin(receiver.page, await startSending(sender.page, med))
  await offered(receiver.page).waitFor()
  await acceptBtn(receiver.page).click()
  await waitProgress(receiver.page, 30)
  await dropNetwork(receiver.page)
  await waitPhase(receiver.page, 'interrupted', 20_000)
  await receiver.page.getByRole('button', { name: 'Reconnect' }).click()
  await waitPhase(receiver.page, 'transferring', 40_000)
  const started = await receiver.page.evaluate(progress)
  if (started < 25) throw new Error(`restarted from the beginning (${started}%) instead of continuing`)
  await waitHist(receiver.page, 'done', 1, 240_000)
  await expectSaved(receiver.page, med)
})

await test('Reconnect: dropping several times in a row still ends with the identical file', async (open) => {
  const sender = await open([TRACK])
  const receiver = await open([SAVE_TO_OPFS, TRACK])
  await joinWithPin(receiver.page, await startSending(sender.page, big))
  await offered(receiver.page).waitFor()
  await acceptBtn(receiver.page).click()
  let last = 0
  for (const at of [20, 45, 70]) {
    await waitProgress(receiver.page, at)
    await dropNetwork(receiver.page)
    await waitPhase(receiver.page, 'interrupted', 20_000)
    await receiver.page.getByRole('button', { name: 'Reconnect' }).click()
    await waitPhase(receiver.page, 'transferring', 40_000)
    const now = await receiver.page.evaluate(progress)
    if (now < last) throw new Error(`progress went backwards: ${last}% -> ${now}%`)
    last = now
  }
  await waitHist(receiver.page, 'done', 1, 240_000)
  await expectSaved(receiver.page, big)
})

await test('Reconnect: the sender loses its own connection to Clip, gets its room back, and the transfer carries on', async (open) => {
  const sender = await open([TRACK])
  const receiver = await open([SAVE_TO_OPFS, TRACK])
  const pin = await startSending(sender.page, [big, tiny(211)])
  await joinWithPin(receiver.page, pin)
  await offered(receiver.page).waitFor()
  await acceptBtn(receiver.page).click()
  await waitProgress(receiver.page, 35)
  await dropNetwork(sender.page)
  await sender.page.getByTestId('beam-sender-reconnecting').waitFor({ timeout: 5000 })
  await sender.page.getByRole('button', { name: 'Reconnect now' }).waitFor()
  await waitPhase(receiver.page, 'interrupted', 30_000)
  await waitPhase(receiver.page, 'transferring', 90_000)
  await waitHist(receiver.page, 'done', 1, 240_000)
  await expectSaved(receiver.page, big)
  const stillPin = (await sender.page.getByTestId('beam-pin').innerText()).replace(/\D/g, '')
  if (stillPin !== pin) throw new Error('the sender got a different PIN after reconnecting')
  await takeFile(receiver.page, 2)
  if (await sender.page.getByTestId('beam-sender-reconnecting').count()) throw new Error('the reconnecting banner stayed')
})

await test('Reconnect: both sides lose their connection at the same moment and still finish', async (open) => {
  const sender = await open([TRACK])
  const receiver = await open([SAVE_TO_OPFS, TRACK])
  await joinWithPin(receiver.page, await startSending(sender.page, big))
  await offered(receiver.page).waitFor()
  await acceptBtn(receiver.page).click()
  await waitProgress(receiver.page, 40)
  await Promise.all([dropNetwork(sender.page), dropNetwork(receiver.page)])
  await waitPhase(receiver.page, 'interrupted', 30_000)
  await waitHist(receiver.page, 'done', 1, 300_000)
  await expectSaved(receiver.page, big)
})

await test('Signalling trouble alone does not interrupt a live transfer: only the link to Clip drops, the data keeps flowing', async (open) => {
  const sender = await open([TRACK])
  const receiver = await open([SAVE_TO_OPFS, TRACK])
  await joinWithPin(receiver.page, await startSending(sender.page, med))
  await offered(receiver.page).waitFor()
  await acceptBtn(receiver.page).click()
  await waitProgress(receiver.page, 20)
  await Promise.all([dropSignalling(sender.page), dropSignalling(receiver.page)])
  await sleep(1500)
  if ((await phase(receiver.page)) === 'interrupted') throw new Error('the receiver was interrupted by a signalling drop although the direct connection was fine')
  await waitHist(receiver.page, 'done', 1, 240_000)
  await expectSaved(receiver.page, med)
  // the sender's own link comes back and the room is usable again
  await sender.page.getByTestId('beam-sender-reconnecting').waitFor({ state: 'detached', timeout: 30_000 })
})

await test('A connection that goes silent (no errors, just nothing) is noticed by the heartbeat and recovered', async (open) => {
  const sender = await open([TRACK])
  const receiver = await open([SAVE_TO_OPFS, TRACK])
  await joinWithPin(receiver.page, await startSending(sender.page, big))
  await offered(receiver.page).waitFor()
  await acceptBtn(receiver.page).click()
  await waitProgress(receiver.page, 20)
  await receiver.page.evaluate(() => window.__mute()) // it stops acknowledging and pinging, but stays "connected"
  await waitLeg(sender.page, 0, 'paused', 60_000)
  await receiver.page.evaluate(() => window.__unmute())
  await waitPhase(receiver.page, ['interrupted', 'transferring'], 30_000)
  await waitPhase(receiver.page, 'transferring', 90_000)
  await waitHist(receiver.page, 'done', 1, 240_000)
  await expectSaved(receiver.page, big)
})

await test('Reconnect after closing the tab: a checkpoint kept the file, the next visit offers Reconnect, and the file completes', async (open) => {
  const sender = await open()
  const receiver = await open(SAVE_TO_OPFS)
  await joinWithPin(receiver.page, await startSending(sender.page, [tiny(221), big]))
  await takeFile(receiver.page, 1)
  await offered(receiver.page).waitFor()
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
  await waitHist(page2, 'done', 1, 300_000)
  await expectSaved(page2, big)
  await waitHist(sender.page, 'done', 2, 60_000, 0)
  await page2.getByTestId('beam-disconnect').click()
  await page2.getByRole('button', { name: 'Start over' }).click()
  await page2.waitForFunction(() => !document.querySelector('[data-unfinished]'))
})

await test('Reconnect: ending the connection while interrupted ends it for good and forgets the saved part', async (open) => {
  const sender = await open()
  const receiver = await open([SAVE_TO_OPFS, TRACK])
  await joinWithPin(receiver.page, await startSending(sender.page, med))
  await offered(receiver.page).waitFor()
  await acceptBtn(receiver.page).click()
  await waitProgress(receiver.page, 30)
  await dropNetwork(receiver.page)
  await waitPhase(receiver.page, 'interrupted', 20_000)
  await receiver.page.getByTestId('beam-disconnect').click()
  await receiver.page.locator('[data-receiver-session=ended]').waitFor()
  await receiver.page.getByRole('button', { name: 'Start over' }).click()
  await sleep(300)
  if (await receiver.page.locator('[data-unfinished]').count()) throw new Error('an ended transfer is still listed as unfinished')
})

await test('Reconnect: if the sender stops sharing while a receiver is interrupted, the receiver is told it cannot continue', async (open) => {
  const sender = await open()
  const receiver = await open([SAVE_TO_OPFS, TRACK])
  await joinWithPin(receiver.page, await startSending(sender.page, med))
  await offered(receiver.page).waitFor()
  await acceptBtn(receiver.page).click()
  await waitProgress(receiver.page, 30)
  await dropNetwork(receiver.page)
  await waitPhase(receiver.page, 'interrupted', 20_000)
  await sender.page.getByRole('button', { name: 'Stop sharing' }).click()
  await receiver.page.getByRole('button', { name: 'Reconnect' }).click()
  await waitPhase(receiver.page, ['error', 'ended'], 30_000)
  await receiver.page.getByText(/no longer sharing|stopped sharing/).first().waitFor()
  await receiver.page.getByRole('button', { name: 'Start over' }).click()
  if (await receiver.page.locator('[data-unfinished]').count()) throw new Error('an impossible transfer is still listed')
})

await test('Reconnect without the save dialog (Firefox/Safari style): the part is kept in the open page and carries on, then downloads', async (open) => {
  const sender = await open()
  const receiver = await open([NO_PICKERS, TRACK])
  await joinWithPin(receiver.page, await startSending(sender.page, mid))
  await offered(receiver.page).waitFor()
  const downloadPromise = receiver.page.waitForEvent('download', { timeout: 240_000 })
  await receiver.page.getByRole('button', { name: 'Accept and download' }).click()
  await waitProgress(receiver.page, 30)
  await dropNetwork(receiver.page)
  await waitPhase(receiver.page, 'interrupted', 20_000)
  await receiver.page.getByRole('button', { name: 'Reconnect' }).click()
  await waitPhase(receiver.page, 'transferring', 40_000)
  const download = await downloadPromise
  const out = join(DIR, `resumed-${mid.name}`)
  await download.saveAs(out)
  if (createHash('sha256').update(readFileSync(out)).digest('hex') !== mid.sha256) throw new Error('downloaded file does not match after resuming')
})

// ═══ Looks and layout ═══════════════════════════════════════════════════════

await test('phone width: no sideways scrolling on the start screen, a session with many files, or with several receivers', async (open) => {
  const { page } = await open(null, { viewport: { width: 375, height: 812 } })
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  if (await overflow()) throw new Error('start screen scrolls sideways')
  const pin = await startSending(page, [tiny(301), tiny(302), tiny(303), small])
  if (await overflow()) throw new Error('sender screen scrolls sideways')
  for (let i = 0; i < 3; i++) await connectReceiver(open, pin)
  await waitLeg(page, 2, 'connected')
  if (await overflow()) throw new Error('receiver list scrolls sideways')
})

if (process.env.BEAM_STRESS) {
  await test('stress: 400 MB to 2 receivers, hashes match on both', async (open) => {
    const gig = await makeFile('beam-400mb.bin', 400)
    const sender = await open()
    const pin = await startSending(sender.page, gig)
    const a = await connectReceiver(open, pin)
    const b = await connectReceiver(open, pin)
    await Promise.all([a, b].map((r) => acceptBtn(r.page).click()))
    await Promise.all([a, b].map((r) => waitHist(r.page, 'done', 1, 25 * 60_000)))
    await expectSaved(a.page, gig)
    await expectSaved(b.page, gig)
  })
}

await browser.close()
console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
