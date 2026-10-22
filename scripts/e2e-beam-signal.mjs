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
  constructor(pin, ip, name) {
    this.messages = []
    this.waiters = []
    this.closed = null
    // Each client gets its own IP so the join rate limit does not trip during the suite (local dev only)
    const fakeIp = ip || `10.77.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`
    const query = new URLSearchParams()
    if (pin) query.set('pin', pin)
    if (name) query.set('name', name)
    const qs = query.toString()
    this.ws = new WebSocket(`${BASE}/api/beam/ws${qs ? `?${qs}` : ''}`, { headers: { 'CF-Connecting-IP': fakeIp } })
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

const OFFER = { name: 'movie.mkv', size: 734003200, type: 'video/x-matroska' }

await test('plain HTTP to /api/beam/ws gets 426, bad PIN gets 400', async () => {
  assert.equal(await rawGet('/api/beam/ws'), 426)
  assert.equal(await rawGet('/api/beam/ws?pin=12ab56', WS_HEADERS), 400)
  assert.equal(await rawGet('/api/beam/ws?pin=1234567', WS_HEADERS), 400)
  assert.equal(await rawGet('/api/beam/ws?pin=', WS_HEADERS), 400)
})

await test('sender gets a 6-digit PIN; two senders get different PINs', async () => {
  const a = await openRoom()
  const b = await openRoom()
  assert.match(a.pin, /^\d{6}$/)
  assert.notEqual(a.pin, b.pin)
  a.sender.close(); b.sender.close()
})

await test('receiver joins with the PIN, sees the offer, and SDP/ICE relay both ways with ids', async () => {
  const { sender, pin } = await openRoom()
  const receiver = new Client(pin)
  const joined = await receiver.next('joined')
  assert.deepEqual(joined.offer, OFFER)
  const { id } = await sender.next('peer_joined')
  assert.match(id, /^r\d+$/)

  receiver.send({ type: 'file_accept' })
  assert.equal((await sender.next('file_accept')).from, id)
  const sdp = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' }
  sender.send({ type: 'signal', to: id, data: { sdp } })
  assert.deepEqual((await receiver.next('signal')).data.sdp, sdp)
  const candidate = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 }
  receiver.send({ type: 'signal', data: { candidate } })
  const back = await sender.next('signal')
  assert.deepEqual(back.data.candidate, candidate)
  assert.equal(back.from, id)

  sender.send({ type: 'ping' })
  await sender.next('pong')
  sender.close(); receiver.close()
})

await test('cute names: sender and receivers are named, duplicates get a number, and the sender hears each receiver name', async () => {
  const sender = new Client(undefined, undefined, 'Mochi')
  const created = await sender.next('room_created')
  assert.equal(created.name, 'Mochi')
  const a = new Client(created.pin, undefined, 'Mochi')
  const b = new Client(created.pin, undefined, 'Biscuit')
  const c = new Client(created.pin) // no name at all
  const [ja, jb, jc] = await Promise.all([a.next('joined'), b.next('joined'), c.next('joined')])
  assert.deepEqual([ja.name, jb.name, jc.name].sort(), ['Biscuit', 'Guest', 'Mochi 2'])
  assert.equal(jb.name, 'Biscuit')
  assert.ok([ja, jb, jc].every((j) => j.sender === 'Mochi'))
  const seen = []
  for (let i = 0; i < 3; i++) seen.push((await sender.next('peer_joined')).name)
  assert.deepEqual(seen.sort(), ['Biscuit', 'Guest', 'Mochi 2'])
  sender.close(); a.close(); b.close(); c.close()
})

await test('cute names: hostile names are cleaned (control characters, length, markup stays text)', async () => {
  const sender = new Client(undefined, undefined, 'x'.repeat(200))
  const created = await sender.next('room_created')
  assert.equal(created.name.length, 24)
  const r = new Client(created.pin, undefined, '<img src=x onerror=alert(1)>\u0007 ok')
  const joined = await r.next('joined')
  assert.ok(!/[\u0000-\u001f]/.test(joined.name))
  assert.ok(joined.name.length <= 24)
  sender.close(); r.close()
})

await test('wrong PIN gets no_room and the socket is closed', async () => {
  const { sender, pin } = await openRoom()
  const wrong = String((Number(pin) + 1) % 1_000_000).padStart(6, '0')
  const receiver = new Client(wrong)
  assert.equal((await receiver.next('error')).code, 'no_room')
  assert.equal((await receiver.closedPromise).code, 4004)
  sender.close()
})

