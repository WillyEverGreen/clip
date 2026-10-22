/**
 * End-to-end check of Clip Beam signalling against a REAL worker (BeamRoom Durable Object).
 *
 *   1. cd worker && npx wrangler dev --local --port 8799
 *   2. node scripts/e2e-beam-signal.mjs        (optionally: BASE=ws://127.0.0.1:8799)
 *
 * Not part of `npm test` because it needs a running worker; part of `npm run test:e2e`.
 */
import assert from 'node:assert/strict'
import http from 'node:http'

const BASE = process.env.BASE || 'ws://127.0.0.1:8799'
const HTTP = BASE.replace(/^ws/, 'http')
let passed = 0
let failed = 0
let ipCounter = Math.floor(Math.random() * 60000)

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  catch (err) { failed++; console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.stack || err}`) }
}

/** A signalling client that records every message and lets tests wait for a given type. */
class Client {
  constructor(pin, ip) {
    this.messages = []
    this.waiters = []
    this.closed = null
    // Each client gets its own IP so the join rate limit does not trip during the suite (local dev only)
    const fakeIp = ip || `10.77.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`
    this.ws = new WebSocket(`${BASE}/api/beam/ws${pin ? `?pin=${pin}` : ''}`, { headers: { 'CF-Connecting-IP': fakeIp } })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      this.messages.push(msg)
      this.waiters = this.waiters.filter((w) => !(w.type === msg.type && (w.resolve(msg), true)))
    }
    this.closedPromise = new Promise((resolve) => {
      this.ws.onclose = (ev) => { this.closed = { code: ev.code, reason: ev.reason }; resolve(this.closed) }
    })
    this.ws.onerror = () => {}
  }

  next(type, timeout = 5000) {
    const seen = this.messages.find((m) => m.type === type && !m._taken)
    if (seen) { seen._taken = true; return Promise.resolve(seen) }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}; got ${JSON.stringify(this.messages)}`)), timeout)
      this.waiters.push({ type, resolve: (m) => { clearTimeout(timer); m._taken = true; resolve(m) } })
    })
  }

  send(msg) { this.ws.send(JSON.stringify(msg)) }
  close() { try { this.ws.close() } catch {} }
}

/** GET with arbitrary headers (fetch refuses Upgrade); resolves the status, 101 for a WebSocket upgrade. */
function rawGet(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${HTTP}${path}`, { headers })
    req.on('response', (res) => { res.resume(); resolve(res.statusCode) })
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(101) })
    req.on('error', reject)
  })
}

const WS_HEADERS = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }

async function openRoom(offer = { name: 'movie.mkv', size: 734003200, type: 'video/x-matroska' }) {
  const sender = new Client()
  const { pin } = await sender.next('room_created')
  sender.send({ type: 'file_offer', offer })
  return { sender, pin }
}

console.log(`\n\x1b[1m\x1b[36mClip Beam signalling e2e\x1b[0m (${BASE})`)

await test('plain HTTP to /api/beam/ws gets 426, bad PIN gets 400', async () => {
  assert.equal(await rawGet('/api/beam/ws'), 426)
  assert.equal(await rawGet('/api/beam/ws?pin=12ab56', WS_HEADERS), 400)
})

await test('sender gets a 6-digit PIN; two senders get different PINs', async () => {
  const a = await openRoom()
  const b = await openRoom()
  assert.match(a.pin, /^\d{6}$/)
  assert.notEqual(a.pin, b.pin)
  a.sender.close(); b.sender.close()
})

await test('receiver joins with the PIN, sees the offer, and SDP/ICE relay both ways', async () => {
  const { sender, pin } = await openRoom()
  const receiver = new Client(pin)
  const joined = await receiver.next('joined')
  assert.deepEqual(joined.offer, { name: 'movie.mkv', size: 734003200, type: 'video/x-matroska' })
  await sender.next('peer_joined')

  receiver.send({ type: 'file_accept' })
  await sender.next('file_accept')
  const sdp = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' }
  sender.send({ type: 'signal', data: { sdp } })
  assert.deepEqual((await receiver.next('signal')).data.sdp, sdp)
  const candidate = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 }
  receiver.send({ type: 'signal', data: { candidate } })
  assert.deepEqual((await sender.next('signal')).data.candidate, candidate)

  sender.send({ type: 'ping' })
  await sender.next('pong')
  sender.close(); receiver.close()
})

await test('wrong PIN gets no_room and the socket is closed', async () => {
  const { sender, pin } = await openRoom()
  const wrong = String((Number(pin) + 1) % 1_000_000).padStart(6, '0')
  const receiver = new Client(wrong)
  const err = await receiver.next('error')
  assert.equal(err.code, 'no_room')
  assert.equal((await receiver.closedPromise).code, 4004)
  sender.close()
})

await test('a second receiver is turned away with room_full', async () => {
  const { sender, pin } = await openRoom()
  const first = new Client(pin)
  await first.next('joined')
  const second = new Client(pin)
  assert.equal((await second.next('error')).code, 'room_full')
  sender.close(); first.close()
})

await test('roles are enforced by the server (receiver cannot send file_offer)', async () => {
  const { sender, pin } = await openRoom()
  const receiver = new Client(pin)
  await receiver.next('joined')
  receiver.send({ type: 'file_offer', offer: { name: 'evil.exe', size: 1 } })
  assert.equal((await receiver.next('error')).code, 'bad_message')
  sender.close(); receiver.close()
})

await test('receiver leaving frees the PIN; sender leaving closes the receiver', async () => {
  const { sender, pin } = await openRoom()
  const r1 = new Client(pin)
  await r1.next('joined')
  r1.close()
  assert.equal((await sender.next('peer_left')).role, 'receiver')
  const r2 = new Client(pin)
  await r2.next('joined')
  sender.close()
  assert.equal((await r2.next('peer_left')).role, 'sender')
  await r2.closedPromise
  const r3 = new Client(pin)
  assert.equal((await r3.next('error')).code, 'no_room')
})

await test('PIN guessing is rate limited per IP', async () => {
  const ip = `10.99.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`
  let limited = false
  for (let i = 0; i < 25 && !limited; i++) {
    const status = await rawGet('/api/beam/ws?pin=000000', { ...WS_HEADERS, 'CF-Connecting-IP': ip })
    if (status === 429) limited = true
    else assert.equal(status, 101)
  }
  assert.ok(limited, 'expected a 429 within 25 joins')
})

console.log(`\n  ${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
