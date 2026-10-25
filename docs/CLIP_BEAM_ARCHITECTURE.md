# Clip Beam: Architecture

**Route:** `/beam`
**What it is:** direct browser-to-browser file transfer over WebRTC for files too big for Clip's normal 25 MB shares (and the 500 MB large-file path, see `docs/LARGE_FILES.md`)
uploads. Two browsers open **one direct connection that stays up**; the sender keeps adding files, the
receiver decides about each one, and either side can end the connection at any time. Clip's servers only
introduce the browsers to each other: file bytes never touch them.

Background and the wider tiered plan (KV, R2 "Vault", Beam) are in
[`HYBRID_LARGE_FILE_TRANSFER_SPEC.md`](HYBRID_LARGE_FILE_TRANSFER_SPEC.md).

---

## 1. The model: connect once, send many files

```
Sender                         Clip (BeamRoom DO)                    Receiver
  │── open room ────────────────────▶│  PIN + secret token                │
  │◀─ room_created {pin, token} ─────│                                    │
  │                                  │◀─────── join (PIN, or accepted ────│
  │◀─ peer_joined {id, name} ────────│         radar request)             │
  │ create connection, offer SDP ───▶│──────────────────────────────────▶│
  │◀──────────────────────────────── answer SDP, ICE ─────────────────────│
  │◀═══════════════ RTCDataChannel, stays up for the visit ═════════════▶│
  │◀══ hello {sk} ═══════════════════════════════════════════════════════│  who I am (session key)
  │══ offer {f:0, name, size} ═══════════════════════════════════════════▶│
  │◀══ accept {f:0, have:0}   (or reject)  ══════════════════════════════│  user clicks Accept
  │══ meta {f:0, start:0}, binary chunks, done {sha256} ═════════════════▶│  hash + write to disk
  │◀══ ack {f, bytes} … verified {f, ok} ════════════════════════════════│
  │══ offer {f:1 …}  (next file, whenever one is queued) ════════════════▶│
  │      …                                                                │
  │══ bye ═══▶  (or ◀══ bye): either side can end the connection         │
```

- **Connection first, files second.** Joining (typing the PIN, scanning the QR code, or tapping Connect on a
  radar request) only connects. Nothing is sent until the receiver accepts a specific file.
- **One file at a time per receiver**, in queue order. The sender can add files whenever the room is open
  (button or drop); every connected receiver is offered them in turn.
- **The receiver decides per file:** Accept (opens the save dialog), Decline, or **Accept all** (pick one
  folder once; every later file is saved there automatically, duplicates become `name (2).ext`).
- **Either side can end the connection:** the receiver with Disconnect, the sender per person (X on the row)
  or for everyone (Stop sharing). Either side can also cancel just the current file and keep the connection.
- The sender is always the WebRTC offerer, so there is no glare.

### Channel messages (`frontend/src/beam/beamProtocol.ts`)

| Message | From | Meaning |
|---|---|---|
| `hello {sk}` | receiver | First message: this receiver's session key, so a returning receiver is recognised |
| `offer {f, name, size, type, resume?}` | sender | A file is available (`f` = queue position) |
| `accept {f, have}` / `reject {f, reason?}` | receiver | Send it, starting at byte `have` / no |
| `meta {f, start}` | sender | Bytes follow, starting at `start` |
| binary chunks | sender | File data (≤128 KB each) for the file named in `meta` |
| `done {f, sha256}` | sender | All bytes sent, with the whole-file SHA-256 |
| `ack {f, bytes}` | receiver | `bytes` are safely written to disk (flow control + exact resume point) |
| `verified {f, ok}` | receiver | The hash matched (or not) |
| `cancel_file {f}` | either | Stop this file; the connection stays |
| `bye` | either | End the connection |
| `ping` / `pong` | either | Heartbeat |

`scripts/test-beam.mjs` has a guard test: every message type must be both sent and handled somewhere, so a
message can never be defined and silently ignored.

