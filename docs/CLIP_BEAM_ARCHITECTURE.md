# Clip Beam: Architecture

**Status:** Built (signalling, transfer, verification, UI, tests). Not yet deployed.
**Route:** `/beam`
**What it is:** direct browser-to-browser file transfer over WebRTC for files too big for Clip's
25 MB KV uploads. The file streams from the sender's disk to the receiver's disk. Clip's servers only
introduce the browsers to each other. One sender can feed up to 8 receivers at once, and everyone gets
a cute name like in Live Pad. People on the same network can also find each other on a radar
("Nearby") instead of typing a PIN.

Background and the wider tiered plan (KV, R2 "Vault", Beam) are in
[`HYBRID_LARGE_FILE_TRANSFER_SPEC.md`](HYBRID_LARGE_FILE_TRANSFER_SPEC.md).

---

## 1. How a transfer works

```
Sender browser            BeamRoom DO (per PIN)            Receiver browser
     │── WS /api/beam/ws ──────▶│                                 │
     │◀── room_created {pin} ───│                                 │
     │── file_offer {name,size,type} ─▶│ (stored, cleaned)        │
     │                          │◀──── WS /api/beam/ws?pin=… ─────│
     │◀── peer_joined ──────────│──── joined {offer} ────────────▶│
     │                          │                                 │ user clicks Accept,
     │                          │                                 │ picks where to save
     │◀── file_accept ──────────│◀──── file_accept ───────────────│
     │ createDataChannel('beam'), createOffer                     │
     │── signal {sdp offer} ───▶│──── signal ────────────────────▶│ createAnswer
     │◀── signal {sdp answer} ──│◀─── signal ─────────────────────│
     │◀──────── signal {candidate} both ways (trickle ICE) ──────▶│
     │                                                            │
     │◀════════════ RTCDataChannel (DTLS encrypted) ═════════════▶│
     │══ meta {name,size,type} ══════════════════════════════════▶│
     │══ binary chunks (≤128 KB) ════════════════════════════════▶│ hash, batch, write to disk
     │◀═════════════════════════════════════ ack {bytes written} ═│ (every ~4 MB)
     │══ done {sha256} ══════════════════════════════════════════▶│ flush, compare hash
     │◀══════════════════════════════════════ verified {ok} ══════│ close file (or discard)
```

The sender is always the WebRTC offerer and creates the channel, so there is no glare.

With several receivers the sender runs the right-hand half once per receiver (a "leg"): its own
`RTCPeerConnection`, its own pass over the file, its own progress and hash check. Legs are independent,
so one receiver failing, leaving or being slow never affects the others. The room, and its PIN, stay
open until the sender stops sharing, so late receivers can still join.

---

## 2. Server side

### Route: `GET /api/beam/ws` (`worker/src/index.ts`)

| Request | Meaning |
|---|---|
| no `pin` | A sender opening a room. The **worker picks the PIN** (`generateBeamPin`, 6 digits, no modulo bias) and asks that PIN's `BeamRoom`. If the room already has a sender it answers 409 and the worker tries another PIN (up to 8 times, then 503). |
| `?pin=123456` | A receiver joining. PIN must match `^\d{6}$` (else 400). Rate limited to 40 joins per 2 minutes per IP (`beam:join` in `lib/rateLimit.ts`) to slow PIN guessing (429). |
| `name=...` (optional, either role) | Display name, see section 4. |
| not a WebSocket upgrade | 426 |

The PIN is chosen on the server rather than the client so a client cannot pick a PIN that is already
in use or squat on chosen numbers.

### Durable Object: `BeamRoom` (`worker/src/durable/BeamRoom.ts`)

One instance per PIN (`BEAM_DO.idFromName(pin)`). It accepts the sockets and hands everything else to
`BeamSignalRoom` in `worker/src/lib/beam.ts`, which has no Cloudflare dependencies so it is unit
tested in Node.

- **State:** in memory only (sender socket, a map of receiver sockets, names, cleaned file offer,
  timestamps). Nothing is written to storage except the expiry alarm.
- **Receivers:** up to 8 (`BEAM_MAX_RECEIVERS`). Each gets an id (`r1`, `r2`, ... never reused in a
  room). The 9th gets `error {code: room_full}` and close 4009. A wrong PIN gets
  `error {code: no_room}` and close 4004.
