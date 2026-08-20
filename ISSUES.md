# Clip — Issues & Bug Report

**Last Updated:** August 20, 2026  
**Scope:** Frontend, Worker API, Real-time Sync, File Management, Expiration Logic

---

## Summary

This document lists **13 verified issues** discovered through a full code review of the Clip codebase. Each issue includes the root cause with exact file/line references, reproduction scenarios, and a recommended fix.

| Severity | Count |
|----------|-------|
| 🔴 CRITICAL | 5 |
| 🟠 HIGH | 3 |
| 🟡 MEDIUM | 5 |

---

## 🔴 CRITICAL ISSUES

---

### Issue #1: Premature Entry Deletion — Dual Expiration Logic

**Severity:** 🔴 CRITICAL — Data Loss  
**File:** `worker/src/handlers/create.ts` (lines 91–117)

**Root Cause:**  
File-only entries (no text content) get a hardcoded 48-hour expiration. Text+file entries get permanent text but 48-hour files. When a user edits a permanent text paste to add files, the entry can inherit the shorter file TTL.

```typescript
// create.ts — lines 108-110
if (isFile && !hasContent) {
  expiresAt = now + (FILE_TTL_SECONDS * 1000)  // 48 hours — entire entry dies
  fileExpiresAt = expiresAt
}
```

**Problem Scenarios:**
- User uploads a file-only paste → entire entry expires in 48 hours with no warning
- User edits a permanent text paste by adding files → entry can become temporary
- No UI indication that file uploads have different expiration rules

**Recommended Fix:**
- Decouple file expiration from entry expiration — files expire independently, entry metadata persists
- Add a visible UI banner warning users about the 48-hour file TTL
- Consider making file TTL configurable via the expiration dropdown

---

### Issue #2: ZIP Download Silently Skips Missing Files

**Severity:** 🔴 CRITICAL — Core Functionality  
**File:** `worker/src/handlers/zip.ts` (lines 58–79)

**Root Cause:**  
When building a ZIP archive, `getFileKV()` returns `null` for files that have been evicted from KV (TTL expiry or propagation lag). These files are silently skipped with no error or log:

```typescript
for (const file of entry.files) {
  const data = await getFileKV(c.env.PASTE_KV, slug, file.id)
  if (data) {                    // ← null silently skipped
    zipFiles[name] = new Uint8Array(data)
  }
}
```

The user downloads a ZIP expecting 5 files but receives 3 with no indication that anything is missing.

**Recommended Fix:**
```typescript
const missingFiles: string[] = []
for (const file of entry.files) {
  const data = await getFileKV(c.env.PASTE_KV, slug, file.id)
  if (!data) {
    missingFiles.push(file.fileName)
    console.error(`ZIP: missing file blob for ${slug}:${file.id}`)
    continue
  }
  // ... add to zip
}
// Optionally include a MISSING_FILES.txt in the ZIP listing what was unavailable
```

---

### Issue #3: Real-Time Updates See Stale Data Due to KV Propagation Lag

**Severity:** 🔴 CRITICAL — Synchronization Failure  
**Files:** `worker/src/handlers/update.ts`, `frontend/src/lib/useEntrySSE.ts`, `frontend/src/pages/ViewPage.tsx`

**Root Cause:**  
Cloudflare KV is eventually consistent. When the worker writes to KV and immediately sends an SSE notification, clients that re-fetch the entry may hit a different edge node that hasn't received the KV update yet — returning stale data.

```typescript
// update.ts — lines 191-193
await putEntry(c.env.PASTE_KV, updated)           // Write to KV (edge A)
c.executionCtx?.waitUntil(notifyRoom(c.env, slug)) // SSE broadcast
// Client receives SSE → fetches from edge B → gets OLD data
```

**Additional Race Conditions:**
- **Concurrent edits:** No optimistic locking — last write wins silently, overwriting other devices' changes
- **SSE reconnection gap:** Updates during the reconnection window (before exponential backoff reconnects) are lost forever

**Recommended Fix:**
1. Include `updatedAt` timestamp in SSE event payload so clients can detect stale re-fetches
2. Add a short retry poll after receiving an SSE update (e.g., re-fetch after 500ms and 2s)
3. Add an `X-Entry-Version` header for conflict detection on PATCH requests

---

### Issue #4: File Self-Healing Doesn't Notify SSE Clients

**Severity:** 🔴 CRITICAL — Data Integrity  
**File:** `worker/src/handlers/read.ts` (lines 89–99, 160–169)

