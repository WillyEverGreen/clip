# Files on a Clip link (up to 500 MB)

One Clip link can hold **any number of files, up to 500 MB in total**, on its own custom URL. The owner can add or remove files later with the edit code. Files are deleted **2 hours** after they are uploaded.

## Where files are kept

- **Small sets** (each file 25 MB or less, 50 MB or less in total) are stored with the clip in Workers KV, as before. They keep previews, ZIP browsing and password lock.
- **Bigger sets** go to a private **Backblaze B2** bucket. The browser uploads each file straight to the bucket with short-lived signed links, several at a time (files over 100 MB in 64 MB parts). Nothing is zipped, so there is no waiting and no memory spike. The worker never carries the bytes, so Cloudflare's 100 MB request limit does not apply.

The person sharing never chooses: the page decides from the sizes.

## How a bigger set flows

1. `POST /api/big/start` with the list of files checks the total (500 MB), the count (500), the per-IP rate limit and the 8 GB storage cap, opens multipart uploads for files over 100 MB, and returns an upload id and a token.
2. `POST /api/big/:id/sign` (with the token) returns upload links for up to 50 files at a time.
3. The browser uploads every piece, four at a time, retrying each.
4. `POST /api/big/:id/complete` assembles multipart files and checks every stored size against what was announced, using a version listing (a listing is not a download, so this works even when the daily download allowance is used up). A brief "storage busy" answer is retried by the browser.
5. The clip is created (`POST /api/entry`) or edited (`PATCH /api/entry/:slug`) with `bundleId` and `bundleToken`. The worker checks the token and attaches the upload to the clip; from then on only the clip's edit code can change or delete it.
6. The clip page lists every file with its own **Download** button. `GET /api/big/:id/download?n=<file>` gives a 5-minute signed link that forces a download. **Download all** fetches the files in the browser and packs them into one zip as they arrive.
7. `/f/<slug>` (the command-line file link) redirects to the first file's download.

Records live in Workers KV under `big:<id>`; a clip keeps only file names, sizes and the upload id (`bundles` on the entry). Storage keys never reach visitors.

## Deleting

- **2 hours after upload**, a cron job (every 10 minutes) deletes the upload; the clip stops listing the files the next time it is read.
- **Deleting a clip** or **removing files** in the editor deletes them at once.
- Deletes remove **every stored version** in one multi-object request (a plain delete on this bucket would only hide a file and keep the data).
- Safety net: the bucket's lifecycle rule hides anything 3 days after upload, deletes hidden versions after 1 day, and cancels unfinished multipart uploads after 1 day.

## One-time setup

1. Create a private bucket in Backblaze B2 (this project uses `clip-foo`, region `us-east-005`).
2. Bucket CORS rules: allow `PUT`, `GET`, `HEAD` (S3 operations) from `https://clip.foo.ng`, `https://*.clip-1pm.pages.dev` and local dev origins, all headers, expose `ETag`.
3. Bucket lifecycle rule as described above.
4. Create an **application key restricted to that one bucket** with `listFiles`, `readFiles`, `writeFiles`, `deleteFiles`. Do not use the master key in the app.
5. Set the secrets, then deploy the worker (this also schedules the cleanup job):

```bash
cd worker
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APP_KEY
npm run deploy
```

`B2_BUCKET`, `B2_S3_ENDPOINT` and `B2_REGION` are plain variables in `worker/wrangler.toml`. For local development put `B2_KEY_ID` and `B2_APP_KEY` in `worker/.dev.vars` (git-ignored).

## Tests

```bash
node scripts/test-big.mjs        # signing (checked against AWS's published example), MD5, rules, storage XML; no network
cd worker && npx wrangler dev --local --port 8799 --test-scheduled
node scripts/e2e-big.mjs         # real bucket: many files incl. multipart, attach to a custom URL, add/remove later, delete, expiry sweep
node scripts/e2e-big-browser.mjs # real browser through the real pages (worker on 8787, Vite on 5199, or UI=https://clip.foo.ng)
```

Download checks are reported as SKIPPED, not passed, when the bucket's daily download allowance is used up.

## Limits to know

- **Daily download allowance.** On Backblaze's free plan, downloads are capped per day. When the cap is reached, Download shows "paused for today" until it resets. Uploading, listing and deleting are not affected. Raising the cap needs a payment method in Backblaze.
- **Storage.** B2's free allowance is 10 GB; the worker refuses new uploads past 8 GB stored. The 2-hour lifetime keeps usage low.
- **Speed.** Uploads go straight to B2 and are typically faster than through the worker; downloads come from B2 (US East), so they are slower than small files served from Cloudflare.
- **Password lock** is only for sets that fit in KV (50 MB or less).
- The limits are constants: `BIG_MAX_BYTES`, `BIG_MAX_FILES`, `FILE_TTL_SECONDS` in `worker/src/lib/big.ts`, and the matching ones in `frontend/src/lib/bigUpload.ts`.

## Things learned in production

- A signed `HEAD` gets a 403 on the deployed Workers runtime, so sizes are read from a version listing.
- The multi-object delete request needs a `Content-MD5` header; Web Crypto has no MD5, so the worker carries a small implementation (`worker/src/lib/md5.ts`).
- Free Workers allow 50 outgoing requests per invocation, so deletes use one listing plus one multi-delete, and the sweep handles at most 12 uploads per run.
- Rotating the key: create a new bucket-scoped key, `wrangler secret put` both values, redeploy, then delete the old key. Never use the account's master key in the app.
