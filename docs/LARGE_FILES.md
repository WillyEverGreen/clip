# Large files (25 MB to 500 MB)

Files above the 25 MB share limit are stored in a **private Backblaze B2 bucket** instead of Workers KV. The browser uploads straight to the bucket with short-lived signed links, so the worker never carries the file and Cloudflare's 100 MB request limit does not apply.

## How it works

1. `POST /api/big/start` checks size (25 MB to 500 MB), expiry (1, 6 or 24 hours), the per-IP rate limit and the 8 GB total cap, then returns signed upload links (one link up to 100 MB, otherwise 64 MB parts).
2. The browser uploads, three parts at a time, retrying each part.
3. `POST /api/big/:id/complete` (with the sender's token) finishes the upload, checks the stored size against the announced size, and starts the expiry clock.
4. The page `/b/<id>` shows details and a Download button (`GET /api/big/:id/download` redirects to a 5-minute signed link that forces a download). The sender can `DELETE /api/big/:id` with the token (kept in their browser).
5. A cron job (every 10 minutes) deletes expired files and abandoned uploads. The bucket lifecycle rule is the safety net: it hides files 3 days after upload, deletes hidden versions after 1 day, and cancels unfinished multipart uploads after 1 day.

Records (name, size, expiry, hashed token) live in Workers KV under `big:<id>`. Nothing about the storage key is ever sent to visitors.

## One-time setup

1. Create a private bucket in Backblaze B2 (this project uses `clip-foo`, region `us-east-005`).
2. Bucket CORS rules: allow `PUT`, `GET`, `HEAD` (S3 operations) from `https://clip.foo.ng`, `https://*.clip-1pm.pages.dev` and local dev origins, all headers, expose `ETag`.
3. Bucket lifecycle rule as described above.
4. Create an **application key restricted to that one bucket** with `listFiles`, `readFiles`, `writeFiles`, `deleteFiles`. Do not use the master key in the app.
5. Set the secrets, then deploy the worker:

```bash
cd worker
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APP_KEY
npm run deploy
```

`B2_BUCKET`, `B2_S3_ENDPOINT` and `B2_REGION` are plain variables in `worker/wrangler.toml`. For local development put `B2_KEY_ID` and `B2_APP_KEY` in `worker/.dev.vars` (git-ignored).

## Tests

```bash
node scripts/test-big.mjs        # signing (checked against AWS's published example) and rules, no network
cd worker && npx wrangler dev --local --port 8799 --test-scheduled
node scripts/e2e-big.mjs         # real bucket: single and multipart uploads, CORS, delete, sweep (about 150 MB)
node scripts/e2e-big-browser.mjs # real browser through the upload screen (needs the worker on 8787 and vite on 5199)
```

## Limits to know

- B2's free allowance is 10 GB of storage; the 8 GB cap leaves headroom. Short expiry keeps the bucket small.
- Downloads come from B2 (US East) rather than Cloudflare's edge, so they are slower than small KV files.
- Raising the 500 MB cap is one constant (`BIG_MAX_BYTES` in `worker/src/lib/big.ts` and `frontend/src/lib/bigUpload.ts`).

## Things learned in production

- **Deleting must remove every version.** The bucket keeps old versions, and a plain delete only hides a file. The worker lists the versions of the key and deletes each by id, so a deleted file is really gone straight away. The bucket's lifecycle rule is only the safety net.
- **Sizes are read with a one-byte Range request**, not HEAD: on the deployed Workers runtime a signed HEAD gets a 403, while a ranged GET works everywhere.
- **Storage can answer a moment late right after an upload.** The worker retries the size check a few times, and if it still cannot read the file it answers `503 storage_busy` without discarding anything; the browser then asks again (up to 5 times).
- **Rotating the key:** create a new bucket-scoped key, run `wrangler secret put B2_KEY_ID` and `B2_APP_KEY` with it, redeploy, then delete the old key. Never use the account's master key in the app.