- **Routing:** everything a receiver sends (`file_accept`, `file_reject`, `signal`, `cancel`) reaches
  the sender rebuilt as `{type, from: <receiver id>, data}`, so a receiver cannot forge another's id
  or add fields. The sender addresses a receiver with `to: <id>` on `signal` and `cancel`; `cancel`
  with no `to` goes to everyone. `file_offer` is stored, cleaned, and sent to everyone already in; late
  joiners get it in `joined`.
- **Roles enforced:** each side may only send its own message types; anything else gets
  `error {code: bad_message}`.
  - sender: `file_offer`, `signal`, `cancel`
  - receiver: `file_accept`, `file_reject`, `signal`, `cancel`
  - either: `ping` (answered with `pong`, not relayed)
- **Offer cleaning:** name has control characters and path separators replaced, capped at 255 chars;
  size must be a non-negative safe integer.
- **Message cap:** 64 KB per message (SDP is a few KB).
- **Leaving:** a receiver leaving tells the sender (`peer_left {id}`) and frees its slot and name.
  The sender leaving tells and closes every receiver and frees the PIN. The room always finishes the
  close handshake when a client closes (without it the client's socket never reports closed; found by
  the churn test).
- **Expiry (alarm):** a room with no receivers closes 10 minutes after it opened or after its last
  receiver left (pings do not extend this); a room with receivers closes after 10 minutes without
  signalling traffic. Clients ping every 25 s, so a room with a receiver lives as long as the tabs
  are open. Expired peers get `error {code: expired}` and close 4008.

Server to client messages: `room_created {pin, name}`, `joined {offer, name, sender}`,
`peer_joined {id, name}`, `peer_left {role, id?}`, relayed messages, `pong`, `error {code, message}`.

### `wrangler.toml`

```toml
[[durable_objects.bindings]]
name       = "BEAM_DO"
class_name = "BeamRoom"

[[migrations]]
tag                 = "v2"
new_sqlite_classes  = ["BeamRoom"]
```

`v1` / `ClipRoom` is untouched. `new_sqlite_classes` (not `new_classes`) matches `ClipRoom` and the
free plan, which only offers SQLite-backed Durable Objects.

---

## 3. Browser side (`frontend/src/beam/`)

```
frontend/src/beam/
├── BeamPage.tsx       /beam route: start panels, PIN share + QR, accept prompt, progress, results
├── useBeam.ts         React wrapper: at most one BeamSender or BeamReceiver alive at a time
├── beamSender.ts      Sender engine: room, one "leg" per receiver (WebRTC, streaming, hash check)
├── beamReceiver.ts    Receiver engine: join, accept, answer, write to disk, verify
├── beamLobby.ts      Nearby lobby client (receivers listed to senders, invites)
├── Radar.tsx          The radar: avatars on rings, tap to select several
├── beamProtocol.ts    Channel message types, tuning constants, WS URL
├── beamFormat.ts      Pure text helpers (PIN, sizes, durations); unit tested in Node
├── diskWriter.ts      Where incoming bytes go (File System Access API, or download fallback)
├── speedTracker.ts    Speed and time-left maths (see below)
└── beam.css           Monochrome styles matching the rest of Clip
```

The engines are plain classes rather than hooks so the hot path (chunks, acks, timers) never
re-renders React. They publish a state snapshot at most every 200 ms during a transfer.

### Phases

Receiver: `idle → connecting → offered → peering → transferring → verifying → done`.
Terminal: `done`, `cancelled`, `error`.

Sender room: `idle → connecting → open → stopped` (or `error`). Each receiver leg:
`joined → peering → transferring → verifying → done`, or `declined` / `error`.

The page root carries `data-beam-phase` (for the sender, a summary of its legs: `waiting`, `joined`,
`peering`, `transferring`, `verifying`, `done`, `rejected`, `error`) and `data-beam-role`; each leg row
carries `data-leg-phase`. The browser tests key off these.

### Sending (one leg per receiver)

- Each leg reads the file with its own `File.stream()`, so the file is never loaded whole into memory
  and a slow receiver cannot hold up a fast one. (The sender uploads once per receiver, so 3 receivers
  means 3x the upload bandwidth.)