---

## 2. Server side

### Route: `GET /api/beam/ws` (`worker/src/index.ts`)

| Request | Meaning |
|---|---|
| no `pin` | A sender opening a room. The **worker picks the PIN** (`generateBeamPin`, 6 digits, no modulo bias) and asks that PIN's `BeamRoom`. If that PIN is taken (409) it tries another (up to 8 times, then 503). |
| `?pin=123456` | A receiver joining. Rate limited to 40 joins per 2 minutes per IP (`beam:join`). `&resume=1` marks a receiver coming back to a held room. |
| `?pin=…&token=…` | The sender taking its room back after its connection dropped. |
| `name=…` (optional) | Display name, see section 5. |
| not a WebSocket upgrade | 426 |

### Durable Object: `BeamRoom` (`worker/src/durable/BeamRoom.ts`, logic in `lib/beam.ts`)

One instance per PIN. In memory only; nothing is written to storage except the expiry alarm. It relays small
JSON messages (SDP, ICE) between one sender and up to 8 receivers and never sees file bytes.

- **Routing:** everything a receiver sends reaches the sender rebuilt as `{type, from: <receiver id>, data}`
  (a receiver cannot forge another's id or add fields). The sender addresses a receiver with `to: <id>`.
- **Roles enforced:** the sender may send `file_offer`, `signal`, `cancel`; a receiver `file_accept`,
  `file_reject`, `signal`, `cancel`; either `ping`. (`file_*` are legacy; file offers now travel over the data
  channel, not through the room.) Anything else gets `error {bad_message}`. 64 KB message cap.
- **Receivers:** ids `r1`, `r2`, … never reused; the 9th gets `error {room_full}`.
- **Held room:** a sender whose connection drops (any close except code 1000 or 1005) keeps its room and PIN
  for 10 minutes (`senderAway`); receivers are told (`sender_away`, then `sender_back`). The sender reclaims
  it with the secret token from `room_created`. While held, only returning receivers (`resume=1`) may join;
  a fresh one gets `error {sender_away}`. A deliberate close ends the room for everyone.
- **Expiry (alarm):** a room with nobody connected closes 10 minutes after it opened or after its last
  receiver left (pings do not extend this); a held room 10 minutes after the sender dropped; a room with
  receivers after 10 minutes without signalling traffic (clients ping every 25 s).
- The room always finishes the close handshake when a client closes.

Server to client messages: `room_created {pin, name, token}`, `room_resumed {pin, name}`, `joined {offer, name, sender, away}`,
`peer_joined {id, name}`, `peer_left {role, id?}`, `sender_away`, `sender_back`, relayed messages, `pong`,
`error {code, message}`.

### Route: `GET /api/beam/ice`

Returns the ICE servers the browsers should use: always the two public STUN servers; plus short-lived **TURN
relay credentials** when a Cloudflare TURN key is configured. Without a key (or if Cloudflare cannot be
reached) it quietly returns STUN only, so nothing ever breaks because of it. The browser fetches it with a
3 s timeout, caches it for 10 minutes and falls back to STUN on any failure.

To turn the relay on (so two devices behind strict NATs, such as some mobile carriers and office networks,
can still connect): create a TURN key in the Cloudflare dashboard (Realtime → TURN), then

```bash
cd worker
npx wrangler secret put TURN_API_TOKEN       # the key's API token
# and add the key id to wrangler.toml [vars]: TURN_KEY_ID = "<key id>"
```

This path is implemented but **has not been exercised against a real TURN key**. Relayed traffic is billed
by Cloudflare.

### Durable Object: `BeamLobby` and `/api/beam/lobby/ws` (the radar), see section 6

### `wrangler.toml`

`BEAM_DO` → `BeamRoom` (migration `v2`) and `BEAM_LOBBY_DO` → `BeamLobby` (migration `v3`), both
`new_sqlite_classes` (matching `ClipRoom` and the free plan). Neither uses SQL; SQLite-backed storage is simply
what new Durable Objects require, and is available if state ever needs to persist.

---

## 3. Browser side (`frontend/src/beam/`)

```
BeamPage.tsx        /beam: top bar, status chip, start screen (Send / Receive tabs), picks the session view
SenderSession.tsx   Sender view: file queue, receivers with progress and history, radar, PIN and QR
ReceiverSession.tsx Receiver view: connection, Accept all, file on offer, received files, Reconnect card
BeamBits.tsx        Shared pieces: Person (cute name + avatar), Progress (bar, speed, time left)
Radar.tsx           The radar: avatars on rings, tap to select several
useBeam.ts          React wrapper: at most one BeamSender or BeamReceiver alive; Receive mode; unfinished list
beamSender.ts       Sender engine: room, queue, one Leg per receiver (WebRTC, streaming, hashing, history)
beamReceiver.ts     Receiver engine: session, per-file accept, accept-all, write to disk, verify, resume
beamLobby.ts        Nearby lobby client
beamProtocol.ts     Channel messages, tuning constants, ICE config fetch, WS URL
beamFormat.ts       Pure text helpers (PIN, sizes, durations, file names); unit tested in Node
diskWriter.ts       Where incoming bytes go: save dialog, chosen folder, or browser download; suspend/reopen
resumeStore.ts      IndexedDB record of unfinished downloads (file handle, saved bytes, hash state)
speedTracker.ts     Speed and time-left maths
keepAwake.ts        Screen wake lock while connected
beam.css            Beam styles, built on the shared tokens so it matches Live Pad
```

The engines are plain classes rather than hooks so the hot path (chunks, acks, timers) never re-renders
React. They publish a state snapshot at most every 200 ms during a transfer.

### Look and feel

Beam uses the same shell as Live Pad: a top bar (Home button, big logo with a "Beam" pill, status chip such
as "2 connected", and the main action: Stop sharing or Disconnect), then one full-width card of bordered
panels. The start screen has a Send / Receive toggle in the style of the home page's Text / File / Live Pad
toggle, and the home page has a Beam tab. On a desktop the sender's session is two columns (work area left,
people and PIN right); on a phone it is one column and the page scrolls. Colours, radii, buttons, inputs and
the monochrome palette all come from the shared tokens.