**Root Cause:**  
When a read request detects expired files, it clears the file metadata and writes the update back to KV. But it never calls `notifyRoom()`, so other tabs/devices still show `hasFile: true` and offer download links that 404:

```typescript
// read.ts — self-heal block
if (entry.fileExpiresAt && Date.now() > entry.fileExpiresAt && entry.hasFile) {
  entry.hasFile = false
  entry.files = undefined
  // ... other fields cleared
  c.executionCtx?.waitUntil(putEntry(c.env.PASTE_KV, entry))
  // ❌ Missing: notifyRoom(c.env, slug)
}
```

**Additional Problems:**
- Two concurrent reads can both trigger the self-heal → double KV write
- File blobs are not explicitly deleted — they remain in KV until their own TTL expires

**Recommended Fix:**
- Add `notifyRoom(c.env, slug)` call after self-heal write
- Explicitly delete file blobs during self-heal to free KV storage immediately
- Guard against double-write with a simple timestamp check

---

### Issue #5: ZIP Generation Can Crash Worker — Memory & CPU Limits

**Severity:** 🔴 CRITICAL — Availability  
**File:** `worker/src/handlers/zip.ts`

**Root Cause:**  
The ZIP handler loads **all** file blobs into memory simultaneously and compresses them synchronously:

```typescript
// Load every file into RAM
for (const file of entry.files) {
  const data = await getFileKV(c.env.PASTE_KV, slug, file.id)
  zipFiles[name] = new Uint8Array(data)  // ← all held in memory at once
}

// Synchronous compression of entire payload
const zipped = zipSync(zipFiles)  // ← CPU-bound, blocks event loop
```

A single entry can hold up to **50MB of aggregate files**. Loading 50MB of `Uint8Array` buffers plus generating the compressed output can easily exceed the **128MB Worker memory limit** and the **10ms CPU time limit** (free plan) or **30ms** (paid plan), causing the Worker to crash with no useful error message.

**Recommended Fix:**
- Enforce a lower maximum aggregate size for ZIP downloads (e.g., 25MB)
- Return a `413 Payload Too Large` error for entries exceeding the ZIP limit
- Consider streaming compression using `fflate`'s async API or `CompressionStream` where supported

---

## 🟠 HIGH PRIORITY ISSUES

---

### Issue #6: No Password Validation When Re-encrypting Content on Edit

**Severity:** 🟠 HIGH — Security / Usability  
**File:** `frontend/src/pages/EditPage.tsx` (lines 122–125)

**Root Cause:**  
When saving an encrypted paste, the editor re-encrypts with whatever password is in state. If the user accidentally modifies the password state or the sessionStorage value is corrupted, the content gets re-encrypted with a different password — permanently locking the user out:

```typescript
if (viewPassword) {
  finalContent = await encryptContent(content || '{"file_lock":true}', viewPassword)
}
```

There is no confirmation prompt or verification that the password matches the original decryption password.

**Recommended Fix:**
- Store the original decryption password hash in component state after successful unlock
- Before re-encrypting, verify the current `viewPassword` matches the original
- Show a confirmation dialog if the password has changed

---

### Issue #7: Rate Limiting Blocks Legitimate Users Behind Shared IPs

**Severity:** 🟠 HIGH — Availability  
**File:** `worker/src/lib/rateLimit.ts`

**Current Limits:**
```
create: 10 requests / 2 min / IP
patch:  30 requests / 2 min / IP
```

**Problems:**
- Users behind corporate NAT, VPNs, or university networks share a single IP — one heavy user blocks everyone
- No per-slug rate limiting — a user quickly editing the same paste hits the global limit
- The `retryAfter` value is computed but the response lacks the standard `Retry-After` HTTP header

**Recommended Fix:**
- Add per-slug rate limiting for PATCH requests: `ratelimit:patch:{ip}:{slug}`
- Set the `Retry-After` header in the 429 response
- Consider increasing the PATCH window for authenticated (edit-code-verified) requests

---

### Issue #8: Admin Dashboard Polls Every 2.5 Seconds with Full KV Scan

**Severity:** 🟠 HIGH — Performance  
**File:** `frontend/src/pages/AdminPage.tsx`

**Root Cause:**  
The admin dashboard runs `setInterval` every 2.5 seconds, performing a full `KV.list()` scan on every tick — even when the browser tab is hidden:

```typescript
const interval = setInterval(() => {
  const activeKey = localStorage.getItem(STORAGE_KEY)
  if (activeKey) {
    silentRefreshDashboard(activeKey)  // Full KV namespace scan
  }
}, 2500)
```

