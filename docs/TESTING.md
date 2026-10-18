# Testing Clip

Four suites. Run the first two anywhere; the last two need the site and worker running locally.

| Suite | Command | What it covers | Needs |
|---|---|---|---|
| Unit | `npm test` (part 1) | Helpers and core logic (54 checks) | nothing |
| OT | `npm test` (part 2) | Text merge correctness, randomized multi-client runs (16 checks) | nothing |
| Site API | `npm run test:e2e` (part 1) | Every HTTP route: create, edit, expiry, verify, delete, uploads, zip, live passwords (31 checks) | worker on `127.0.0.1:8787` |
| Live pad | `npm run test:e2e` (part 2) | Real-time sync against the worker (8 checks) | worker on `8787`, `BASE=ws://127.0.0.1:8787` |
| Browser | `npm run test:browser` | Real Chrome, driving the UI (26 checks) | Vite on `5199` and worker on `8787` |

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
- **Screenshots:** a failing browser test writes a full-page screenshot to `%TEMP%/clip-e2e-browser/`.
- **Not covered by any suite:** real phones, real OS clipboard photos, PDF rendering in real Chrome, Live Pad on mobile, production admin.
