# Testing Clip

Unit-level suites run anywhere; the rest need the site and worker running locally. Clip Beam has its own three (see `docs/CLIP_BEAM_ARCHITECTURE.md`); `npm run test:beam` runs just those.

| Suite | Command | What it covers | Needs |
|---|---|---|---|
| Unit | `npm test` (part 1) | Helpers and core logic (54 checks) | nothing |
| OT | `npm test` (part 2) | Text merge correctness, randomized multi-client runs (16 checks) | nothing |
| Site API | `npm run test:e2e` (part 1) | Every HTTP route: create, edit, expiry, verify, delete, uploads, zip, live passwords (31 checks) | worker on `127.0.0.1:8787` |
| Live pad | `npm run test:e2e` (part 2) | Real-time sync against the worker (8 checks) | worker on `8787`, `BASE=ws://127.0.0.1:8787` |
| Beam logic | `npm test` (part 3) | Beam room (pairing, routing, names, fuzz) and speed / time-left maths (40 checks) | nothing |
| Beam route | `npm run test:e2e` (part 3) | `/api/beam/ws` against the real `BeamRoom` DO: 8 receivers, 40 rooms at once, garbage, churn (16 checks) | worker, `BASE=ws://127.0.0.1:8787` |
| Browser | `npm run test:browser` (part 1) | Real Chrome, driving the UI (35 checks) | Vite on `5199` and worker on `8787` |
| Beam browser | `npm run test:browser` (part 2) | Many Chrome pages: 200 MB transfer with SHA-256 check and speed / time-left accuracy, 1 to 8 receivers, names, corruption, cancel, disconnects, odd files, blocked network, phone width (21 checks) | Vite on `5199` and worker on `8787` |

## Running everything locally

1. Create `worker/.dev.vars` (git-ignored) with `APP_PEPPER=...` and `ADMIN_SECRET=...`.
2. Start the worker: `cd worker && npx wrangler dev --port 8787`
3. Start the site: `cd frontend && npx vite --port 5199 --strictPort`
4. Run:
   - `npm test`
   - `BASE=ws://127.0.0.1:8787 npm run test:e2e`
   - `ADMIN_KEY=<your ADMIN_SECRET> npm run test:browser` (the admin check runs only when `ADMIN_KEY` is set)

The browser suite uses the installed Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe`. Override with `CHROME=...`.

## Notes that will save time

- **Rate limit:** the worker allows 10 clip creates per 2 minutes per IP. The API and browser suites give each request or browser context its own fake `CF-Connecting-IP` so they don't trip it. That header is only added against localhost; production sits behind Cloudflare, which sets it itself and rejects client-supplied values.
- **Production:** the API suite can't run against production because of the rate limit. Production is checked with curl smoke tests (health, pages, admin locked 401, quote proxy, new slug).
- **Empty rooms reset:** a Live Pad with no text and no files can have its password changed without the current one. The password test seeds text first so the refusal is actually tested.
- **Dev proxy:** `frontend/vite.config.ts` keys for `/r/`, `/z/`, `/f/`, `/raw/`, `/zip/` must keep the trailing slash, or clips with slugs starting with those letters 404 in dev.
- **Beam browser test:** the receiver's save dialog is pointed at the Origin Private File System so the test can read the file back, and Chrome runs with `--disable-features=WebRtcHideLocalIpsWithMdns` so two headless pages can connect. `BEAM_MB` sets the big file size (default 200), `BEAM_STRESS=1` adds a 1 GB case and `ONLY=<text>` runs matching tests. Local WebRTC loopback tops out around 10 MB/s on Windows, so the whole Beam browser suite takes around 6 minutes. Each browser gets its own fake client IP because Beam joins are rate limited per IP.
- **Screenshots:** a failing browser test writes a full-page screenshot to `%TEMP%/clip-e2e-browser/`.
- **Preview checks** look for a decoded image inside a fixed-position overlay, not any image on the page (the header logo would otherwise pass).
- **Validation checks** assert the field is flagged `tooShort` and the form did not submit. The browser shows its own bubble, not app text.
- **Not covered by any suite:** real phones, real OS clipboard photos, PDF rendering in real Chrome, Live Pad on mobile, production admin, Cloudflare-specific behaviour, load or stress, accessibility audits, other browsers (Firefox, Safari), dark/light OS theme switching, and Beam between two real machines or across NATs.
