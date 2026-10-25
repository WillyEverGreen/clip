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
  constructor(pin, ip, name, token, resume) {
    this.messages = []
    this.waiters = []
    this.closed = null
    // Each client gets its own IP so the join rate limit does not trip during the suite (local dev only)
    const fakeIp = ip || `10.77.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`
    const query = new URLSearchParams()
    if (pin) query.set('pin', pin)
    if (name) query.set('name', name)
    if (token) query.set('token', token)
    if (resume) query.set('resume', '1')
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
  /** Close the way a lost connection or closed tab looks to the server (any code but 1000 / no code). */
  drop() { try { this.ws.close(4000, 'lost') } catch {} }
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

/** A nearby-lobby client. Everyone in one test shares `ip`, so they land in the same lobby group. */
class Lobby {
  constructor(role, name, ip) {
    this.messages = []
    this.waiters = []
    this.closed = null
    const query = new URLSearchParams({ role })
    if (name) query.set('name', name)
    this.ws = new WebSocket(`${BASE}/api/beam/lobby/ws?${query}`, { headers: { 'CF-Connecting-IP': ip } })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      this.messages.push(msg)
      this.waiters = this.waiters.filter((w) => !(w.test(msg) && (w.resolve(msg), true)))
    }
    this.closedPromise = new Promise((resolve) => { this.ws.onclose = (ev) => { this.closed = ev.code; resolve(ev.code) } })
    this.ws.onerror = () => {}
  }

  /** Waits for a message of `type` (optionally also matching `where`), including ones that already arrived. */
  next(type, where = () => true, timeout = 5000) {
    const hit = this.messages.find((m) => m.type === type && !m._taken && where(m))
    if (hit) { hit._taken = true; return Promise.resolve(hit) }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}; got ${JSON.stringify(this.messages)}`)), timeout)
      this.waiters.push({ test: (m) => m.type === type && where(m), resolve: (m) => { clearTimeout(timer); m._taken = true; resolve(m) } })
    })
  }

  /** Resolves with the latest `peers` list once `where` holds for it. */
  peersWhere(where, timeout = 5000) {
    const check = () => { const l = this.messages.filter((m) => m.type === 'peers').at(-1); return l && where(l.peers) ? l.peers : null }
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const t = setInterval(() => {
        const ok = check()
        if (ok) { clearInterval(t); resolve(ok) }
        else if (Date.now() - started > timeout) { clearInterval(t); reject(new Error(`peers never matched; last ${JSON.stringify(this.messages.filter((m) => m.type === 'peers').at(-1))}`)) }
      }, 25)
    })
  }

  send(msg) { this.ws.send(JSON.stringify(msg)) }
  close() { try { this.ws.close() } catch {} }
}

const lobbyIp = () => `10.${200 + Math.floor(Math.random() * 50)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`

await test('nearby: bad role gets 400, plain HTTP gets 426', async () => {
  assert.equal(await rawGet('/api/beam/lobby/ws?role=admin', { ...WS_HEADERS, 'CF-Connecting-IP': lobbyIp() }), 400)
  assert.equal(await rawGet('/api/beam/lobby/ws', { 'CF-Connecting-IP': lobbyIp() }), 426)
  assert.equal(await rawGet('/api/beam/lobby/ws?role=receiver', { 'CF-Connecting-IP': lobbyIp() }), 426)
})

await test('nearby: receivers on the same network appear to the sender; other networks, other receivers and senders see nothing', async () => {
  const ip = lobbyIp()
  const sender = new Lobby('sender', 'Sunny', ip)
  const a = new Lobby('receiver', 'Mochi', ip)
  const b = new Lobby('receiver', 'Biscuit', ip)
  const otherNetwork = lobbyIp()
  const stranger = new Lobby('sender', 'Elsewhere', otherNetwork)
  const strangerReceiver = new Lobby('receiver', 'Faraway', otherNetwork)
  const peers = await sender.peersWhere((l) => l.length === 2)
  assert.deepEqual(peers.map((p) => p.name).sort(), ['Biscuit', 'Mochi'])
  assert.ok(peers.every((p) => Object.keys(p).sort().join() === 'id,name'))
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(a.messages.filter((m) => m.type === 'peers').length, 0, 'receiver saw a peer list')
  assert.equal(b.messages.filter((m) => m.type === 'peers').length, 0)
  assert.deepEqual((await stranger.peersWhere((l) => l.length === 1)).map((p) => p.name), ['Faraway'])
  assert.ok(stranger.messages.every((m) => m.type !== 'peers' || m.peers.every((p) => p.name !== 'Mochi' && p.name !== 'Biscuit')))
  assert.equal(strangerReceiver.messages.filter((m) => m.type === 'peers').length, 0)
  for (const c of [sender, a, b, stranger, strangerReceiver]) c.close()
})

await test('nearby: closing the tab (socket) removes a receiver from the radar', async () => {
  const ip = lobbyIp()
  const sender = new Lobby('sender', 'Sunny', ip)
  const a = new Lobby('receiver', 'Mochi', ip)
  const b = new Lobby('receiver', 'Biscuit', ip)
  await sender.peersWhere((l) => l.length === 2)
  a.close()
  assert.deepEqual((await sender.peersWhere((l) => l.length === 1)).map((p) => p.name), ['Biscuit'])
  await a.closedPromise
  sender.close(); b.close()
})

await test('nearby: names are unique across the group even when everyone asks for the same one', async () => {
  const ip = lobbyIp()
  const sender = new Lobby('sender', 'Mochi', ip)
  const rs = [new Lobby('receiver', 'Mochi', ip), new Lobby('receiver', 'Mochi', ip), new Lobby('receiver', undefined, ip)]
  const names = [(await sender.next('welcome')).name, ...await Promise.all(rs.map(async (r) => (await r.next('welcome')).name))]
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, 4)
  assert.equal(names[0], 'Mochi')
  sender.close(); rs.forEach((r) => r.close())
})

await test('nearby: invite to several receivers, one accepts and joins the room, one declines and blocks, one is not asked', async () => {
  const ip = lobbyIp()
  const room = await openRoom({ name: 'holiday.mov', size: 4200000000, type: 'video/quicktime' })
  const sender = new Lobby('sender', 'Sunny', ip)
  const [a, b, c] = ['Mochi', 'Biscuit', 'Pudding'].map((n) => new Lobby('receiver', n, ip))
  const peers = await sender.peersWhere((l) => l.length === 3)
  const id = Object.fromEntries(peers.map((p) => [p.name, p.id]))

  sender.send({ type: 'invite', to: [id.Mochi, id.Biscuit], pin: room.pin, offer: { name: 'holiday.mov', size: 4200000000, type: 'video/quicktime' } })
  const invA = await a.next('invite')
  const invB = await b.next('invite')
  assert.equal(invA.from.name, 'Sunny')
  assert.equal(invA.pin, room.pin)
  assert.equal(invA.offer.name, 'holiday.mov')
  assert.equal(c.messages.filter((m) => m.type === 'invite').length, 0)
  await sender.next('invite_sent', (m) => m.to === id.Mochi)

  // Mochi accepts: tells the sender, then joins the room with the PIN
  a.send({ type: 'accept', inviteId: invA.inviteId })
  assert.equal((await sender.next('invite_accepted')).to, id.Mochi)
  const joined = new Client(room.pin, undefined, 'Mochi')
  assert.equal((await joined.next('joined')).offer.name, 'holiday.mov')
  assert.equal((await room.sender.next('peer_joined')).name, 'Mochi')

  // Biscuit declines and blocks the sender
  b.send({ type: 'decline', inviteId: invB.inviteId, block: true })
  const closed = await sender.next('invite_closed', (m) => m.to === id.Biscuit)
  assert.equal(closed.reason, 'declined')
  sender.send({ type: 'invite', to: [id.Biscuit], pin: room.pin, offer: { name: 'again.mov', size: 1, type: '' } })
  const again = await sender.next('invite_closed', (m) => m.to === id.Biscuit)
  assert.equal(again.reason, 'declined')
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(b.messages.filter((m) => m.type === 'invite').length, 1, 'a blocked sender reached the receiver')

  for (const x of [sender, a, b, c, joined, room.sender]) x.close()
})

await test('nearby: a sender stopping (cancel_invites, or closing) withdraws open requests', async () => {
  const ip = lobbyIp()
  const sender = new Lobby('sender', 'Sunny', ip)
  const a = new Lobby('receiver', 'Mochi', ip)
  const peers = await sender.peersWhere((l) => l.length === 1)
  const offer = { name: 'x.bin', size: 1, type: '' }
  sender.send({ type: 'invite', to: [peers[0].id], pin: '123456', offer })
  await a.next('invite')
  sender.send({ type: 'cancel_invites' })
  await a.next('invite_gone')
  sender.send({ type: 'invite', to: [peers[0].id], pin: '123456', offer })
  const second = await a.next('invite')
  sender.close()
  assert.equal((await a.next('invite_gone')).inviteId, second.inviteId)
  a.close()
})

await test('nearby: a receiver going away tells the sender its request is closed', async () => {
  const ip = lobbyIp()
  const sender = new Lobby('sender', 'Sunny', ip)
  const a = new Lobby('receiver', 'Mochi', ip)
  const peers = await sender.peersWhere((l) => l.length === 1)
  sender.send({ type: 'invite', to: [peers[0].id], pin: '123456', offer: { name: 'x.bin', size: 1, type: '' } })
  await a.next('invite')
  a.close()
  assert.equal((await sender.next('invite_closed')).reason, 'left')
  sender.close()
})

await test('nearby: garbage, forged and out-of-role messages are refused and the lobby keeps working', async () => {
  const ip = lobbyIp()
  const sender = new Lobby('sender', 'Sunny', ip)
  const a = new Lobby('receiver', 'Mochi', ip)
  const b = new Lobby('receiver', 'Biscuit', ip)
  const peers = await sender.peersWhere((l) => l.length === 2)
  a.ws.send('{{{'); a.ws.send(new Uint8Array([1, 2, 3])); a.ws.send('x'.repeat(70_000)); a.ws.send('[]')
  a.send({ type: 'invite', to: [peers[0].id], pin: '123456', offer: { name: 'x', size: 1 } }) // receivers cannot invite
  a.send({ type: 'accept', inviteId: 'i1' }) // nothing to accept
  for (let i = 0; i < 200; i++) a.send({ type: 'ping' })
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(a.closed, null)
  assert.ok(a.messages.filter((m) => m.type === 'pong').length >= 200)
  assert.equal(b.messages.filter((m) => m.type === 'invite').length, 0)
  // b cannot answer an invite that was sent to a
  sender.send({ type: 'invite', to: [peers.find((p) => p.name === 'Mochi').id], pin: '123456', offer: { name: 'x', size: 1, type: '' } })
  const inv = await a.next('invite')
  b.send({ type: 'accept', inviteId: inv.inviteId })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(sender.messages.filter((m) => m.type === 'invite_accepted').length, 0)
  a.send({ type: 'accept', inviteId: inv.inviteId })
  await sender.next('invite_accepted')
  for (const x of [sender, a, b]) x.close()
})

await test('nearby stress: 60 receivers and 5 senders in one group, then half leave at once; every sender sees the same list', async () => {
  const ip = lobbyIp()
  const senders = Array.from({ length: 5 }, (_, i) => new Lobby('sender', `S${i}`, ip))
  const receivers = Array.from({ length: 60 }, (_, i) => new Lobby('receiver', `R${i}`, ip))
  await Promise.all(senders.map((s) => s.peersWhere((l) => l.length === 60, 10000)))
  receivers.slice(0, 30).forEach((r) => r.close())
  const lists = await Promise.all(senders.map((s) => s.peersWhere((l) => l.length === 30, 10000)))
  const first = JSON.stringify(lists[0].map((p) => p.id).sort())
  for (const l of lists) assert.equal(JSON.stringify(l.map((p) => p.id).sort()), first)
  assert.ok(lists[0].every((p) => Number(p.name.slice(1)) >= 30))
  senders.forEach((s) => s.close()); receivers.forEach((r) => r.close())
})

await test('nearby: lobby connections are rate limited per IP', async () => {
  const ip = lobbyIp()
  let limited = false
  for (let i = 0; i < 300 && !limited; i++) {
    const status = await rawGet('/api/beam/lobby/ws?role=receiver', { ...WS_HEADERS, 'CF-Connecting-IP': ip })
    if (status === 429) limited = true
    else assert.equal(status, 101)
  }
  assert.ok(limited, 'expected a 429 within 300 connections')
})

await test('reconnect: a sender that loses its connection keeps its room; receivers stay and are told', async () => {
  const sender = new Client(undefined, undefined, 'Mochi')
  const created = await sender.next('room_created')
  assert.ok(created.token)
  sender.send({ type: 'file_offer', offer: OFFER })
  const a = new Client(created.pin, undefined, 'Biscuit')
  const b = new Client(created.pin, undefined, 'Pudding')
  await a.next('joined'); await b.next('joined')
  const ids = [(await sender.next('peer_joined')).id, (await sender.next('peer_joined')).id]
  sender.drop()
  assert.equal((await a.next('sender_away')).type, 'sender_away')
  await b.next('sender_away')
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(a.closed, null)
  assert.equal(b.closed, null)

  // a brand new receiver is told to try again; a returning one (resume) may wait
  const fresh = new Client(created.pin, undefined, 'Newbie')
  assert.equal((await fresh.next('error')).code, 'sender_away')
  assert.equal(await fresh.closedPromise.then((c) => c.code), 4011)
  const returning = new Client(created.pin, undefined, 'Biscuit', undefined, true)
  const rejoin = await returning.next('joined')
  assert.equal(rejoin.away, true)
  assert.deepEqual(rejoin.offer, OFFER)

  // the sender takes the room back with its token: same PIN, receivers re-announced, traffic flows again
  const back = new Client(created.pin, undefined, 'Mochi', created.token)
  const resumed = await back.next('room_resumed')
  assert.equal(resumed.pin, created.pin)
  const seen = []
  for (let i = 0; i < 3; i++) seen.push((await back.next('peer_joined')).id)
  assert.ok(ids.every((id) => seen.includes(id)))
  await a.next('sender_back')
  a.send({ type: 'file_accept', data: { rk: 'abc', have: 1234 } })
  const accept = await back.next('file_accept')
  assert.deepEqual(accept.data, { rk: 'abc', have: 1234 })
  back.send({ type: 'signal', to: accept.from, data: { n: 1 } })
  assert.deepEqual((await a.next('signal')).data, { n: 1 })
  for (const x of [back, a, b, returning]) x.close()
})

await test('reconnect: only the right token takes a held room back, and only once; a deliberate close ends it', async () => {
  const sender = new Client(undefined, undefined, 'Mochi')
  const created = await sender.next('room_created')
  const a = new Client(created.pin); await a.next('joined')
  sender.drop()
  await a.next('sender_away')
  for (const bad of ['wrong', 'x'.repeat(30)]) {
    const p = new Client(created.pin, undefined, 'Mochi', bad)
    assert.equal((await p.next('error')).code, 'no_room')
  }
  const back = new Client(created.pin, undefined, 'Mochi', created.token)
  await back.next('room_resumed')
  const twice = new Client(created.pin, undefined, 'Mochi', created.token)
  assert.equal((await twice.next('error')).code, 'no_room')
  // a deliberate close (Stop sharing) is final: receivers are closed and the PIN is free
  back.close()
  assert.equal((await a.next('peer_left')).role, 'sender')
  await a.closedPromise
  const after = new Client(created.pin, undefined, 'Biscuit', undefined, true)
  assert.equal((await after.next('error')).code, 'no_room')
})

await test('reconnect: a receiver that drops frees its slot and can come straight back under the same name', async () => {
  const sender = new Client(undefined, undefined, 'Mochi')
  const created = await sender.next('room_created')
  sender.send({ type: 'file_offer', offer: OFFER })
  const a = new Client(created.pin, undefined, 'Biscuit')
  assert.equal((await a.next('joined')).name, 'Biscuit')
  const first = await sender.next('peer_joined')
  a.drop()
  assert.equal((await sender.next('peer_left')).id, first.id)
  const again = new Client(created.pin, undefined, 'Biscuit', undefined, true)
  assert.equal((await again.next('joined')).name, 'Biscuit')
  const second = await sender.next('peer_joined')
  assert.notEqual(second.id, first.id)
  assert.equal(second.name, 'Biscuit')
  sender.close(); again.close()
})

await test('ICE servers endpoint always returns STUN, never breaks, and is not cached', async () => {
  const res = await fetch(`${HTTP}/api/beam/ice`, { headers: { 'CF-Connecting-IP': lobbyIp() } })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('cache-control') ?? '', /no-store/)
  const json = await res.json()
  assert.ok(Array.isArray(json.iceServers) && json.iceServers.length >= 1)
  assert.ok(json.iceServers.every((s) => s.urls))
  assert.ok(json.iceServers.some((s) => String(s.urls).startsWith('stun:')))
  assert.equal(typeof json.turn, 'boolean')
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