- Message size: `min(128 KB, pc.sctp.maxMessageSize)`.
- Two kinds of backpressure, both must allow before the next chunk goes out:
  1. DataChannel send buffer: pause above 8 MB `bufferedAmount`, resume on `bufferedamountlow` (1 MB).
  2. Receiver flow window: at most 32 MB sent beyond the last `ack`. This stops a fast network from
     piling data into the receiver's memory when its disk is slower.
- Progress shown to the sender is bytes that have actually left the send buffer
  (`max(acked, sent - bufferedAmount)`), not bytes queued.
- A receiver's signalling socket closing also happens when it simply finishes, and that notice can
  arrive before its "verified" message on the data channel. A leg with an open channel therefore
  waits 3 s for its own messages before it counts a closed socket as "lost" (same on the receiver
  side for the sender). A cancel is sent over both the channel and the signalling socket so it lands
  even while the connection is still being set up.

### Receiving

- Accept is a click so `showSaveFilePicker()` can open. Closing the dialog leaves the offer on screen.
- Chunks are hashed as they arrive, batched to ~4 MB Blobs and written in order through a promise
  chain; after each write the receiver sends `ack {bytes}`.
- On `done {sha256}`: flush, wait for writes, compare byte count and SHA-256. Match: close the file
  and send `verified {ok: true}`. Mismatch: abort the writable (the partial file is discarded) and
  send `verified {ok: false}`.

### Disk writer (`diskWriter.ts`)

| Browser | Strategy | Limit |
|---|---|---|
| Chrome, Edge, Opera | `showSaveFilePicker()` → `FileSystemWritableFileStream`; writes go straight to disk, `abort()` removes the partial file | none |
| Firefox, Safari, others | parts kept as Blobs, one download at the end | 2 GB (page says so up front and points to Chrome/Edge) |

The service-worker streaming download (StreamSaver style) from the original plan is not built yet,
so non-Chromium browsers are capped at 2 GB.

### Speed and time left (`speedTracker.ts`)

- **Speed** is measured over a sliding 3 s window of recent samples, so it follows real throughput
  without jitter or the lag of a long average.
- **Time left** is projected from a 6 s window, then kept as a countdown: each update first ticks the
  previous estimate down by the time that passed, then pulls 25% toward the fresh projection. It counts
  down smoothly and still corrects itself when the speed changes. A stalled transfer shows
  "Calculating..." instead of a number that is no longer true.
- Measuring starts at the **first byte**, not when the connection opens, so the idle lead-in (hash
  set-up, buffers filling) does not make early estimates pessimistic. (An earlier version measured
  from connection time and read 22 s with 13 s actually left at the 30% mark.)
- Nothing is shown until 1.5 s of data has arrived.
- On a real 200 MB tab-to-tab transfer the time left was within a median 4 to 12% of the real
  remaining time (90th percentile 14 to 26%) from 30% onwards; the unit tests hold a steady 50 MB/s
  transfer to within 3%.

### Integrity

SHA-256 on both ends, computed incrementally with `hash-wasm` (WASM). On the test machine it hashes
~205 MB/s versus ~74 MB/s for a pure-JS hasher, so it does not cap LAN transfers. Both ends show
the final hash.

### Errors and edge cases (all shown as a clear message with a "Start over" button)

| Situation | What the user sees |
|---|---|
| Wrong / expired PIN | "No transfer is waiting on that PIN..." |
| Someone else already receiving | "Someone else is already receiving this file." |
| Direct connection cannot be made (strict NAT, firewall) | After 30 s, or when ICE reports `failed`: "Could not open a direct connection..." on both sides |
| Other tab closed mid-transfer | "The other device disconnected before the transfer finished." |
| Either side cancels | Canceller sees "Transfer cancelled"; the other side sees "...cancelled the transfer"; receiver's partial file is discarded |
| Receiver declines | Sender sees "The receiver declined the file" |
| Hash mismatch | Both: "...did not match the original (SHA-256 mismatch), so it was discarded" |
| File too big for a fallback browser | Shown before accepting; accepting declines with the reason |
| Room idle 10 minutes | "This Beam timed out..." |
| Closing the tab while connecting or transferring | Browser "leave site?" prompt |

The receiver can also be a phone: the sender's QR code encodes `/beam?pin=…`, which joins straight
away and then removes the PIN from the address bar.

### ICE

STUN only (`stun.cloudflare.com`, `stun.l.google.com`), no TURN. Same-network and most home
networks connect directly; two devices both behind symmetric NAT (some mobile carriers, corporate
networks) will hit the "direct connection" error. The UI shows which route was used
("Direct, same network" / "Direct, over the internet").