await test('8 receivers join one room, the 9th is turned away, and the first 8 are unaffected', async () => {
  const { sender, pin } = await openRoom()
  const receivers = []
  for (let i = 0; i < 8; i++) {
    const r = new Client(pin)
    await r.next('joined')
    receivers.push(r)
  }
  const ids = []
  for (let i = 0; i < 8; i++) ids.push((await sender.next('peer_joined')).id)
  assert.equal(new Set(ids).size, 8)
  const ninth = new Client(pin)
  assert.equal((await ninth.next('error')).code, 'room_full')
  assert.equal((await ninth.closedPromise).code, 4009)
  assert.ok(receivers.every((r) => r.closed === null))
  sender.close(); receivers.forEach((r) => r.close())
})

await test('signals go only to the receiver they are addressed to (no cross-talk between 5 receivers)', async () => {
  const { sender, pin } = await openRoom()
  const rs = []
  for (let i = 0; i < 5; i++) { const r = new Client(pin); await r.next('joined'); rs.push(r) }
  const ids = []
  for (let i = 0; i < 5; i++) ids.push((await sender.next('peer_joined')).id)
  for (let i = 0; i < 5; i++) sender.send({ type: 'signal', to: ids[i], data: { n: i } })
  for (let i = 0; i < 5; i++) assert.equal((await rs[i].next('signal')).data.n, i)
  await new Promise((r) => setTimeout(r, 200))
  for (let i = 0; i < 5; i++) assert.equal(rs[i].messages.filter((m) => m.type === 'signal').length, 1)
  // and each one's reply is tagged with its own id
  for (let i = 0; i < 5; i++) rs[i].send({ type: 'signal', data: { who: i } })
  const seen = new Map()
  for (let i = 0; i < 5; i++) { const m = await sender.next('signal'); seen.set(m.from, m.data.who) }
  for (let i = 0; i < 5; i++) assert.equal(seen.get(ids[i]), i)
  sender.close(); rs.forEach((r) => r.close())
})

await test('a late receiver gets the offer; a changed offer reaches everyone already in', async () => {
  const { sender, pin } = await openRoom()
  const a = new Client(pin)
  await a.next('joined')
  sender.send({ type: 'file_offer', offer: { ...OFFER, name: 'renamed.mkv' } })
  assert.equal((await a.next('file_offer')).offer.name, 'renamed.mkv')
  const b = new Client(pin)
  assert.equal((await b.next('joined')).offer.name, 'renamed.mkv')
  sender.close(); a.close(); b.close()
})

await test('roles are enforced by the server (receiver cannot offer, sender cannot accept)', async () => {
  const { sender, pin } = await openRoom()
  const receiver = new Client(pin)
  await receiver.next('joined')
  receiver.send({ type: 'file_offer', offer: { name: 'evil.exe', size: 1 } })
  assert.equal((await receiver.next('error')).code, 'bad_message')
  sender.send({ type: 'file_accept' })
  assert.equal((await sender.next('error')).code, 'bad_message')
  sender.send({ type: 'file_offer', offer: { name: 'x', size: 'huge' } })
  assert.equal((await sender.next('error')).code, 'bad_offer')
  sender.close(); receiver.close()
})

await test('a receiver cannot impersonate another receiver', async () => {
  const { sender, pin } = await openRoom()
  const a = new Client(pin); await a.next('joined')
  const b = new Client(pin); await b.next('joined')
  const idA = (await sender.next('peer_joined')).id
  const idB = (await sender.next('peer_joined')).id
  b.send({ type: 'signal', from: idA, data: { forged: true } })
  const m = await sender.next('signal')
  assert.equal(m.from, idB)
  sender.close(); a.close(); b.close()
})

await test('one receiver leaving does not disturb the others; sender leaving closes them all', async () => {
  const { sender, pin } = await openRoom()
  const r1 = new Client(pin); await r1.next('joined')
  const r2 = new Client(pin); await r2.next('joined')
  const id1 = (await sender.next('peer_joined')).id
  await sender.next('peer_joined')
  r1.close()
  const left = await sender.next('peer_left')
  assert.deepEqual([left.role, left.id], ['receiver', id1])
  assert.equal(r2.closed, null)
  r2.send({ type: 'file_accept' })
  await sender.next('file_accept')
  sender.close()
  assert.equal((await r2.next('peer_left')).role, 'sender')
  await r2.closedPromise
  const r3 = new Client(pin)
  assert.equal((await r3.next('error')).code, 'no_room')
})

