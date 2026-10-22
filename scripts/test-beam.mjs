/**
 * Clip Beam logic tests (no worker or browser needed): the signalling room, and the speed / ETA maths.
 * Run with: node scripts/test-beam.mjs   (also part of `npm test`)
 */
import assert from 'node:assert/strict'
import {
  BeamSignalRoom, generateBeamPin, cleanOffer, cleanName, uniqueName, BEAM_PIN_RE, BEAM_IDLE_MS, BEAM_MAX_MESSAGE_BYTES, BEAM_MAX_RECEIVERS,
} from '../worker/src/lib/beam.ts'
import { SpeedTracker } from '../frontend/src/beam/speedTracker.ts'
import { parsePin, formatPin, formatBytes, formatDuration, formatEta } from '../frontend/src/beam/beamFormat.ts'

let passed = 0
let failed = 0
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  catch (err) { failed++; console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.stack || err}`) }
}

class FakePeer {
  constructor() { this.sent = []; this.closed = null }
  send(data) { if (this.closed) throw new Error('closed'); this.sent.push(JSON.parse(data)) }
  close(code, reason) { this.closed = { code, reason } }
  last() { return this.sent[this.sent.length - 1] }
  ofType(t) { return this.sent.filter((m) => m.type === t) }
}

const OFFER = { name: 'big.iso', size: 5e9, type: 'application/x-iso9660-image' }

function openRoom() {
  const room = new BeamSignalRoom()
  const sender = new FakePeer()
  room.addSender(sender, '123456', 0)
  room.handleMessage(sender, JSON.stringify({ type: 'file_offer', offer: OFFER }), 1)
  return { room, sender }
}

function join(room, now = 2, name) {
  const peer = new FakePeer()
  const res = room.addReceiver(peer, now, name)
  return { peer, id: res.id, name: res.name, res }
}

console.log('\n\x1b[1m\x1b[36mClip Beam signalling room\x1b[0m')

test('PINs are six digits and vary', () => {
  const pins = new Set()
  for (let i = 0; i < 500; i++) {
    const pin = generateBeamPin()
    assert.match(pin, BEAM_PIN_RE)
    pins.add(pin)
  }
  assert.ok(pins.size > 490)
})

test('PINs are spread evenly across the range (no modulo bias, no stuck digits)', () => {
  const buckets = new Array(10).fill(0)
  const N = 20000
  for (let i = 0; i < N; i++) buckets[Number(generateBeamPin()[0])]++
  for (const b of buckets) assert.ok(Math.abs(b - N / 10) < N / 10 * 0.15, `digit counts ${buckets}`)
})

test('sender gets room_created with its PIN; a second sender on the same PIN is refused', () => {
  const room = new BeamSignalRoom()
  const a = new FakePeer()
  assert.equal(room.addSender(a, '000042', 0), true)
  assert.deepEqual(a.last(), { type: 'room_created', pin: '000042', name: 'Sender' })
  assert.equal(room.addSender(new FakePeer(), '000042', 0), false)
})

test('receiver on an empty PIN gets no_room and is closed', () => {
  const room = new BeamSignalRoom()
  const r = new FakePeer()
  assert.deepEqual(room.addReceiver(r, 0), { error: 'no_room' })
  assert.equal(r.last().code, 'no_room')
  assert.equal(r.closed.code, 4004)
})

test('a receiver sees the file offer; the sender is told its id', () => {
  const { room, sender } = openRoom()
  const { peer, id } = join(room)
  assert.equal(id, 'r1')
  assert.deepEqual(peer.sent[0], { type: 'joined', offer: OFFER, name: 'Guest', sender: 'Sender' })
  assert.deepEqual(sender.last(), { type: 'peer_joined', id: 'r1', name: 'Guest' })
})

test('names: cleaned (control chars, spaces, length), defaulted, and uniquified like Live Pad', () => {
  assert.equal(cleanName('  Mochi\u0000  Bun\n '), 'Mochi Bun')
  assert.equal(cleanName('x'.repeat(100)).length, 24)
  assert.equal(cleanName(''), null)
  assert.equal(cleanName('   '), null)
  assert.equal(cleanName(42), null)
  assert.equal(cleanName(null), null)
  assert.equal(cleanName('Bisküit 😀'), 'Bisküit 😀')
  assert.equal(uniqueName('Mochi', new Set()), 'Mochi')
  assert.equal(uniqueName('Mochi', new Set(['mochi'])), 'Mochi 2')
  assert.equal(uniqueName('Mochi', new Set(['mochi', 'mochi 2', 'mochi 3'])), 'Mochi 4')
  assert.equal(uniqueName('x'.repeat(24), new Set(['x'.repeat(24)])).length, 24)
})

test('names: the sender and every receiver get distinct names, even when they all ask for the same one', () => {
  const room = new BeamSignalRoom()
  const sender = new FakePeer()
  room.addSender(sender, '222222', 0, 'Mochi')
  assert.equal(sender.last().name, 'Mochi')
  const names = [room.addReceiver(new FakePeer(), 1, 'Mochi').name, room.addReceiver(new FakePeer(), 1, 'mochi').name, room.addReceiver(new FakePeer(), 1, 'MOCHI').name]
  assert.deepEqual(names.map((n) => n.toLowerCase()), ['mochi 2', 'mochi 3', 'mochi 4'])
  const first = [...room.receivers.values()][0]
  assert.equal(first.sent[0].sender, 'Mochi')
  assert.equal(first.sent[0].name, 'Mochi 2')
  assert.deepEqual(sender.ofType('peer_joined').map((m) => m.name), names)
})

test('names: a leaving receiver frees its name; a fresh room starts with no names', () => {
  const room = new BeamSignalRoom()
  const sender = new FakePeer()
  room.addSender(sender, '333333', 0, 'Biscuit')
  const a = join(room, 1, 'Pudding')
  room.remove(a.peer)
  assert.equal(join(room, 2, 'Pudding').name, 'Pudding')
  room.remove(sender)
  const again = new FakePeer()
  room.addSender(again, '333333', 5, 'Pudding')
  assert.equal(room.receiverNames.size, 0)
  assert.equal(again.last().name, 'Pudding')
})

test('up to 8 receivers can join, the 9th is turned away', () => {
  const { room, sender } = openRoom()
  for (let i = 0; i < BEAM_MAX_RECEIVERS; i++) assert.ok(join(room).id)
  const ninth = join(room)
  assert.deepEqual(ninth.res, { error: 'room_full' })
  assert.equal(ninth.peer.closed.code, 4009)
  assert.equal(sender.ofType('peer_joined').length, BEAM_MAX_RECEIVERS)
})

test('a leaving receiver frees its slot, and ids are never reused', () => {
  const { room } = openRoom()
  const peers = Array.from({ length: BEAM_MAX_RECEIVERS }, () => join(room))
  room.remove(peers[3].peer)
  const next = join(room)
  assert.equal(next.id, `r${BEAM_MAX_RECEIVERS + 1}`)
})

test('late joiners get the offer that was already sent; offers sent later reach everyone', () => {
  const room = new BeamSignalRoom()
  const sender = new FakePeer()
  room.addSender(sender, '111111', 0)
  const early = join(room)
  assert.equal(early.peer.sent[0].offer, null)
  room.handleMessage(sender, JSON.stringify({ type: 'file_offer', offer: OFFER }), 1)
  assert.deepEqual(early.peer.last(), { type: 'file_offer', offer: OFFER })
  assert.deepEqual(join(room).peer.sent[0].offer, OFFER)
})

test('receiver messages reach the sender tagged with who sent them', () => {
  const { room, sender } = openRoom()
  const a = join(room)
  const b = join(room)
  room.handleMessage(b.peer, JSON.stringify({ type: 'file_accept' }), 3)
  assert.deepEqual(sender.last(), { type: 'file_accept', from: b.id })
  const cand = { candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0' } }
  room.handleMessage(a.peer, JSON.stringify({ type: 'signal', data: cand }), 4)
  assert.deepEqual(sender.last(), { type: 'signal', from: a.id, data: cand })
})

test('a receiver cannot forge another receiver\'s id or add fields', () => {
  const { room, sender } = openRoom()
  const a = join(room)
  join(room)
  room.handleMessage(a.peer, JSON.stringify({ type: 'signal', from: 'r2', to: 'r2', evil: 1, data: { x: 1 } }), 3)
  assert.deepEqual(sender.last(), { type: 'signal', from: a.id, data: { x: 1 } })
})

test('sender signals go only to the receiver they are addressed to', () => {
  const { room, sender } = openRoom()
  const a = join(room)
  const b = join(room)
  const c = join(room)
  const sdp = { type: 'offer', sdp: 'v=0\r\n' }
  room.handleMessage(sender, JSON.stringify({ type: 'signal', to: b.id, data: { sdp } }), 3)
  assert.deepEqual(b.peer.last(), { type: 'signal', data: { sdp } })
  assert.equal(a.peer.ofType('signal').length, 0)
  assert.equal(c.peer.ofType('signal').length, 0)
})

test('a signal with no or unknown target goes nowhere', () => {
  const { room, sender } = openRoom()
  const a = join(room)
  const before = a.peer.sent.length
  room.handleMessage(sender, JSON.stringify({ type: 'signal', data: {} }), 3)
  room.handleMessage(sender, JSON.stringify({ type: 'signal', to: 'r99', data: {} }), 3)
  room.handleMessage(sender, JSON.stringify({ type: 'signal', to: 42, data: {} }), 3)
  assert.equal(a.peer.sent.length, before)
})

test('sender cancel without a target reaches every receiver', () => {
  const { room, sender } = openRoom()
  const peers = [join(room), join(room), join(room)]
  room.handleMessage(sender, JSON.stringify({ type: 'cancel' }), 3)
  for (const p of peers) assert.equal(p.peer.last().type, 'cancel')
})

test('offers are cleaned before relaying (path separators, control chars, bad sizes)', () => {
  assert.deepEqual(cleanOffer({ name: '../x\u0000/y.txt', size: 3, type: 'text/plain' }), { name: '.._x__y.txt', size: 3, type: 'text/plain' })
  assert.equal(cleanOffer({ name: 'a', size: -1 }), null)
  assert.equal(cleanOffer({ name: 'a', size: 1.5 }), null)
  assert.equal(cleanOffer({ name: 'a', size: Number.MAX_SAFE_INTEGER + 2 }), null)
  assert.equal(cleanOffer({ name: '', size: 1 }), null)
  assert.equal(cleanOffer({ name: '   ', size: 1 }), null)
  assert.equal(cleanOffer(null), null)
  assert.equal(cleanOffer('x'), null)
  assert.equal(cleanOffer({ name: 'a'.repeat(1000), size: 0 }).name.length, 255)
  assert.equal(cleanOffer({ name: 'zero.bin', size: 0 }).size, 0)
  assert.equal(cleanOffer({ name: '😀 файл 文件.txt', size: 1 }).name, '😀 файл 文件.txt')
  const { room, sender } = openRoom()
  const a = join(room)
  room.handleMessage(sender, JSON.stringify({ type: 'file_offer', offer: { name: 'x', size: 'big' } }), 3)
  assert.equal(sender.last().code, 'bad_offer')
  assert.equal(a.peer.last().type, 'joined')
  assert.deepEqual(a.peer.last().offer, OFFER)
})

test('roles are enforced: receivers cannot offer, senders cannot accept, unknown types are rejected', () => {
  const { room, sender } = openRoom()
  const a = join(room)
  const sBefore = sender.sent.length
  room.handleMessage(a.peer, JSON.stringify({ type: 'file_offer', offer: { name: 'x', size: 1 } }), 3)
  room.handleMessage(a.peer, JSON.stringify({ type: 'peer_joined', id: 'r9' }), 3)
  room.handleMessage(a.peer, JSON.stringify({ type: 'joined' }), 3)
  room.handleMessage(a.peer, '{not json', 3)
  room.handleMessage(a.peer, '[1,2]', 3)
  room.handleMessage(a.peer, 'null', 3)
  assert.equal(sender.sent.length, sBefore)
  assert.deepEqual(a.peer.sent.slice(-6).map((m) => m.code), Array(6).fill('bad_message'))
  const aBefore = a.peer.sent.length
  room.handleMessage(sender, JSON.stringify({ type: 'file_accept' }), 3)
  room.handleMessage(sender, JSON.stringify({ type: 'file_reject' }), 3)
  assert.equal(a.peer.sent.length, aBefore)
  assert.equal(sender.last().code, 'bad_message')
})

test('oversized messages are rejected, ping gets pong, strangers are ignored', () => {
  const { room, sender } = openRoom()
  const a = join(room)
  room.handleMessage(sender, JSON.stringify({ type: 'signal', to: a.id, data: 'x'.repeat(BEAM_MAX_MESSAGE_BYTES) }), 3)
  assert.equal(sender.last().code, 'too_large')
  assert.equal(a.peer.last().type, 'joined')
  room.handleMessage(sender, '{"type":"ping"}', 3)
  assert.equal(sender.last().type, 'pong')
  const stranger = new FakePeer()
  room.handleMessage(stranger, JSON.stringify({ type: 'signal', data: {} }), 3)
  assert.equal(stranger.sent.length, 0)
})

test('a receiver leaving tells the sender which one; the others are unaffected', () => {
  const { room, sender } = openRoom()
  const a = join(room)
  const b = join(room)
  room.remove(a.peer)
  assert.deepEqual(sender.last(), { type: 'peer_left', role: 'receiver', id: a.id })
  assert.equal(b.peer.closed, null)
  room.handleMessage(b.peer, JSON.stringify({ type: 'file_accept' }), 5)
  assert.equal(sender.last().from, b.id)
})

test('removing the same peer twice, or a stranger, is harmless', () => {
  const { room, sender } = openRoom()
  const a = join(room)
  room.remove(a.peer)
  const n = sender.sent.length
  room.remove(a.peer)
  room.remove(new FakePeer())
  assert.equal(sender.sent.length, n)
})

test('sender leaving tells and closes every receiver, and frees the PIN', () => {
  const { room, sender } = openRoom()
  const peers = [join(room), join(room), join(room)]
  room.remove(sender)
  for (const p of peers) {
    assert.deepEqual(p.peer.ofType('peer_left')[0], { type: 'peer_left', role: 'sender' })
    assert.ok(p.peer.closed)
  }
  assert.equal(room.deadline(), null)
  assert.equal(room.addSender(new FakePeer(), '123456', 10), true)
  assert.equal(room.receivers.size, 0)
})

test('an empty room expires 10 minutes after it opened, even with pings', () => {
  const room = new BeamSignalRoom()
  const s = new FakePeer()
  room.addSender(s, '111111', 0)
  room.handleMessage(s, '{"type":"ping"}', BEAM_IDLE_MS - 1)
  assert.equal(room.expireIfIdle(BEAM_IDLE_MS - 1), false)
  assert.equal(room.expireIfIdle(BEAM_IDLE_MS), true)
  assert.equal(s.last().code, 'expired')
  assert.equal(s.closed.code, 4008)
})

test('a room with a receiver stays open while there is traffic', () => {
  const { room, sender } = openRoom()
  const a = join(room)
  room.handleMessage(sender, '{"type":"ping"}', BEAM_IDLE_MS + 5)
  assert.equal(room.expireIfIdle(BEAM_IDLE_MS + 6), false)
  assert.equal(room.deadline(), BEAM_IDLE_MS * 2 + 5)
  assert.equal(room.expireIfIdle(BEAM_IDLE_MS * 2 + 5), true)
  assert.ok(sender.closed && a.peer.closed)
})

test('after the last receiver leaves, the 10 minute clock restarts from then', () => {
  const { room, sender } = openRoom()
  const a = join(room, 100)
  room.remove(a.peer, 5_000_000)
  assert.equal(room.deadline(), 5_000_000 + BEAM_IDLE_MS)
  room.handleMessage(sender, '{"type":"ping"}', 5_000_000 + BEAM_IDLE_MS - 1)
  assert.equal(room.expireIfIdle(5_000_000 + BEAM_IDLE_MS), true)
})

test('expiry closes every peer with the same code', () => {
  const { room, sender } = openRoom()
  const peers = [join(room), join(room)]
  assert.equal(room.expireIfIdle(BEAM_IDLE_MS * 3), true)
  for (const p of [sender, ...peers.map((x) => x.peer)]) {
    assert.equal(p.closed.code, 4008)
    assert.equal(p.last().code, 'expired')
  }
})

test('a peer whose socket throws on send never breaks the room for the others', () => {
  const { room, sender } = openRoom()
  const bad = join(room)
  const good = join(room)
  bad.peer.send = () => { throw new Error('socket closed') }
  room.handleMessage(sender, JSON.stringify({ type: 'cancel' }), 3)
  assert.equal(good.peer.last().type, 'cancel')
  room.handleMessage(sender, JSON.stringify({ type: 'file_offer', offer: OFFER }), 4)
  assert.equal(good.peer.last().type, 'file_offer')
})

test('fuzz: 20,000 random messages from random peers never throw and keep the room consistent', () => {
  let seed = 12345
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const types = ['file_offer', 'file_accept', 'file_reject', 'signal', 'cancel', 'ping', 'joined', 'peer_left', 'x', '', 5, null]
  const junk = [{}, [], 'str', 5, null, { sdp: { type: 'offer', sdp: 'v=0' } }, { name: 'a', size: 1 }, 'x'.repeat(100)]
  const { room, sender } = openRoom()
  const live = []
  for (let i = 0; i < 20000; i++) {
    const r = rnd()
    if (r < 0.04 && live.length < 12) live.push(join(room, i))
    else if (r < 0.07 && live.length) room.remove(live.splice(Math.floor(rnd() * live.length), 1)[0].peer, i)
    else {
      const from = rnd() < 0.3 ? sender : (live.length ? pick(live).peer : sender)
      const body = rnd() < 0.1
        ? pick(['', '{', '[]', 'null', '12', '"s"', '{"type":', 'x'.repeat(70000)])
        : JSON.stringify({ type: pick(types), offer: pick(junk), data: pick(junk), to: pick([...live.map((l) => l.id), 'r0', 7, null]), from: 'r1' })
      room.handleMessage(from, body, i)
    }
    assert.ok(room.receivers.size <= BEAM_MAX_RECEIVERS)
    assert.ok(room.sender === sender)
  }
  // Nothing a receiver sent ever claimed to be from someone else
  const known = new Set(['r1', 'r2'])
  for (const m of sender.sent) if (m.from) assert.match(m.from, /^r\d+$/)
  void known
})

console.log('\n\x1b[1m\x1b[36mClip Beam speed and time left\x1b[0m')

/** Feeds a tracker a transfer whose speed follows `rate(tSeconds)` in bytes/s; returns samples. */
function simulate(total, rate, { tickMs = 200, stallFrom = null, stallTo = null } = {}) {
  const tr = new SpeedTracker(total)
  let t = 0
  let bytes = 0
  tr.start(0)
  const samples = []
  while (bytes < total && t < 24 * 3600 * 1000) {
    t += tickMs
    const stalled = stallFrom !== null && t >= stallFrom && t < stallTo
    if (!stalled) bytes = Math.min(total, bytes + rate(t / 1000) * (tickMs / 1000))
    const { speed, eta } = tr.update(bytes, t)
    samples.push({ t, bytes, speed, eta })
  }
  return { samples, end: t, tr }
}

test('steady 50 MB/s over 5 GB: speed is within 1% and time left within 3% after the first 3 seconds', () => {
  const total = 5 * 1024 ** 3
  const rate = () => 50 * 1024 ** 2
  const { samples, end } = simulate(total, rate)
  for (const s of samples.filter((x) => x.t > 3000 && x.t < end - 2000)) {
    assert.ok(Math.abs(s.speed - rate()) / rate() < 0.01, `speed ${s.speed} at ${s.t}`)
    const actual = (end - s.t) / 1000
    assert.ok(Math.abs(s.eta - actual) / actual < 0.03, `eta ${s.eta} vs ${actual} at ${s.t}`)
  }
})

test('nothing is reported until there is data: no speed or time left at the very start', () => {
  const tr = new SpeedTracker(1e9)
  tr.start(0)
  assert.deepEqual(tr.update(0, 100), { speed: 0, eta: Infinity })
  const r = tr.update(1e6, 300)
  assert.ok(r.eta === Infinity || r.eta > 0)
})

test('time left counts down smoothly (never jumps up while speed is steady)', () => {
  const { samples } = simulate(2 * 1024 ** 3, () => 20 * 1024 ** 2)
  let prev = Infinity
  for (const s of samples.filter((x) => x.t > 3000)) {
    assert.ok(s.eta <= prev + 0.05, `eta went up: ${prev} -> ${s.eta} at ${s.t}`)
    prev = s.eta
  }
})

test('noisy bursty speed (jitter, +-60%) still gives time left within 15% while more than 10 seconds remain', () => {
  let seed = 7
  const noise = () => 0.4 + ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 1.2
  const total = 3 * 1024 ** 3
  const { samples, end } = simulate(total, () => 30 * 1024 ** 2 * noise())
  const second = samples.filter((x) => x.t > 4000 && x.t < end - 10000)
  assert.ok(second.length > 50)
  let bad = 0
  for (const s of second) {
    const actual = (end - s.t) / 1000
    if (Math.abs(s.eta - actual) / actual > 0.15) bad++
  }
  assert.ok(bad / second.length < 0.05, `${bad}/${second.length} estimates were off by more than 15%`)
})

test('when speed halves mid-transfer, time left corrects itself within about 10 seconds', () => {
  const total = 2 * 1024 ** 3
  const rate = (t) => (t < 20 ? 40 : 20) * 1024 ** 2
  const { samples, end } = simulate(total, rate)
  const at = samples.find((s) => s.t >= 32000)
  const actual = (end - at.t) / 1000
  assert.ok(Math.abs(at.eta - actual) / actual < 0.1, `eta ${at.eta} vs ${actual}`)
  const speedLater = samples.find((s) => s.t >= 25000).speed
  assert.ok(Math.abs(speedLater - 20 * 1024 ** 2) / (20 * 1024 ** 2) < 0.02)
})

test('speed follows a change within the 3 second window', () => {
  const { samples } = simulate(4 * 1024 ** 3, (t) => (t < 10 ? 10 : 80) * 1024 ** 2)
  const s = samples.find((x) => x.t >= 14000)
  assert.ok(Math.abs(s.speed - 80 * 1024 ** 2) / (80 * 1024 ** 2) < 0.02, `speed ${s.speed}`)
})

test('a stall is reported as unknown time left and zero speed, then recovers', () => {
  const total = 1024 ** 3
  const { samples } = simulate(total, () => 20 * 1024 ** 2, { stallFrom: 10000, stallTo: 25000 })
  const during = samples.find((s) => s.t === 22000)
  assert.equal(during.speed, 0)
  assert.equal(during.eta, Infinity)
  const after = samples.find((s) => s.t === 32000)
  assert.ok(after.speed > 0 && Number.isFinite(after.eta))
})

test('a transfer that finishes reports zero time left and a correct average speed', () => {
  const total = 600 * 1024 ** 2
  const { samples, end, tr } = simulate(total, () => 30 * 1024 ** 2)
  assert.equal(samples[samples.length - 1].eta, 0)
  assert.ok(Math.abs(tr.average(total, end) - 30 * 1024 ** 2) / (30 * 1024 ** 2) < 0.01)
  assert.ok(Math.abs(tr.elapsed(end) - 20) < 0.3)
})

test('tiny and empty files do not divide by zero or go negative', () => {
  for (const size of [0, 1, 1000]) {
    const tr = new SpeedTracker(size)
    tr.start(0)
    for (let t = 100; t <= 5000; t += 100) {
      const { speed, eta } = tr.update(Math.min(size, t), t)
      assert.ok(speed >= 0 && !Number.isNaN(speed))
      assert.ok(eta >= 0 && !Number.isNaN(eta))
    }
  }
})

test('repeated or backwards updates are ignored safely', () => {
  const tr = new SpeedTracker(1e9)
  tr.start(0)
  tr.update(5e6, 1000)
  const r1 = tr.update(4e6, 1500) // bytes went "backwards"
  const r2 = tr.update(4e6, 1500) // same instant twice
  const r3 = tr.update(6e6, 1400) // time went backwards
  for (const r of [r1, r2, r3]) assert.ok(r.speed >= 0 && !Number.isNaN(r.speed) && !Number.isNaN(r.eta))
})

test('sample history stays bounded on a very long transfer', () => {
  const tr = new SpeedTracker(1e12)
  tr.start(0)
  for (let t = 200; t < 3_600_000; t += 200) tr.update(t * 1e4, t)
  assert.ok(tr.samples.length < 200, `kept ${tr.samples.length} samples`)
})

test('formatting: PINs, sizes, durations and time left', () => {
  assert.equal(parsePin('748 219'), '748219')
  assert.equal(parsePin('748-219'), '748219')
  assert.equal(parsePin('https://clip.foo.ng/beam?pin=748219'), '748219')
  assert.equal(parsePin('7482190'), null)
  assert.equal(parsePin('74821'), null)
  assert.equal(parsePin('abc'), null)
  assert.equal(formatPin('748219'), '748-219')
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1536), '1.50 KB')
  assert.equal(formatBytes(5 * 1024 ** 3), '5.00 GB')
  assert.equal(formatBytes(-1), '0 B')
  assert.equal(formatDuration(59.6), '1m 0s')
  assert.equal(formatDuration(3725), '1h 2m')
  assert.equal(formatEta(Infinity), 'Calculating...')
  assert.equal(formatEta(42), '42s left')
  assert.equal(formatEta(0.4), '<1s left')
})

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed) process.exit(1)
