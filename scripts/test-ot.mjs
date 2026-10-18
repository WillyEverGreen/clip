/**
 * Live Pad operational-transform tests.
 * Run with: node scripts/test-ot.mjs   (also part of `npm test`)
 * Set OT_TRACE=1 to print the last events of a failing simulation.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  applyOp, transformOp, mapPos, diffOps, hashText, isValidOp,
  OtServerDoc, OtClient, MAX_OP_CHARS,
} from '../worker/src/lib/ot.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
let failed = 0
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  catch (err) { failed++; console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.stack || err}`) }
}

// Deterministic PRNG so failures are reproducible
function rng(seed) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
}

console.log('\n\x1b[1m\x1b[36mLive Pad OT tests\x1b[0m')

test('worker and frontend copies of ot.ts are identical', () => {
  const a = readFileSync(path.join(root, 'worker/src/lib/ot.ts'), 'utf8')
  const b = readFileSync(path.join(root, 'frontend/src/lib/ot.ts'), 'utf8')
  assert.equal(a, b)
})

test('transformOp converges (TP1) for every atomic op pair on small strings', () => {
  const ops = (n) => {
    const r = []
    for (let s = 0; s <= n; s++) {
      for (let e = s + 1; e <= n; e++) r.push({ s, e, x: '' })
      for (const x of ['X', 'YY']) r.push({ s, e: s, x })
    }
    return r
  }
  let cases = 0
  for (const S of ['', 'a', 'ab', 'abc', 'abcd', 'abcdef']) {
    for (const a of ops(S.length)) for (const b of ops(S.length)) {
      const r1 = applyOp(applyOp(S, b), transformOp(a, b, true))
      const r2 = applyOp(applyOp(S, a), transformOp(b, a, false))
      assert.equal(r1, r2, `S=${JSON.stringify(S)} a=${JSON.stringify(a)} b=${JSON.stringify(b)}`)
      cases++
    }
  }
  assert.ok(cases > 1500)
})

test('diffOps reproduces the target text and never splits surrogate pairs', () => {
  const r = rng(7)
  const alphabet = ['a', 'b', 'c', ' ', '\n', '😀', '🐼', 'é']
  const randChars = (n) => Array.from({ length: Math.floor(r() * n) }, () => alphabet[Math.floor(r() * alphabet.length)])
  const rand = (n) => randChars(n).join('')
  for (let i = 0; i < 2000; i++) {
    const fromChars = randChars(12)
    const from = fromChars.join('')
    // Edit whole characters only, like a real textarea would
    const to = r() < 0.5 ? rand(12) : fromChars.slice(0, 3).join('') + rand(4) + fromChars.slice(5).join('')
    let cur = from
    const ops = diffOps(from, to)
    assert.ok(ops.length <= 2)
    for (const op of ops) {
      assert.ok(isValidOp(op))
      cur = applyOp(cur, op)
    }
    assert.equal(cur, to)
    for (const op of ops) {
      for (const idx of [op.s, op.e]) {
        const code = from.charCodeAt(idx)
        assert.ok(!(idx > 0 && code >= 0xdc00 && code <= 0xdfff), 'split a surrogate pair')
      }
    }
  }
})

test('mapPos moves carets correctly through inserts and deletes', () => {
  assert.equal(mapPos(5, { s: 2, e: 2, x: 'abc' }), 8)
  assert.equal(mapPos(2, { s: 2, e: 2, x: 'abc' }), 2)
  assert.equal(mapPos(1, { s: 2, e: 2, x: 'abc' }), 1)
  assert.equal(mapPos(9, { s: 2, e: 5, x: '' }), 6)
  assert.equal(mapPos(3, { s: 2, e: 5, x: '' }), 2)
  assert.equal(mapPos(1, { s: 2, e: 5, x: '' }), 1)
})

test('isValidOp rejects malformed ops', () => {
  assert.ok(isValidOp({ s: 0, e: 0, x: 'a' }))
  assert.ok(isValidOp({ s: 1, e: 3, x: '' }))
  assert.ok(isValidOp({ s: 2, e: 2, x: '' }))
  const bad = [null, 5, {}, { s: -1, e: 0, x: 'a' }, { s: 3, e: 1, x: '' }, { s: 1, e: 2, x: 'a' },
    { s: 0.5, e: 1, x: '' }, { s: 0, e: 0, x: 'a'.repeat(MAX_OP_CHARS + 1) }, { s: 0, e: 0, x: 1 }]
  for (const b of bad) assert.ok(!isValidOp(b), JSON.stringify(b))
})

test('server rejects stale and invalid submissions without corrupting the doc', () => {
  const doc = new OtServerDoc('hello')
  assert.deepEqual(doc.submit({ s: 0, e: 0, x: 'X' }, 99), { ok: false, reason: 'stale' })
  assert.deepEqual(doc.submit({ s: 0, e: 0, x: 'X' }, -1), { ok: false, reason: 'stale' })
  assert.deepEqual(doc.submit({ s: 0, e: 40, x: '' }, 0), { ok: false, reason: 'invalid' })
  assert.deepEqual(doc.submit('nope', 0), { ok: false, reason: 'invalid' })
  assert.equal(doc.text, 'hello')
  assert.equal(doc.version, 0)
  const ok = doc.submit({ s: 5, e: 5, x: '!' }, 0)
  assert.ok(ok.ok)
  assert.equal(doc.text, 'hello!')
  doc.reset('fresh')
  assert.deepEqual(doc.submit({ s: 0, e: 0, x: 'X' }, 0), { ok: false, reason: 'stale' })
})

test('legacy full-text replacement becomes sequential ops and round-trips', () => {
  const doc = new OtServerDoc('the quick brown fox')
  const applied = doc.replaceAll('the slow brown fox jumps')
  assert.equal(doc.text, 'the slow brown fox jumps')
  assert.equal(doc.version, applied.length)
  assert.equal(doc.replaceAll('the slow brown fox jumps').length, 0)
})

test('replaySince returns missed ops, or null when history does not reach', () => {
  const doc = new OtServerDoc('abc')
  doc.submit({ s: 3, e: 3, x: 'd' }, 0, { sid: 'a', n: 1 })
  doc.submit({ s: 0, e: 1, x: '' }, 1, { sid: 'b', n: 7 })
  assert.deepEqual(doc.replaySince(2), [])
  const replay = doc.replaySince(0)
  assert.equal(replay.length, 2)
  assert.deepEqual(replay.map(r => [r.v, r.sid, r.n]), [[1, 'a', 1], [2, 'b', 7]])
  assert.equal(doc.replaySince(9), null)
  assert.equal(doc.replaySince(-1), null)
  assert.equal(doc.replaySince('x'), null)
  doc.reset('zzz')
  assert.equal(doc.replaySince(0), null)
})

// ── Full multi-client simulation with random network interleaving ───────────

function simulate(seed, opts) {
  const trace = []
  try { return simulateInner(seed, opts, trace) }
  catch (err) {
    if (process.env.OT_TRACE) console.error(trace.slice(-25).join('\n'))
    throw err
  }
}

function simulateInner(seed, { clients: n, steps, startText, reconnects = false }, trace) {
  const r = rng(seed)
  const server = new OtServerDoc(startText)
  // Server text at every version, to check each client's base against the truth
  const snapshots = [startText]
  const cl = []
  for (let i = 0; i < n; i++) {
    const c = new OtClient(`c${i}`)
    c.rebase(server.text, server.version)
    cl.push({ id: i, c, up: [], down: [], online: true, connectedAt: server.version })
  }
  const pick = (arr) => arr[Math.floor(r() * arr.length)]
  const words = ['a', 'bb', 'cat', ' ', '\n', 'xyz', '😀', 'Hello ', 'q']

  const sendStep = (client, step) => {
    assert.notEqual(step.kind, 'desync', `client ${client.id} desynced`)
    if (step.send) {
      client.up.push({ op: step.send, v: step.baseVersion, n: step.n })
      trace.push(`c${client.id} SEND ${JSON.stringify(step.send)} @v${step.baseVersion} n${step.n}`)
    }
  }

  const serverDeliver = (client) => {
    const msg = client.up.shift()
    const res = server.submit(msg.op, msg.v, { sid: `c${client.id}`, n: msg.n })
    trace.push(`SERVER from c${client.id} ${JSON.stringify(msg)} -> ${JSON.stringify(res)}`)
    assert.ok(res.ok, `seed ${seed}: server rejected op ${JSON.stringify(msg)} (v=${server.version}, len=${server.text.length}): ${JSON.stringify(res)}`)
    snapshots[res.version] = server.text
    // Only online clients receive anything; a dropped connection loses its queue
    if (client.online) client.down.push({ type: 'ack', v: res.version })
    for (const o of cl) if (o !== client && o.online) o.down.push({ type: 'op', op: res.op, v: res.version })
  }

  const checkBase = (client, what) => {
    assert.equal(client.c.base, snapshots[client.c.version],
      `seed ${seed}: client ${client.id} base diverged from server v${client.c.version} after ${what}`)
  }

  const clientDeliver = (client) => {
    const msg = client.down.shift()
    if (msg.type === 'ack') {
      sendStep(client, client.c.ack(msg.v))
      checkBase(client, `ack v${msg.v}`)
    } else {
      const step = client.c.remote(msg.op, msg.v)
      assert.equal(step.kind, 'ok', `client ${client.id} desynced on remote op`)
      checkBase(client, `remote ${JSON.stringify(msg.op)} v${msg.v}`)
    }
  }

  const disconnect = (client) => {
    trace.push(`c${client.id} DISCONNECT`)
    client.online = false
    client.c.setOnline(false)
    client.up.length = 0   // messages still on the wire are lost
    client.down.length = 0
  }

  const reconnect = (client) => {
    const connectedAt = client.c.version
    const replay = server.replaySince(connectedAt)
    trace.push(`c${client.id} RECONNECT at v${connectedAt} replay=${replay ? replay.length : 'none'}`)
    client.online = true
    client.connectedAt = connectedAt
    sendStep(client, client.c.resume({ text: server.text, version: server.version, replay }, connectedAt))
  }

  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

  const localEdit = (client) => {
    const t = client.c.local
    const roll = r()
    let next
    if (roll < 0.5 || t.length === 0) {
      const p = Math.floor(r() * (t.length + 1))
      next = t.slice(0, p) + pick(words) + t.slice(p)
    } else if (roll < 0.8) {
      const p = Math.floor(r() * t.length)
      const len = 1 + Math.floor(r() * Math.min(6, t.length - p))
      next = t.slice(0, p) + t.slice(p + len)
    } else {
      const p = Math.floor(r() * t.length)
      const len = 1 + Math.floor(r() * Math.min(5, t.length - p))
      next = t.slice(0, p) + pick(words) + t.slice(p + len)
    }
    // A real textarea can never produce a lone surrogate
    if (lone.test(next)) return
    trace.push(`c${client.id} EDIT -> ${JSON.stringify(next).slice(0, 60)}`)
    sendStep(client, client.c.edit(next))
  }

  for (let i = 0; i < steps; i++) {
    const client = pick(cl)
    const roll = r()
    if (reconnects && roll < 0.06) {
      if (client.online) disconnect(client)
      else reconnect(client)
    } else if (roll < 0.4) localEdit(client)
    else if (roll < 0.7 && client.up.length) serverDeliver(client)
    else if (client.down.length) clientDeliver(client)
  }
  for (const client of cl) if (!client.online) reconnect(client)
  let guard = 0
  while (cl.some(c => c.up.length || c.down.length)) {
    assert.ok(++guard < 100000, 'drain did not terminate')
    const busy = cl.filter(c => c.up.length || c.down.length)
    const client = pick(busy)
    if (client.up.length && (r() < 0.5 || !client.down.length)) serverDeliver(client)
    else clientDeliver(client)
  }
  for (const client of cl) {
    assert.equal(client.c.local, server.text, `seed ${seed}: client ${client.id} diverged`)
    assert.ok(client.c.isSynced(), `seed ${seed}: client ${client.id} not synced`)
    assert.equal(client.c.version, server.version)
    assert.equal(hashText(client.c.base), hashText(server.text))
  }
}

test('two clients converge under random interleaving (600 seeds)', () => {
  for (let seed = 1; seed <= 600; seed++) simulate(seed, { clients: 2, steps: 120, startText: 'hello world' })
})

test('five clients converge under random interleaving (300 seeds)', () => {
  for (let seed = 1000; seed < 1300; seed++) simulate(seed, { clients: 5, steps: 250, startText: '' })
})

test('clients converge when starting from a large unicode document', () => {
  const big = Array.from({ length: 400 }, (_, i) => `line ${i} 🐼 café\n`).join('')
  for (let seed = 5000; seed < 5030; seed++) simulate(seed, { clients: 3, steps: 200, startText: big })
})

test('clients converge through random disconnects and reconnects (800 seeds)', () => {
  for (let seed = 20000; seed < 20800; seed++) {
    simulate(seed, { clients: 3, steps: 220, startText: 'shared notes', reconnects: true })
  }
})

test('offline edits survive a reconnect that cannot be replayed (3-way merge)', () => {
  const server = new OtServerDoc('abc')
  const c = new OtClient('me')
  c.rebase('abc', 0)
  c.setOnline(false)
  c.edit('abXc')                                // typed offline
  server.submit({ s: 0, e: 0, x: '>' }, 0)      // someone else typed meanwhile
  server.reset(server.text)                     // history gone (e.g. room restarted)
  const step = c.resume({ text: server.text, version: server.version, replay: null }, 0)
  assert.equal(step.kind, 'ok')
  assert.ok(step.send)
  const res = server.submit(step.send, step.baseVersion)
  assert.ok(res.ok)
  assert.equal(c.ack(res.version).kind, 'ok')
  assert.equal(server.text, '>abXc')
  assert.equal(c.local, '>abXc')
})

test('merge does not duplicate a change the server already has', () => {
  const c = new OtClient('me')
  c.rebase('abc', 0)
  c.edit('abcX')
  const step = c.merge('abcX', 3)
  assert.equal(step.kind, 'ok')
  assert.equal(step.send, null)
  assert.equal(c.local, 'abcX')
})

test('large pastes are sent in capped chunks and still converge', () => {
  const server = new OtServerDoc('')
  const c = new OtClient('me')
  c.rebase('', 0)
  const big = '😀x'.repeat(MAX_OP_CHARS)
  let step = c.edit(big)
  let rounds = 0
  while (step.send) {
    assert.ok(step.send.x.length <= MAX_OP_CHARS)
    const res = server.submit(step.send, step.baseVersion)
    assert.ok(res.ok)
    step = c.ack(res.version)
    assert.ok(++rounds < 20)
  }
  assert.equal(server.text, big)
  assert.ok(rounds >= 3)
})

test('remote op that no longer fits reports desync instead of corrupting text', () => {
  const c = new OtClient('me')
  c.rebase('abc', 0)
  assert.equal(c.remote({ s: 10, e: 12, x: '' }, 1).kind, 'desync')
  assert.equal(c.remote({ s: 0, e: 0, x: 'X' }, 5).kind, 'desync')
  assert.equal(c.local, 'abc')
})

console.log(`\n  ${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