await test('garbage: invalid JSON, binary frames, huge frames, rapid pings; the room still works afterwards', async () => {
  const { sender, pin } = await openRoom()
  const r = new Client(pin)
  await r.next('joined'); await sender.next('peer_joined')
  r.ws.send('{{{{ not json')
  r.ws.send(new Uint8Array([1, 2, 3, 255]))
  r.ws.send('x'.repeat(70_000))
  r.ws.send('[]'); r.ws.send('null'); r.ws.send('123'); r.ws.send('"str"')
  for (let i = 0; i < 300; i++) r.send({ type: 'ping' })
  await new Promise((res) => setTimeout(res, 400))
  assert.equal(r.closed, null)
  assert.ok(r.messages.filter((m) => m.type === 'pong').length >= 300)
  assert.ok(r.messages.some((m) => m.code === 'too_large'))
  assert.ok(r.messages.filter((m) => m.code === 'bad_message').length >= 4)
  r.send({ type: 'signal', data: { still: 'alive' } })
  assert.deepEqual((await sender.next('signal')).data, { still: 'alive' })
  sender.close(); r.close()
})

await test('stress: 40 rooms with 3 receivers each run at once with no message crossing rooms', async () => {
  const ROOMS = 40
  const rooms = await Promise.all(Array.from({ length: ROOMS }, async (_, i) => {
    const sender = new Client()
    const { pin } = await sender.next('room_created')
    sender.send({ type: 'file_offer', offer: { name: `room-${i}.bin`, size: i + 1, type: '' } })
    const receivers = await Promise.all([0, 1, 2].map(async () => {
      const r = new Client(pin)
      const joined = await r.next('joined')
      assert.equal(joined.offer?.name ?? `room-${i}.bin`, `room-${i}.bin`)
      return r
    }))
    const ids = []
    for (let k = 0; k < 3; k++) ids.push((await sender.next('peer_joined')).id)
    return { i, sender, receivers, ids }
  }))
  const pins = new Set()
  await Promise.all(rooms.map(async ({ i, sender, receivers, ids }) => {
    for (let round = 0; round < 20; round++) {
      receivers.forEach((r, k) => r.send({ type: 'signal', data: { room: i, k, round } }))
      sender.send({ type: 'signal', to: ids[round % 3], data: { room: i, round } })
    }
    for (let n = 0; n < 60; n++) {
      const m = await sender.next('signal')
      assert.equal(m.data.room, i, 'message crossed rooms')
    }
    for (let round = 0; round < 20; round++) await receivers[round % 3].next('signal')
    for (const r of receivers) for (const m of r.messages) if (m.type === 'signal') assert.equal(m.data.room, i)
    pins.add(i)
  }))
  assert.equal(pins.size, ROOMS)
  for (const { sender, receivers } of rooms) { sender.close(); receivers.forEach((r) => r.close()) }
})

await test('churn: 30 receivers join and leave one room quickly, then a real one still gets through', async () => {
  const { sender, pin } = await openRoom()
  for (let i = 0; i < 30; i++) {
    const r = new Client(pin)
    await r.next('joined')
    r.close()
    await r.closedPromise
  }
  const final = new Client(pin)
  assert.deepEqual((await final.next('joined')).offer, OFFER)
  let lefts = 0
  await new Promise((res) => {
    const t = setInterval(() => {
      lefts = sender.messages.filter((m) => m.type === 'peer_left').length
      if (lefts >= 30) { clearInterval(t); res() }
    }, 50)
    setTimeout(() => { clearInterval(t); res() }, 5000)
  })
  assert.equal(lefts, 30)
  sender.close(); final.close()
})

await test('PIN guessing is rate limited per IP', async () => {
  const ip = `10.99.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`
  let limited = false
  for (let i = 0; i < 50 && !limited; i++) {
    const status = await rawGet('/api/beam/ws?pin=000000', { ...WS_HEADERS, 'CF-Connecting-IP': ip })
    if (status === 429) limited = true
    else assert.equal(status, 101)
  }
  assert.ok(limited, 'expected a 429 within 50 joins')
})

console.log(`\n  ${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
