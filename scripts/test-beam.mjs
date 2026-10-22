/**
 * Clip Beam signalling room tests (no worker needed).
 * Run with: node scripts/test-beam.mjs   (also part of `npm test`)
 */
import assert from 'node:assert/strict'
import {
  BeamSignalRoom, generateBeamPin, cleanOffer, BEAM_PIN_RE, BEAM_IDLE_MS, BEAM_MAX_MESSAGE_BYTES,
} from '../worker/src/lib/beam.ts'

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
  types() { return this.sent.map((m) => m.type) }
}

function pairedRoom() {
  const room = new BeamSignalRoom()
  const sender = new FakePeer()
  const receiver = new FakePeer()
  room.addSender(sender, '123456', 0)
  room.handleMessage(sender, JSON.stringify({ type: 'file_offer', offer: { name: 'big.iso', size: 5e9, type: 'application/x-iso9660-image' } }), 1)
  room.addReceiver(receiver, 2)
  return { room, sender, receiver }
}

console.log('\n\x1b[1m\x1b[36mClip Beam signalling tests\x1b[0m')

test('PINs are six digits and vary', () => {
  const pins = new Set()
  for (let i = 0; i < 500; i++) {
    const pin = generateBeamPin()
    assert.match(pin, BEAM_PIN_RE)
    pins.add(pin)
  }
  assert.ok(pins.size > 490)
})

test('sender gets room_created with its PIN; a second sender on the same PIN is refused', () => {
  const room = new BeamSignalRoom()
  const a = new FakePeer()
  assert.equal(room.addSender(a, '000042', 0), true)
  assert.deepEqual(a.last(), { type: 'room_created', pin: '000042' })
  assert.equal(room.addSender(new FakePeer(), '000042', 0), false)
})

test('receiver on an empty PIN gets no_room and is closed', () => {
  const room = new BeamSignalRoom()
  const r = new FakePeer()
  assert.equal(room.addReceiver(r, 0), 'no_room')
  assert.equal(r.last().code, 'no_room')
  assert.equal(r.closed.code, 4004)
})

test('receiver joining sees the file offer; sender is told peer_joined', () => {
  const { sender, receiver } = pairedRoom()
  assert.deepEqual(receiver.sent[0], { type: 'joined', offer: { name: 'big.iso', size: 5e9, type: 'application/x-iso9660-image' } })
  assert.equal(sender.last().type, 'peer_joined')
})

test('a third browser cannot join a paired room', () => {
  const { room } = pairedRoom()
  const third = new FakePeer()
  assert.equal(room.addReceiver(third, 3), 'room_full')
  assert.equal(third.closed.code, 4009)
})

test('SDP and ICE are relayed both ways unchanged', () => {
  const { room, sender, receiver } = pairedRoom()
  const offer = { type: 'signal', data: { sdp: { type: 'offer', sdp: 'v=0...' } } }
  room.handleMessage(sender, JSON.stringify(offer), 3)
  assert.deepEqual(receiver.last(), offer)
  const cand = { type: 'signal', data: { candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0' } } }
  room.handleMessage(receiver, JSON.stringify(cand), 4)
  assert.deepEqual(sender.last(), cand)
  room.handleMessage(receiver, JSON.stringify({ type: 'file_accept' }), 5)
  assert.equal(sender.last().type, 'file_accept')
})

test('offers are cleaned before relaying (path separators, control chars, bad sizes)', () => {
  assert.deepEqual(cleanOffer({ name: '../x\u0000/y.txt', size: 3, type: 'text/plain' }), { name: '.._x__y.txt', size: 3, type: 'text/plain' })
  assert.equal(cleanOffer({ name: 'a', size: -1 }), null)
  assert.equal(cleanOffer({ name: 'a', size: 1.5 }), null)
  assert.equal(cleanOffer({ name: '', size: 1 }), null)
  const { room, sender, receiver } = pairedRoom()
  room.handleMessage(sender, JSON.stringify({ type: 'file_offer', offer: { name: 'x', size: 'big' } }), 3)
  assert.equal(sender.last().code, 'bad_offer')
  assert.equal(receiver.last().type, 'joined')
})

test('roles are enforced: receiver cannot send file_offer, unknown types and bad JSON are rejected', () => {
  const { room, sender, receiver } = pairedRoom()
  const before = sender.sent.length
  room.handleMessage(receiver, JSON.stringify({ type: 'file_offer', offer: { name: 'x', size: 1 } }), 3)
  room.handleMessage(receiver, JSON.stringify({ type: 'peer_joined' }), 3)
  room.handleMessage(receiver, '{not json', 3)
  assert.equal(sender.sent.length, before)
  assert.deepEqual(receiver.sent.slice(-3).map((m) => m.code), ['bad_message', 'bad_message', 'bad_message'])
})

test('oversized messages are rejected, ping gets pong, strangers are ignored', () => {
  const { room, sender, receiver } = pairedRoom()
  room.handleMessage(sender, JSON.stringify({ type: 'signal', data: 'x'.repeat(BEAM_MAX_MESSAGE_BYTES) }), 3)
  assert.equal(sender.last().code, 'too_large')
  assert.equal(receiver.last().type, 'joined')
  room.handleMessage(sender, '{"type":"ping"}', 3)
  assert.equal(sender.last().type, 'pong')
  const stranger = new FakePeer()
  room.handleMessage(stranger, JSON.stringify({ type: 'signal', data: {} }), 3)
  assert.equal(stranger.sent.length, 0)
  assert.equal(receiver.last().type, 'joined')
})

test('receiver leaving tells the sender and frees the slot for a new receiver', () => {
  const { room, sender, receiver } = pairedRoom()
  room.remove(receiver)
  assert.deepEqual(sender.last(), { type: 'peer_left', role: 'receiver' })
  const again = new FakePeer()
  assert.equal(room.addReceiver(again, 5), 'ok')
  assert.equal(again.sent[0].offer.name, 'big.iso')
})

test('sender leaving tells and closes the receiver, and frees the PIN', () => {
  const { room, sender, receiver } = pairedRoom()
  room.remove(sender)
  assert.deepEqual(receiver.sent[receiver.sent.length - 1], { type: 'peer_left', role: 'sender' })
  assert.ok(receiver.closed)
  assert.equal(room.deadline(), null)
  assert.equal(room.addSender(new FakePeer(), '123456', 10), true)
})

test('an unpaired room expires 10 minutes after creation, even with pings', () => {
  const room = new BeamSignalRoom()
  const s = new FakePeer()
  room.addSender(s, '111111', 0)
  room.handleMessage(s, '{"type":"ping"}', BEAM_IDLE_MS - 1)
  assert.equal(room.expireIfIdle(BEAM_IDLE_MS - 1), false)
  assert.equal(room.expireIfIdle(BEAM_IDLE_MS), true)
  assert.equal(s.last().code, 'expired')
  assert.equal(s.closed.code, 4008)
})

test('a paired room stays open while there is signalling traffic', () => {
  const { room, sender, receiver } = pairedRoom()
  room.handleMessage(sender, '{"type":"ping"}', BEAM_IDLE_MS + 5)
  assert.equal(room.expireIfIdle(BEAM_IDLE_MS + 6), false)
  assert.equal(room.deadline(), BEAM_IDLE_MS * 2 + 5)
  assert.equal(room.expireIfIdle(BEAM_IDLE_MS * 2 + 5), true)
  assert.ok(sender.closed && receiver.closed)
})

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed) process.exit(1)