---

## 4. Cute names

Like Live Pad cursors, everyone in a Beam gets a friendly one-word name (Mochi, Biscuit, Pudding...)
and a colour dot derived from it. The browser asks for its own name from `loadMyName()` (the same
remembered Live Pad name, so a person is the same character in both) and sends it as `?name=`. The
room cleans it (control characters, whitespace, 24 characters), defaults to `Sender` / `Guest` if
missing, and makes names unique across the sender and all receivers by adding a number
("Mochi 2"), exactly as Live Pad does. The sender sees each receiver's name on its row; each
receiver sees its own name and the sender's ("Biscuit receiving from Mochi"). Names are display only:
nothing is authenticated by them.

## 5. Nearby (radar)

Instead of reading out a PIN, a sender can see receivers on the same network and ask them directly.
Visibility is **one-way**:

- **Receivers** opt in with "Show me to nearby senders" (off by default, nothing connects until it is
  switched on). While on, they appear to senders with a random name and avatar. They stay listed only
  while the page is open and the switch is on.
- **Senders** are never listed to anyone. A sender who has opened a Beam room sees the radar and can tap
  **several** people (or "Select all"), then "Send to N people".
- **Receivers never see each other**, only requests addressed to them.
- A request says who wants to send what ("Kiwi wants to send you holiday.mov, 4.2 GB") with
  **Accept**, **Decline** and **Block**. Accept is a single click: it leaves the lobby, joins that
  sender's room with the PIN carried in the request, and goes straight to the save dialog. Decline
  tells the sender "Declined". Block also hides all future requests from that sender for the rest of
  the visit; the sender just sees "Declined" and cannot tell they were blocked.
- Requests are withdrawn if the sender stops sharing, leaves, or the receiver closes the page.

How it works: `GET /api/beam/lobby/ws?role=sender|receiver&name=` routes to a `BeamLobby` Durable
Object (migration `v3`, `new_sqlite_classes`) chosen by the client's **public IP** (IPv6 grouped by
/64). The lobby (`worker/src/lib/beamLobby.ts`, Node-testable) holds sockets in memory only, lists
receivers to senders, relays `invite` / `accept` / `decline` / `cancel_invites`, and drops sockets that
go quiet for 150 s (clients ping every 25 s). Limits: 200 people per lobby, 8 people per request,
30 requests a minute per sender, 240 connections per 2 minutes per IP. Request contents are cleaned
the same way as Beam offers (PIN must be 6 digits, file name and size validated).

The invite is only a doorbell: the transfer itself is the normal Beam room and direct connection.

**Privacy limits to know about.** Grouping is by public IP, so on shared networks (campus Wi-Fi,
mobile carriers, an office) a sender can see strangers who switched Receive mode on. What limits that:
Receive mode is explicit and off by default, names are random and carry no identity, every request
needs an Accept, and Block exists. Anyone on the same network can also be asked by any sender on it.

## 6. What Beam stores

Nothing of its own. No `sessionStorage`, no KV (apart from the rate-limit counter for joins), no R2, no
Durable Object storage except the expiry alarm. The only `localStorage` touched is the display name
Live Pad already keeps (`clip_live_name`), which Beam reads (and creates if missing) so you are the
same character in both. The PIN lives in the room's memory and in the tabs. Closing every tab leaves
nothing behind.

---

## 7. Tests

| Suite | File | Runs in | Checks |
|---|---|---|---|
| Room, lobby and speed/ETA logic | `scripts/test-beam.mjs` | `npm test` | 60: PINs (incl. even spread), pairing, up to 8 receivers, per-receiver routing, no id forging, offer and name cleaning, roles, size cap, leave handling, expiry clocks, a 20,000-message randomised fuzz, speed and time-left accuracy (steady, noisy, speed change, stall, finish, tiny files) |
| Signalling route against a real worker | `scripts/e2e-beam-signal.mjs` | `npm run test:e2e` | 26 (16 room + 10 nearby): 426/400, PIN allocation, relay with ids, 8 receivers + 9th refused, no cross-talk, offer updates, roles, impersonation, leave/close, garbage frames, 40 concurrent rooms x 3 receivers, join/leave churn, cute names, rate limit |
| Real Chrome pages | `scripts/e2e-beam-browser.mjs` | `npm run test:browser` | 30 (+1 with `BEAM_STRESS=1`): see below |