### Phases

Receiver session: `idle → connecting → connected`, then `interrupted` on a drop (Reconnect), and finally
`ended` (by you or by the sender) or `error`. The file on offer or arriving is separate:
`offered → starting → transferring → verifying`, then it moves into the history as `done`, `declined`,
`cancelled` or `failed` while the connection carries on.

Sender: room `idle → connecting → open → stopped` (or `error`). Each receiver ("leg"):
`connecting → connected`, or `paused` (connection lost, may come back), `ended`, `error`. Each file for
each leg: `offered → transferring → verifying → done`, or `declined`, `cancelled`, `error`.

The page root carries `data-beam-phase` (a one-word summary) and `data-beam-role`; each leg row carries
`data-leg-phase`; the browser tests key off these.

### Sending (one leg per receiver)

- Each leg reads files with its own `File.stream()`, so a file is never loaded whole into memory and a slow
  receiver cannot hold up a fast one. (The sender uploads once per receiver.)
- Two kinds of backpressure: the channel's send buffer (pause above 8 MB, resume at 1 MB) and a window of
  32 MB beyond the receiver's last `ack`.
- Progress is bytes that have actually left the send buffer, not bytes queued.
- A returning receiver (same session key `sk`) takes over its paused leg's history, so files already
  delivered are not sent again and the interrupted file is re-offered with `resume`.

### Receiving

- Each accepted file has its own writer and running SHA-256. Bytes are batched into ~4 MB Blobs and written in
  order; only after a batch is written is it hashed and acknowledged, so the hash always covers exactly what
  is on disk.
