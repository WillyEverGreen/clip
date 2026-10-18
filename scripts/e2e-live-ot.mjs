/**
 * End-to-end check of Live Pad multi-user sync against a REAL worker (Durable Object).
 *
 *   1. cd worker && npx wrangler dev --local --port 8799
 *   2. node scripts/e2e-live-ot.mjs            (optionally: BASE=ws://127.0.0.1:8799)
 *
 * Not part of `npm test` because it needs a running worker.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { OtClient, hashText } from '../worker/src/lib/ot.ts'

const BASE = process.env.BASE || 'ws://127.0.0.1:8799'
const HTTP = BASE.replace(/^ws/, 'http')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let passed = 0
let failed = 0

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  catch (err) { failed++; console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.stack || err}`) }
}

function rng(seed) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
}

/** A headless Live Pad editor that mirrors what the browser hook does. */
class Editor {
  constructor(slug, label) {
    this.slug = slug
    this.label = label
    this.ot = new OtClient(`sid-${label}-${Math.random().toString(36).slice(2)}`)
    this.hasState = false
    this.cursors = new Map()
    this.resyncs = 0
    this.messages = []
    this.clientId = null
  }

  connect({ presence = null, password = null } = {}) {
    this.password = password
    const connectedAt = this.hasState ? this.ot.version : -1
    const url = `${BASE}/api/live/${this.slug}/ws?ot=1&sid=${this.ot.sid}&v=${connectedAt}`
    this.ws = new WebSocket(url)
    this.presence = presence
    return new Promise((resolve, reject) => {
      this.ws.onerror = (e) => reject(new Error(`ws error for ${this.label}: ${e.message || e}`))
      this.ws.onmessage = (ev) => {
        const data = JSON.parse(ev.data)
        this.messages.push(data)
        this.handle(data, connectedAt)
        if (data.type === 'init') resolve(this)
      }
    })
  }

  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  flush(step) {
    assert.notEqual(step.kind, 'desync', `${this.label} desynced`)
    if (step.send) this.send({ type: 'op', v: step.baseVersion, n: step.n, s: step.send.s, e: step.send.e, x: step.send.x })
  }

  handle(data, connectedAt) {
    switch (data.type) {
      case 'auth_challenge': {
        this.clientId = data.clientId
        const hash = createHash('sha256').update(`${this.password}:${data.salt}`).digest('hex')
        this.send({ type: 'auth', hash })
        break
      }
      case 'init': {
        this.clientId = data.clientId
        const state = { text: data.text, version: data.version, replay: data.replay ?? null }
        this.lastInit = data
        const step = this.hasState ? this.ot.resume(state, connectedAt) : this.ot.rebase(state.text, state.version)
        this.hasState = true
        this.flush(step)
        if (this.presence) this.send({ type: 'presence', on: true, ...this.presence })
        break
      }
      case 'ack': this.flush(this.ot.ack(data.v)); break
      case 'op': {
        const step = this.ot.remote({ s: data.s, e: data.e, x: data.x }, data.v)
        if (step.kind === 'desync') this.send({ type: 'resync' })
        break
      }
      case 'resync': {
        this.resyncs++
        this.flush(this.ot.merge(data.text, data.version))
        break
      }
      case 'check':
        if (this.ot.version === data.v && this.ot.isSynced() && hashText(this.ot.base) !== data.h) this.send({ type: 'resync' })
        break
      case 'cursors': this.cursors = new Map(data.list.map(c => [c.id, c])); break
      case 'cursor': this.cursors.set(data.id, data); break
      case 'cursor_off': this.cursors.delete(data.id); break
    }
  }

  type(text) {
    this.flush(this.ot.edit(text))
  }

  disconnect() {
    this.ot.setOnline(false)
    this.ws.onmessage = null
    this.ws.close()
  }

  get text() { return this.ot.local }
}

/** Wait until every editor has caught up and agrees (or time out). */
async function settle(editors, ms = 6000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    await sleep(120)
    const same = editors.every(e => e.text === editors[0].text && e.ot.isSynced())
    if (same) { await sleep(250); if (editors.every(e => e.text === editors[0].text && e.ot.isSynced())) return }
  }
}