**Recommended Fix:**
- Increase interval to 10–15 seconds
- Use `document.visibilitychange` API to pause polling when the tab is hidden
- Add cursor-based pagination for large entry lists

---

## 🟡 MEDIUM PRIORITY ISSUES

---

### Issue #9: No Client-Side File Size Validation

**Severity:** 🟡 MEDIUM — UX  
**Files:** `frontend/src/pages/CreatePage.tsx`, `frontend/src/pages/EditPage.tsx`

The backend enforces 25MB per file and 50MB aggregate, but the frontend has no pre-upload validation. Users wait for a full upload only to receive a rejection error.

**Recommended Fix:**  
Add `formatBytes`-based validation in the `DropZone` component before dispatching the upload.

---

### Issue #10: Permanent Entries Still Checked for Expiration

**Severity:** 🟡 MEDIUM — Performance  
**File:** `worker/src/lib/kv.ts` (lines 48–62)

Entries with ~100-year TTLs are effectively permanent, but every read request still evaluates `Date.now() > entry.expiresAt`. While the cost per check is negligible, adding an `isPermanent` flag would be a cleaner design and skip the comparison entirely.

---

### Issue #11: No Graceful Fallback When Durable Objects Are Unavailable

**Severity:** 🟡 MEDIUM — Availability  
**File:** `worker/src/index.ts` (lines 51–64)

The SSE endpoint returns `503` if `CLIP_DO` is unavailable, but the frontend (`useEntrySSE.ts`) treats this as a generic error and enters exponential backoff. It should detect 503 specifically and fall back to interval-based polling.

---

### Issue #12: ZIP Filename Deduplication Exposes Internal File IDs

**Severity:** 🟡 MEDIUM — UX  
**File:** `worker/src/handlers/zip.ts` (lines 62–68)

When multiple files share a name, the deduplication appends internal IDs like `document_f_2_1724155200000.docx`. Users expect human-readable suffixes like `document (2).docx`.

**Recommended Fix:**
```typescript
let counter = 1
while (zipFiles[name]) {
  const parts = originalName.split('.')
  const ext = parts.length > 1 ? `.${parts.pop()}` : ''
  name = `${parts.join('.')} (${counter})${ext}`
  counter++
}
```

---

### Issue #13: No Encryption Warning for File-Only Pastes

**Severity:** 🟡 MEDIUM — Security / UX  
**File:** `frontend/src/pages/CreatePage.tsx`

When a user enables the password lock on a file-only paste, only a dummy JSON placeholder is encrypted — the actual file binaries are stored unencrypted in KV. There is no UI warning informing the user that their files remain accessible without a password.

**Recommended Fix:**  
Display a visible warning banner when files are attached and encryption is enabled, stating that file binaries are not encrypted.

---

## 📋 Previously Reported Issues — Corrections

The following issues from the original report were found to be **technically inaccurate** after code review and have been removed:

| Original # | Title | Why It Was Wrong |
|-------------|-------|------------------|
| #8 | ETag caching serves stale data | **Incorrect.** The ETag is computed from `entry.updatedAt` which is read fresh from KV on every request. If the entry was updated, the ETag changes, the `If-None-Match` comparison fails, and a 200 with fresh data is returned. |
| #13 | View counter not incremented on 304 | **Incorrect.** The code at `read.ts:185-188` explicitly increments `entry.views` on 304 responses when the request is not a polling request (`!isPolling`). |
| #15 fix | Use `kv.put({ if_match: null })` for slug collision | **Incorrect.** Cloudflare KV does not support conditional writes. The `if_match` option does not exist. Slug uniqueness would require coordination via a Durable Object or Cloudflare D1. The TOCTOU race condition itself is real, but the proposed fix is not implementable. |

---

## 🎯 Prioritized Action Plan

### Phase 1 — Critical (Fix Immediately)
1. **Issue #1:** Decouple file expiration from entry expiration + add UI warning
2. **Issue #2:** Add logging and error reporting for missing files in ZIP downloads
3. **Issue #3:** Add retry-after-SSE polling and version conflict detection
4. **Issue #4:** Call `notifyRoom()` in the self-heal path
5. **Issue #5:** Enforce ZIP size limit and return 413 for oversized entries

### Phase 2 — High Priority (Fix Within 1 Week)
6. **Issue #6:** Add password confirmation before re-encryption on edit
7. **Issue #7:** Per-slug rate limiting + `Retry-After` header
8. **Issue #8:** Reduce admin polling frequency + Page Visibility API

### Phase 3 — Medium Priority (Fix Within 2 Weeks)
9. **Issues #9–13:** UX polish, performance tweaks, and security labels