- A failed file (hash mismatch, disk error, cancelled) never ends the connection: it is listed as failed and
  the next file can still arrive.

### Save targets (`diskWriter.ts`) and what differs by browser

One codebase, feature-detected; the rest of the code never asks which browser it is.

| Capability | Chrome, Edge, Opera | Firefox, Safari |
|---|---|---|
| Per-file save | Save dialog, written straight to disk | Automatic download at the end |
| Size limit per file | None | 2 GB (the file sits in memory first); larger offers are refused with a clear message |
| Accept all | Pick one folder once, everything saves there | Every file downloads automatically |
| Resume after a drop | Yes, including after a reload | Only while the page stays open |

Accept all falls back gracefully: if the chosen folder stops working (permission revoked, folder removed),
files are downloaded instead; if the folder dialog is closed, Accept all simply stays off.

### Speed and time left (`speedTracker.ts`)

- **Speed** is measured over a sliding 3 s window, so it follows real throughput without lag or jitter.
- **Time left** is projected from a 6 s window, then kept as a countdown (each update ticks the previous
  estimate down, then pulls 25% toward the fresh projection), so it counts down smoothly and still corrects
  itself. A stalled transfer shows "Calculating..." instead of a stale number.
- Measuring starts at the **first byte**, not when the connection opens.
- On a real 200 MB transfer the time left was within a median 4 to 14% of reality from 30% onwards.

---

## 4. Keeping the connection alive, and recovering when it breaks

Beam makes a series of increasingly heavy attempts before it ever gives up, and tells the user plainly what
it is doing. Nothing here stores anything on a server.

| Layer | What it does |
|---|---|
| **Heartbeat** | Both sides ping every 5 s over the direct channel. A connection that has gone silent for 25 s (no error, just nothing) is treated as lost, instead of hanging. |
| **ICE restart** | If the network path degrades (`disconnected`), the sender re-negotiates the path **on the same data channel** (up to 3 restarts) before declaring the connection lost, so a wifi roam or brief outage does not interrupt a transfer. |
| **Signalling is optional once connected** | The link to Clip is only needed to set up a connection. If it drops while the direct channel is fine, the transfer carries on untouched; the sender reconnects to Clip in the background (delays 1 to 30 s, up to 11 min) with a **Reconnect now** button, and holds its room for 10 minutes. |
| **Receiver reconnect** | On a lost connection the receiver keeps its place and retries automatically (2, 4, 8, 15, 30 s…, also the moment the browser reports it is back online), with a **Reconnect** button at any time. It reopens the same room with `resume=1`. |
| **Resume from the saved byte** | The partial file is committed to disk and its hash state saved; the reconnected receiver tells the sender `accept {have}` and the sender continues from there. The sender hashes the skipped prefix locally so the final SHA-256 still covers the whole file. |
| **Checkpoints** | Browsers keep written data in a temporary file until it is closed, so a closed tab would lose it. The partial file is therefore committed every 128 MB (or 10% of the file) and its progress record saved (IndexedDB); after a closed tab or crash, `/beam` lists **Unfinished transfers** with **Reconnect and continue**. |
| **Same receiver, same history** | A returning receiver is recognised by its session key and takes over its paused connection's history: finished files are not re-sent, the interrupted one resumes. |
| **Screen wake lock** | While connected, the screen is kept awake where the browser allows it (a sleeping phone is the most common reason a long transfer breaks). |
| **Leave-page prompt** | The browser asks before closing the tab while a transfer is running or paused. |