const roomSlug = (p) => `e2e-${p}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

console.log('\n\x1b[1m\x1b[36mLive Pad end-to-end (real Durable Object)\x1b[0m')

await test('three people typing at once end up with identical text', async () => {
  const slug = roomSlug('typing')
  const eds = await Promise.all(['a', 'b', 'c'].map(l => new Editor(slug, l).connect()))
  const r = rng(42)
  const words = ['hello ', 'world', '\n', 'cat', ' 😀 ', 'x', 'lorem ipsum ']
  for (let round = 0; round < 150; round++) {
    const ed = eds[Math.floor(r() * eds.length)]
    const t = ed.text
    const roll = r()
    let next
    if (roll < 0.6 || !t) {
      const p = Math.floor(r() * (t.length + 1))
      next = t.slice(0, p) + words[Math.floor(r() * words.length)] + t.slice(p)
    } else {
      const p = Math.floor(r() * t.length)
      const len = 1 + Math.floor(r() * Math.min(6, t.length - p))
      next = t.slice(0, p) + t.slice(p + len)
    }
    if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(next)) continue
    ed.type(next)
    if (r() < 0.5) await sleep(Math.floor(r() * 25))
  }
  await settle(eds)
  assert.equal(eds[1].text, eds[0].text)
  assert.equal(eds[2].text, eds[0].text)
  assert.ok(eds[0].text.length > 20, 'expected a non-trivial document')
  // a brand-new visitor sees exactly the same text
  const late = await new Editor(slug, 'late').connect()
  assert.equal(late.text, eds[0].text)
  for (const e of [...eds, late]) e.disconnect()
})

await test('a person reconnecting gets missed edits replayed and keeps their own', async () => {
  const slug = roomSlug('replay')
  const a = await new Editor(slug, 'a').connect()
  const b = await new Editor(slug, 'b').connect()
  a.type('hello')
  await settle([a, b])
  assert.equal(b.text, 'hello')
  a.disconnect()
  await sleep(100)
  b.type('hello there')               // B keeps typing while A is away
  await sleep(200)
  a.type('Oh, hello')                 // A types offline too
  await a.connect()
  await settle([a, b])
  assert.ok(Array.isArray(a.lastInit.replay), 'server should have replayed missed ops')
  assert.equal(a.text, b.text)
  assert.ok(a.text.includes('there'), 'A must see what B typed while away')
  assert.ok(a.text.includes('Oh,'), 'A must keep what A typed while offline')
  a.disconnect(); b.disconnect()
})

await test('an old client that sends whole-text updates still works alongside new ones', async () => {
  const slug = roomSlug('legacy')
  const modern = await new Editor(slug, 'modern').connect()
  const oldWs = new WebSocket(`${BASE}/api/live/${slug}/ws`)         // no ?ot=1
  const oldMsgs = []
  await new Promise(res => { oldWs.onmessage = (ev) => { const d = JSON.parse(ev.data); oldMsgs.push(d); if (d.type === 'init') res() } })
  assert.equal(oldMsgs[0].version, undefined, 'legacy clients must not receive op-protocol fields')

  oldWs.send(JSON.stringify({ type: 'text', text: 'typed by an old browser' }))
  await settle([modern])
  assert.equal(modern.text, 'typed by an old browser')

  modern.type('typed by an old browser, edited by a new one')
  await sleep(400)
  const lastText = [...oldMsgs].reverse().find(m => m.type === 'text')
  assert.equal(lastText?.text, 'typed by an old browser, edited by a new one')
  oldWs.close(); modern.disconnect()
})

await test('presence: opt-in only, names are cleaned, positions are clamped', async () => {
  const slug = roomSlug('presence')
  const a = await new Editor(slug, 'a').connect({ presence: { name: 'Mochi', start: 0, end: 0 } })
  const b = await new Editor(slug, 'b').connect({ presence: { name: 'Biscuit', start: 0, end: 0 } })
  const quiet = await new Editor(slug, 'quiet').connect()           // did not opt in
  a.type('some shared words')
  await settle([a, b, quiet])
  await sleep(300)
  assert.equal(b.cursors.size, 1)
  assert.equal([...b.cursors.values()][0].name, 'Mochi')

  a.send({ type: 'cursor', start: 5, end: 5 })
  await sleep(300)
  assert.equal(b.cursors.get(a.clientId).start, 5)
  assert.equal(quiet.cursors.size, 0, 'a client that did not opt in must receive no cursors')

  a.send({ type: 'cursor', start: 9999, end: -4 })                   // out of range
  await sleep(300)
  const seen = b.cursors.get(a.clientId)
  assert.ok(seen.start <= a.text.length && seen.end >= 0)

  const evil = await new Editor(slug, 'evil').connect({ presence: { name: '  <img src=x>\u0000\n  ' + 'x'.repeat(100), start: 0, end: 0 } })
  await sleep(300)
  const evilSeen = b.cursors.get(evil.clientId)
  assert.ok(evilSeen.name.length <= 24 && !/[\u0000-\u001f]/.test(evilSeen.name))

  // carets follow the text when someone types before them
  b.type('>>> ' + b.text)
  await sleep(400)
  assert.ok(a.cursors.size >= 1)

  a.disconnect()
  await sleep(300)
  assert.ok(!b.cursors.has(a.clientId), 'cursor disappears when its owner leaves')
  b.disconnect(); quiet.disconnect(); evil.disconnect()
})

await test('turning presence off removes the cursor for everyone', async () => {
  const slug = roomSlug('off')
  const a = await new Editor(slug, 'a').connect({ presence: { name: 'Pudding', start: 0, end: 0 } })
  const b = await new Editor(slug, 'b').connect({ presence: { name: 'Waffles', start: 0, end: 0 } })
  await sleep(300)
  assert.equal(b.cursors.size, 1)
  a.send({ type: 'presence', on: false })
  await sleep(300)
  assert.equal(b.cursors.size, 0)
  a.disconnect(); b.disconnect()
})

await test('malformed or hostile ops are rejected without corrupting the room', async () => {
  const slug = roomSlug('hostile')
  const a = await new Editor(slug, 'a').connect()
  const b = await new Editor(slug, 'b').connect()
  a.type('safe text')
  await settle([a, b])
  const bad = [
    { type: 'op', v: 999, n: 1, s: 0, e: 0, x: 'x' },
    { type: 'op', v: a.ot.version, n: 2, s: 5000, e: 6000, x: '' },
    { type: 'op', v: a.ot.version, n: 3, s: -1, e: 2, x: '' },
    { type: 'op', v: a.ot.version, n: 4, s: 0, e: 3, x: 'nope' },
    { type: 'op', v: 'zero', n: 5, s: 0, e: 0, x: 'x' },
    { type: 'op' },
    { type: 'presence', on: true, name: 42 },
    { type: 'cursor', start: 'a', end: {} },
  ]
  for (const m of bad) a.send(m)
  a.ws.send('not json at all')
  await sleep(500)
  await settle([a, b])
  assert.equal(b.text, 'safe text')
  assert.equal(a.text, 'safe text')
  assert.ok(a.resyncs >= 1, 'server should have answered bad ops with a resync')
  b.type('still working')
  await settle([a, b])
  assert.equal(a.text, 'still working')
  a.disconnect(); b.disconnect()
})

await test('password-protected rooms: replay works after auth, strangers are ignored', async () => {
  const slug = roomSlug('locked')
  const salt = 'e2e-salt'
  const authHash = createHash('sha256').update(`hunter2:${salt}`).digest('hex')
  const res = await fetch(`${HTTP}/api/live/${slug}/security`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isProtected: true, salt, authHash }),
  })
  assert.equal(res.status, 200)

  const a = await new Editor(slug, 'a').connect({ password: 'hunter2', presence: { name: 'Pudding', start: 0, end: 0 } })
  const b = await new Editor(slug, 'b').connect({ password: 'hunter2', presence: { name: 'Waffles', start: 0, end: 0 } })
  a.type('private notes')
  await settle([a, b])
  assert.equal(b.text, 'private notes')

  // someone without the password gets a challenge and nothing else
  const stranger = new WebSocket(`${BASE}/api/live/${slug}/ws?ot=1&sid=stranger&v=-1`)
  const seen = []
  await new Promise(resolve => {
    stranger.onmessage = (ev) => { seen.push(JSON.parse(ev.data)); if (seen.length === 1) resolve() }
  })
  assert.equal(seen[0].type, 'auth_challenge')
  assert.equal(seen[0].text, undefined, 'challenge must not leak the text')
  stranger.send(JSON.stringify({ type: 'op', v: a.ot.version, n: 1, s: 0, e: 0, x: 'HACKED' }))
  stranger.send(JSON.stringify({ type: 'presence', on: true, name: 'Intruder' }))
  await sleep(400)
  assert.equal(a.text, 'private notes')
  assert.ok(![...b.cursors.values()].some(c => c.name === 'Intruder'), 'unauthenticated presence must not be broadcast')
  assert.ok(seen.every(m => m.type !== 'op' && m.type !== 'cursor' && m.type !== 'check'), 'no document traffic for strangers')
  stranger.close()

  // an authenticated person who drops and returns still gets replay
  a.disconnect()
  await sleep(100)
  b.type('private notes, updated')
  await sleep(300)
  await a.connect({ password: 'hunter2' })
  await settle([a, b])
  assert.ok(Array.isArray(a.lastInit.replay))
  assert.equal(a.text, 'private notes, updated')
  a.disconnect(); b.disconnect()
})

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
