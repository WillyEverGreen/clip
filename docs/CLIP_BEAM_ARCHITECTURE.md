# Clip Beam: Architecture

**Status:** Built (signalling, transfer, verification, UI, tests). Not yet deployed.
**Route:** `/beam`
**What it is:** direct browser-to-browser file transfer over WebRTC for files too big for Clip's
25 MB KV uploads. The file streams from the sender's disk to the receiver's disk. Clip's servers only
introduce the two browsers to each other.

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

---

## 2. Server side

### Route: `GET /api/beam/ws` (`worker/src/index.ts`)

| Request | Meaning |
|---|---|
| no query | A sender opening a room. The **worker picks the PIN** (`generateBeamPin`, 6 digits, no modulo bias) and asks that PIN's `BeamRoom`. If the room already has a sender it answers 409 and the worker tries another PIN (up to 8 times, then 503). |
| `?pin=123456` | A receiver joining. PIN must match `^\d{6}$` (else 400). Rate limited to 20 joins per 2 minutes per IP (`beam:join` in `lib/rateLimit.ts`) to slow PIN guessing (429). |
| not a WebSocket upgrade | 426 |

The PIN is chosen on the server rather than the client so a client cannot pick a PIN that is already
in use or squat on chosen numbers.

### Durable Object: `BeamRoom` (`worker/src/durable/BeamRoom.ts`)

One instance per PIN (`BEAM_DO.idFromName(pin)`). It accepts the sockets and hands everything else to
`BeamSignalRoom` in `worker/src/lib/beam.ts`, which has no Cloudflare dependencies so it is unit
tested in Node.

- **State:** in memory only (sender socket, receiver socket, cleaned file offer, timestamps). Nothing
  is written to storage except the expiry alarm.
- **Roles enforced:** each side may only send its own message types; anything else gets
  `error {code: bad_message}`.
  - sender: `file_offer`, `signal`, `transfer_complete`, `cancel`
  - receiver: `file_accept`, `file_reject`, `signal`, `transfer_complete`, `cancel`
  - either: `ping` (answered with `pong`, not relayed)
- **Offer cleaning:** name has control characters and path separators replaced, capped at 255 chars;
  size must be a non-negative safe integer.
- **Message cap:** 64 KB per message (SDP is a few KB).
- **One receiver:** a second receiver gets `error {code: room_full}` and close 4009. Wrong PIN gets
  `error {code: no_room}` and close 4004.
- **Leaving:** receiver leaving tells the sender (`peer_left`) and frees the slot for another
  receiver. Sender leaving tells and closes the receiver and frees the PIN.
- **Expiry (alarm):** an unpaired room closes 10 minutes after it was created; a paired room closes
  after 10 minutes without signalling traffic. Clients ping every 25 s, so a paired room lives as long
  as both tabs are open. Expired peers get `error {code: expired}` and close 4008.

Server to client messages: `room_created {pin}`, `joined {offer}`, `peer_joined`,
`peer_left {role}`, relayed messages, `pong`, `error {code, message}`.

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
├── useBeam.ts         React wrapper owning one BeamSession at a time
├── beamSession.ts     The transfer engine (signalling, WebRTC, sending, receiving, verification)
├── beamProtocol.ts    Message types, tuning constants, PIN/size/time formatting, WS URL
├── diskWriter.ts      Where incoming bytes go (File System Access API, or download fallback)
├── speedTracker.ts    Smoothed speed (EMA) and time remaining
└── beam.css           Monochrome styles matching the rest of Clip
```

`beamSession.ts` is a plain class rather than a hook so the hot path (chunks, acks, timers) never
re-renders React. It publishes a `BeamState` snapshot at most every 200 ms during a transfer.

### Phases

`idle → connecting → waiting → joined → peering → transferring → verifying → done` (sender)
`idle → connecting → offered → peering → transferring → verifying → done` (receiver)
Terminal: `done`, `rejected` (sender, receiver declined), `cancelled`, `error`.

The page root carries `data-beam-phase` and `data-beam-role`; the browser tests key off these.

### Sending (`runSender`)

- Reads with `File.stream()`, so the file is never loaded whole into memory.
- Message size: `min(128 KB, pc.sctp.maxMessageSize)`.
- Two kinds of backpressure, both must allow before the next chunk goes out:
  1. DataChannel send buffer: pause above 8 MB `bufferedAmount`, resume on `bufferedamountlow` (1 MB).
  2. Receiver flow window: at most 32 MB sent beyond the last `ack`. This stops a fast network from
     piling data into the receiver's memory when its disk is slower.
- Progress shown to the sender is bytes that have actually left the send buffer
  (`max(acked, sent - bufferedAmount)`), not bytes queued.

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

## 4. What Beam stores

Nothing. No `localStorage`/`sessionStorage`, no KV (apart from the rate-limit counter for joins), no
R2, no Durable Object storage except the expiry alarm. The PIN lives in the room's memory and in the
two tabs. Closing both tabs leaves nothing behind.

---

## 5. Tests

| Suite | File | Runs in | Checks |
|---|---|---|---|
| Signalling logic | `scripts/test-beam.mjs` | `npm test` | 13: PINs, join/full/no-room, relay both ways, role enforcement, offer cleaning, size cap, leave handling, expiry |
| Signalling route against a real worker | `scripts/e2e-beam-signal.mjs` | `npm run test:e2e` | 8: 426/400, PIN allocation, relay, wrong PIN, room full, roles, leave/close, rate limit |
| Two real Chrome pages | `scripts/e2e-beam-browser.mjs` | `npm run test:browser` | 9: 300 MB straight to disk with progress on both ends and matching SHA-256, download fallback, QR link, wrong PIN, decline, receiver tab closed mid-transfer, sender cancel discards partial file, blocked network shows the connection error, phone width |

`npm run test:beam` runs all three. The browser suite points the receiver's save dialog at the
Origin Private File System (same streaming writable, readable by the test) and launches Chrome with
`--disable-features=WebRtcHideLocalIpsWithMdns` so two headless pages can reach each other.

**Measured locally:** 300 MB tab to tab at ~8.8 MB/s written to disk (10.9 MB/s without disk writes).
A bare DataChannel loopback benchmark on the same machine also tops out at ~10 MB/s, so that is the
local WebRTC ceiling, not Beam overhead. Real LAN numbers between two machines are not measured yet.

---

## 6. Status and what is left

Done:
- `BeamRoom` DO, `/api/beam/ws`, `v2` migration, PIN allocation, join rate limit, expiry alarm
- `/beam` page: send, receive, PIN + copy + QR, accept/decline, progress, speed, ETA, route badge,
  cancel, results, all error states above, phone layout, links from the home page, about page and the
  25 MB upload error
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
- **Multiple files** in one Beam (queue over the same channel, or zip on the fly).
- **Hashing in a Web Worker**: SHA-256 runs on the main thread; fine at today's speeds, worth moving
  for multi-gigabit links.
- **Resume** after a dropped connection (needs ranges plus a way to reopen the partial file).
- "Beam this file" shortcuts from Live Pad and clip pages, completion sound.
- Optional passphrase layer on top of DTLS.