What cannot be recovered: the sender closing its page or deliberately stopping sharing (the file only exists
in the sender's browser), a room idle for more than 10 minutes, and, in Firefox and Safari, a reload of the
receiver's page. In those cases the message says exactly what happened and what to do.

Resume costs some disk: a checkpoint closes and reopens the file, which briefly needs room for a copy of the
part saved so far. If the disk is too full the file fails with "Could not write to disk" (the connection and
the other files are unaffected).

---

## 5. Cute names

Like Live Pad cursors, everyone gets a friendly one-word name (Mochi, Biscuit, Pudding...) and an avatar
(an emoji on a ring coloured from the name). The browser asks for its own name from `loadMyName()` (the same
remembered Live Pad name) and sends it as `?name=`. The room cleans it (control characters, whitespace,
24 characters), defaults to `Sender` / `Guest`, and makes names unique across everyone in the room by adding a
number ("Mochi 2"), exactly as Live Pad does. Names are display only; nothing is authenticated by them.

---

## 6. Nearby (radar)

Instead of reading out a PIN, a sender can see receivers on the same network and ask them directly.
Visibility is **one-way**:

- **Receivers** opt in with "Show me to nearby senders" (off by default; nothing connects until it is switched
  on). While on, they appear to senders with a random name and avatar, only while the page is open.
- **Senders** are never listed to anyone. A sender with an open room sees the radar and can tap **several**
  people (or Select all), then "Send to N people".
- **Receivers never see each other**, only requests addressed to them.
- A request says who wants to connect and what they have ("Kiwi wants to connect and send you 3 files, 60 MB").
  The receiver taps **Connect**, **Decline** or **Block** (hides that sender for the rest of the visit; the
  sender just sees "Declined"). Connect joins that sender's room; the receiver then decides about each file as
  usual, so a request never forces a download.
- Requests are withdrawn when the sender stops sharing or leaves, or the receiver closes the page.

How it works: `GET /api/beam/lobby/ws?role=sender|receiver&name=` routes to a `BeamLobby` Durable Object chosen
by the client's **public IP** (IPv6 grouped by /64, which is one household on a typical ISP). The lobby
(`worker/src/lib/beamLobby.ts`, Node-testable) holds sockets in memory only, lists receivers to senders,
relays `invite` / `accept` / `decline` / `cancel_invites`, and drops sockets that go quiet for 150 s. Limits:
200 people per lobby, 8 people per request, 30 requests a minute per sender, 240 connections per 2 minutes
per IP.

**Privacy trade-offs worth knowing.**
- The request contains the room's PIN, so the lobby gives *discoverability control, not PIN secrecy*: a
  receiver who sees a request could join that room without tapping Connect. That is accepted (they already
  chose to be visible and to receive requests, and every file still needs an Accept), but it is why the PIN
  should not be treated as a secret between people on the same network.
- Grouping is by public IP, so on shared networks (campus Wi-Fi, mobile carriers, offices) a sender can see
  strangers who switched Receive mode on. A /64 on some university or enterprise networks can cover many
  unrelated people. What limits that: Receive mode is explicit and off by default, names are random, every
  request needs a Connect, every file needs an Accept (or an explicit Accept all), and Block exists.

---

## 7. Security

1. **Transport:** WebRTC data channels are encrypted (DTLS). No file bytes touch Clip's servers.
2. **Integrity:** SHA-256 on both ends; a mismatch fails that file and discards it.
3. **Server input:** message whitelist per role, 64 KB cap, names and file names cleaned, ids rebuilt
   server-side so they cannot be forged.
4. **Receiver input:** file offers arriving over the channel are validated and their names sanitised
   (no path separators or control characters) before they reach a save dialog or a folder.
5. **PIN:** 6 random digits (bias-free), single room, 40 joins per 2 minutes per IP. The sender's reclaim
   token is a random 128-bit UUID kept in the sender's page memory only.
6. **Consent:** a connection never saves anything by itself: each file needs Accept, or the user turned on
   Accept all for that sender.

---

## 8. What Beam stores

Nothing of its own on any server. No KV (apart from the rate-limit counters), no R2, no Durable Object
storage except the expiry alarm. In the browser: the display name Live Pad already keeps
(`clip_live_name`), and, only for a partly received file on Chrome or Edge, an IndexedDB record (file handle,
saved bytes, hash state) that expires after 24 hours and is removed when the file finishes, is cancelled or
the connection ends.

---

## 9. Tests

| Suite | File | Runs in | What it covers |
|---|---|---|---|
| Room, lobby, speed and protocol logic | `scripts/test-beam.mjs` | `npm test` | PINs, pairing, up to 8 receivers, routing, no id forging, held rooms, expiry clocks, names, a 20,000-message fuzz of the room and of the lobby, speed and time-left accuracy, resume hash maths, file-name helpers, the 2 GB fallback limit, the protocol guard |
| Real worker | `scripts/e2e-beam-signal.mjs` | `npm run test:e2e` | The room and lobby over real WebSockets: 8 receivers, no cross-talk, 40 rooms at once, garbage, churn, sender reconnect, nearby, 60 receivers, rate limits, ICE endpoint |
| Real Chrome pages | `scripts/e2e-beam-browser.mjs` | `npm run test:browser` | The whole session flow, see below |

`npm run test:beam` runs all three.

Browser suite (pages in separate browser contexts talking over real WebRTC): one file with live speed and
time-left accuracy; nothing sent before Accept; empty files; unicode and HTML-like names; closing the save
dialog; browsers without pickers (downloads); a damaged chunk failing only that file; several files over one
connection, each accepted separately; adding files while connected and mid-transfer; Decline; Accept all
(one folder, renamed duplicates, switched off again, picker closed, folder breaking); cancelling a file from
either side or before it is accepted; ending the connection from either side, Stop sharing, Start over;
3 and 8 receivers, independent decisions, a 9th refused, a vanishing receiver; QR link, PIN entry
validation, wrong PIN, reloaded sender, unreachable peers (and the sender carrying on); the radar (opt-in,
network isolation, multi-select, Connect, Decline, Block, withdrawal, phone width); reconnect (automatic,
button, repeated, sender drop, both drop, signalling-only drop that must not interrupt, a silent dead
connection found by the heartbeat, closing the tab then continuing from the checkpoint, ending or stopping
while interrupted, the no-save-dialog fallback); phone width. `BEAM_STRESS=1` adds 400 MB to two receivers.

The browser suite points the save dialog and folder picker at the Origin Private File System (readable by the
test), gives each browser its own fake client IP (joins are rate limited per IP; the Nearby tests share one on
purpose) and launches Chrome with `--disable-features=WebRtcHideLocalIpsWithMdns` so headless pages can reach
each other. Connection drops are simulated by an init script that records each page's connections and closes
them; Vite's own hot-reload socket must not be cut or the page reloads.

**Measured locally:** about 8 to 10 MB/s tab to tab on this machine, which is also what a bare WebRTC
loopback benchmark reaches here, so that is this machine's ceiling, not Beam's. Real LAN and internet
numbers between two machines have not been measured.

**Not covered:** real phones, Firefox and Safari, real networks and NATs (including TURN), ICE restart on a
genuinely changing network, and a screen that actually sleeps.

---

## 10. Status and what is left

Done: everything in sections 1 to 8 above.

Left:
- **Deploy and test on real hardware**: two machines on a LAN and over the internet, Chrome to Firefox, a
  phone to a laptop, wifi roaming mid-transfer.
- **TURN**: implemented, needs a Cloudflare TURN key to be switched on and a real-network test.
- **Resume in Firefox/Safari after a reload** (needs a service-worker streaming download).
- **Send once, relay to many**: each receiver currently costs the sender one full upload.
- **Hashing in a Web Worker**: SHA-256 runs on the main thread; fine at today's speeds, worth moving for
  multi-gigabit links.
- Nearby by Wi-Fi network instead of public IP; a receiver-initiated "ask for files".
- Admin visibility into Beam rooms was considered and deliberately not added: Beam keeps no state worth
  listing, and the rooms clean themselves up.