Nearby checks (browser): off by default with no lobby connection, radar shows only opted-in people on
the same network, receivers and senders hidden from each other, switching off or closing removes someone,
multi-select send with accept and identical bytes, select all, decline vs block, stopping withdraws
requests, accepted receivers drop off the radar, radar fits phone width. Nearby checks (worker): group
isolation by IP, names, invite/accept/decline/block flows, withdrawal, forged and garbage input,
5 senders watching 60 receivers while 30 leave, lobby rate limit.

Browser checks: 200 MB streamed to disk with matching SHA-256 and live speed / time-left compared with
reality; one file to 3 receivers with a late 4th; cute names agree on both sides; 9th receiver
refused; a receiver vanishing mid-transfer; Stop sharing mid-transfer; cancelling one receiver; a
damaged chunk (flipped byte) caught by the hash; 0-byte file; unicode / emoji / HTML file names; two
independent transfers at once; Send/Receive another file; download fallback; QR link; PIN entry
validation; wrong PIN; sender reload; decline then another receiver; sender tab closed mid-transfer;
blocked network; phone width. `BEAM_STRESS=1` adds 700 MB to 2 receivers at once (headless Chrome's private file system, used as the save target, runs out of quota near 1 GB; real disk saves are not affected).

`npm run test:beam` runs all three. The browser suite points the receiver's save dialog at the
Origin Private File System (same streaming writable, readable by the test), gives each browser its
own fake client IP (joins are rate limited per IP) and launches Chrome with
`--disable-features=WebRtcHideLocalIpsWithMdns` so headless pages can reach each other.

Bugs these tests found and that are fixed: the room never finished the close handshake when a client
closed (sockets lingered); a receiver finishing could be marked failed on the sender because its
socket-closed notice overtook its "verified" message; a cancel could be reported as "disconnected";
time left was pessimistic early because it counted the idle lead-in.

**Measured locally:** 300 MB tab to tab at ~8.8 MB/s written to disk (10.9 MB/s without disk writes).
A bare DataChannel loopback benchmark on the same machine also tops out at ~10 MB/s, so that is the
local WebRTC ceiling, not Beam overhead. Real LAN numbers between two machines are not measured yet.

---

## 8. Status and what is left

Done:
- `BeamRoom` DO, `/api/beam/ws`, `v2` migration, PIN allocation, join rate limit, expiry alarm
- One sender to up to 8 receivers at once, with cute names (shared with Live Pad)
- Nearby radar: opt-in Receive mode, sender picks one or many people, Accept / Decline / Block
- `/beam` page: send, receive, PIN + copy + QR, accept/decline, progress, speed, ETA, route badge,
  cancel, results, all error states above, phone layout, links from the home page, about page and the
  25 MB upload error
- Live speed and an accurate time-left countdown, per receiver
- Streaming send with two-level backpressure, disk-streaming receive, download fallback (≤2 GB)
- SHA-256 verification on both ends
- Unit, worker e2e and two-browser e2e tests

Left:
- **Deploy:** applying migration `v2` creates the `BeamRoom` class on Cloudflare
  (`npm run deploy`; not done).
- **Measure on real hardware:** two machines on a LAN and over the internet, plus Chrome to Firefox
  and phone to laptop. Nothing outside a single Windows machine has been tested.
- **TURN fallback** for the symmetric-NAT case (Cloudflare Calls TURN or similar; has a cost).
- **Service-worker streaming download** so Firefox/Safari can receive more than 2 GB.
- **Nearby by Wi-Fi network instead of IP**, and a receiver-initiated "ask for files" (the lobby
  already carries the needed identities, but senders are deliberately invisible today).
- **Multiple files** in one Beam (queue over the same channel, or zip on the fly).
- **Send once, relay to many:** each receiver currently costs the sender one full upload; receivers
  that already have the file could pass it on.
- **Hashing in a Web Worker**: SHA-256 runs on the main thread; fine at today's speeds, worth moving
  for multi-gigabit links.
- **Resume** after a dropped connection (needs ranges plus a way to reopen the partial file).
- "Beam this file" shortcuts from Live Pad and clip pages, completion sound.
- Optional passphrase layer on top of DTLS.
