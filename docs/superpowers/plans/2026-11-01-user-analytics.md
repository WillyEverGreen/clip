# User Analytics & Laptop Exclusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a privacy-first, edge-native user analytics engine for Clip with automatic laptop and IP exclusion, rendered inside a new "Analytics" tab in the `/admin` panel.

**Architecture:** A lightweight frontend hook sends fire-and-forget page-view beacons to `/api/analytics/event`. The Cloudflare Worker validates the request against client-side opt-out flags and a KV-persisted IP blacklist, sanitizes dynamic slugs to generic route templates, and aggregates metrics into an SQLite-backed `AnalyticsStore` singleton Durable Object. The `/admin` dashboard displays rolling stats (Today, 7d, 30d), breakdown bars (pages, referrers, devices, countries), and one-click laptop and IP exclusion controls.

**Tech Stack:** Cloudflare Workers, Hono, Durable Objects (SQLite), Cloudflare KV, React 18, React Router v6, TypeScript, Vite, Lucide icons.

**Spec:** `docs/superpowers/specs/2026-11-01-user-analytics-design.md`

## Global Constraints

- Never log or store raw IP addresses in plain text — hash them using `SHA256(IP + Salt + YYYY-MM)` with a rotating salt.
- Never log private entry slugs (e.g. `/my-secret-id`) — mask dynamic URLs to route patterns (`/:slug`, `/live/:slug`, `/b/:slug`).
- Zero tracking cookies or GDPR banners — strictly privacy-first, cookieless, and first-party.
- Zero impact on page navigation performance — client beacon must be non-blocking (< 1 KB) using `navigator.sendBeacon` or `keepalive` fetch.
- All admin analytics endpoints must require valid `ADMIN_SECRET` authentication matching `getAdminAuthStatus`.
- Maintain 100% backward compatibility with all existing Clip features, tests, and admin functions.

## Review Focus

1. **Owner Laptop Leakage:** An owner navigating the site without being logged into `/admin` might accidentally trigger beacons if their IP rotates — verify that toggling "Exclude this device" in `/admin` sets a persistent `localStorage` flag that suppresses beacons across all routes.
2. **Concurrent Write Bottleneck:** Multiple simultaneous visitors hitting the beacon endpoint must not fail or drop counts — verify SQLite transactions in `AnalyticsStore` handle concurrent bursts cleanly without key-locking limits.
3. **Private Slug Exposure:** Visiting a password-protected or unlisted paste URL like `/secret-passwords-xyz` must never record the raw slug string in the database or admin UI — verify route sanitization catches all parameter patterns.
4. **Multi-Day Unique Visitor Deduplication:** Unique visitors across 7-day and 30-day windows must not simply be the sum of daily counts — verify the monthly salt deduplicates repeating visitors within the calendar month.
5. **Admin Route Re-entrancy:** Admin requests (`/admin`, `/api/admin/*`, or carrying `ADMIN_SECRET`) must never count toward site analytics — verify edge exclusion filters them before reaching the database.

---

### Task 1: AnalyticsStore Durable Object (SQLite) & Configuration

**Files:**
- Create: `worker/src/durable/AnalyticsStore.ts`
- Modify: `worker/wrangler.toml:21-52`
- Modify: `worker/src/lib/types.ts:1-20`
- Modify: `worker/src/index.ts:22-28`
- Test: `scripts/test-analytics-do.mjs`

**Interfaces:**
- Consumes: Cloudflare Workers SQLite Durable Object API (`DurableObjectState.storage.sql`).
- Produces: `AnalyticsStore` class with `recordEvent(event: AnalyticsEvent): Promise<void>` and `getStats(range: 'today' | '7d' | '30d'): Promise<AnalyticsSummary>`.

- [ ] **Step 1: Write the failing test for `AnalyticsStore`**

Create `scripts/test-analytics-do.mjs` testing:
1. Creating SQLite tables `views` and `daily_rollups`.
2. Inserting multiple events (different dates, devices, countries, paths, visitor hashes).
3. Querying `today`, `7d`, and `30d` summaries (totalViews, uniqueVisitors, top paths, top referrers, device breakdown, top countries).
4. Pruning raw events older than 30 days while keeping rollups.

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-analytics-do.mjs`
Expected: FAIL with "Cannot find module ... AnalyticsStore.ts"

- [ ] **Step 3: Implement `AnalyticsStore` in `worker/src/durable/AnalyticsStore.ts`**

Define `AnalyticsStore`:
- Initialize SQLite schema in constructor:
  ```sql
  CREATE TABLE IF NOT EXISTS views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    path TEXT NOT NULL,
    referrer TEXT NOT NULL,
    country TEXT NOT NULL,
    device TEXT NOT NULL,
    visitor_hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_views_date ON views(date);
  CREATE INDEX IF NOT EXISTS idx_views_hash ON views(visitor_hash);
  CREATE TABLE IF NOT EXISTS daily_rollups (
    date TEXT PRIMARY KEY,
    total_views INTEGER NOT NULL,
    unique_visitors INTEGER NOT NULL,
    data_json TEXT NOT NULL
  );
  ```
- Implement `recordEvent` with SQLite insert.
- Implement `getStats(range)` aggregating `totalViews`, `COUNT(DISTINCT visitor_hash)`, group counts for paths, referrers, countries, and devices.
- Implement `rollup(date)` to summarize past days and clean raw records older than 30 days.

- [ ] **Step 4: Register `ANALYTICS_DO` binding and migration in `worker/wrangler.toml`, `worker/src/lib/types.ts`, and `worker/src/index.ts`**

- Add to `wrangler.toml`:
  ```toml
  [[durable_objects.bindings]]
  name       = "ANALYTICS_DO"
  class_name = "AnalyticsStore"

  [[migrations]]
  tag                 = "v5"
  new_sqlite_classes  = ["AnalyticsStore"]
  ```
- Export `AnalyticsStore` in `worker/src/index.ts`.
- Add `ANALYTICS_DO: DurableObjectNamespace<AnalyticsStore>` to `Env` interface in `worker/src/lib/types.ts`.

- [ ] **Step 5: Run test to verify it passes**

Run: `node scripts/test-analytics-do.mjs`
Expected: PASS with 100% assertions green.

- [ ] **Step 6: Commit**

```bash
git add worker/src/durable/AnalyticsStore.ts worker/wrangler.toml worker/src/lib/types.ts worker/src/index.ts scripts/test-analytics-do.mjs
git commit -m "feat(analytics): add SQLite-backed AnalyticsStore Durable Object"
```

---

### Task 2: Worker Analytics API & Exclusion Engine

**Files:**
- Create: `worker/src/handlers/analytics.ts`
- Modify: `worker/src/index.ts:60-120`
- Test: `scripts/test-analytics-api.mjs`

**Interfaces:**
- Consumes: `c.env.ANALYTICS_DO`, `c.env.PASTE_KV`, `c.req.raw.cf`, `getClientIp(c.req.raw)`.
- Produces:
  - `POST /api/analytics/event` (public beacon)
  - `GET /api/admin/analytics` (admin metrics query)
  - `POST /api/admin/analytics/excluded-ips` (add/remove excluded IP in KV)
  - `GET /api/admin/analytics/detected-ip` (returns client's detected IP for easy one-click exclusion)

- [ ] **Step 1: Write the failing test for analytics endpoints**

Create `scripts/test-analytics-api.mjs` testing:
1. `POST /api/analytics/event` with valid payload records a view and returns 204 No Content.
2. If IP is in `analytics:excluded_ips` in KV, `POST /api/analytics/event` returns 204 but does NOT record a view.
3. If request contains `Authorization: Bearer <ADMIN_SECRET>`, it is dropped without recording.
4. Slug paths like `/f4a5dd3` are masked to `/:slug`.
5. `GET /api/admin/analytics` without admin secret returns 401; with secret returns aggregate statistics.
6. `POST /api/admin/analytics/excluded-ips` adds and removes IPs in KV list.

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-analytics-api.mjs`
Expected: FAIL with "Cannot find module ... handlers/analytics.ts"

- [ ] **Step 3: Implement `worker/src/handlers/analytics.ts`**

- Path sanitizer function:
  ```ts
  export function sanitizePath(rawPath: string): string {
    const p = rawPath.split('?')[0].trim()
    if (['', '/', '/about', '/beam', '/live'].includes(p)) return p || '/'
    if (p.startsWith('/live/')) return '/live/:slug'
    if (p.startsWith('/b/')) return '/b/:slug'
    if (p.startsWith('/admin')) return '/admin'
    // Generic single-segment slug (e.g. /my-slug or /my-slug/edit)
    const parts = p.split('/').filter(Boolean)
    if (parts.length === 1) return '/:slug'
    if (parts.length === 2 && parts[1] === 'edit') return '/:slug/edit'
    return '/other'
  }
  ```
- Device parser: detects `mobile`, `tablet`, or `desktop` from `User-Agent`.
- IP exclusion check against KV key `analytics:excluded_ips`.
- Monthly rotating salt hash for unique visitors:
  `crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + '-' + yearMonth + '-' + pepper))`
- Forward event payload to `c.env.ANALYTICS_DO.get(c.env.ANALYTICS_DO.idFromName('global'))`.
- Implement `handleAdminAnalytics`, `handleAdminExcludedIps`, and `handleAdminDetectedIp`.

- [ ] **Step 4: Mount routes in `worker/src/index.ts`**

- Connect `/api/analytics/event` to `handleAnalyticsEvent`.
- Connect `/api/admin/analytics` to `handleAdminAnalytics`.
- Connect `/api/admin/analytics/excluded-ips` to `handleAdminExcludedIps`.
- Connect `/api/admin/analytics/detected-ip` to `handleAdminDetectedIp`.

- [ ] **Step 5: Run test to verify it passes**

Run: `node scripts/test-analytics-api.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/handlers/analytics.ts worker/src/index.ts scripts/test-analytics-api.mjs
git commit -m "feat(analytics): add worker analytics endpoints and IP exclusion engine"
```

---

### Task 3: Frontend Analytics Beacon Hook & Client Exclusion Switch

**Files:**
- Create: `frontend/src/lib/analytics.ts`
- Modify: `frontend/src/App.tsx:70-100`
- Test: `scripts/test-analytics-frontend.mjs`

**Interfaces:**
- Consumes: React Router `useLocation()`, `localStorage`, `navigator.sendBeacon`.
- Produces: `useAnalytics()`, `isDeviceExcluded(): boolean`, `setDeviceExcluded(excluded: boolean): void`.

- [ ] **Step 1: Write unit test for frontend analytics client**

Create `scripts/test-analytics-frontend.mjs` testing:
1. `isDeviceExcluded()` returns `true` when `localStorage.getItem('clip_analytics_opt_out') === '1'`.
2. When opted out, beacon dispatcher performs zero network requests.
3. When opted in, beacon payload accurately packages `{ path, referrer }`.
4. `setDeviceExcluded(true)` sets the flag; `setDeviceExcluded(false)` clears it.

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-analytics-frontend.mjs`
Expected: FAIL with "Cannot find module ... lib/analytics.ts"

- [ ] **Step 3: Implement `frontend/src/lib/analytics.ts`**

- Define constants:
  `const OPT_OUT_KEY = 'clip_analytics_opt_out'`
- Export `isDeviceExcluded()` and `setDeviceExcluded(excluded: boolean)`.
- Export `reportPageView(pathname: string)`:
  - If `isDeviceExcluded()` is true, return immediately.
  - If `pathname.startsWith('/admin')`, return immediately.
  - Send beacon with `navigator.sendBeacon(`${BASE}/api/analytics/event`, blob)` with fallback to `fetch(`${BASE}/api/analytics/event`, { method: 'POST', keepalive: true, ... })`.
- Export `useAnalytics()` hook:
  ```ts
  export function useAnalytics() {
    const location = useLocation()
    useEffect(() => {
      reportPageView(location.pathname)
    }, [location.pathname])
  }
  ```

- [ ] **Step 4: Mount `useAnalytics()` in `frontend/src/App.tsx`**

- Inside `App()`, call `useAnalytics()` under `BrowserRouter`.

- [ ] **Step 5: Run test to verify it passes**

Run: `node scripts/test-analytics-frontend.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/analytics.ts frontend/src/App.tsx scripts/test-analytics-frontend.mjs
git commit -m "feat(analytics): add useAnalytics beacon hook with localStorage laptop exclusion"
```

---

### Task 4: Admin Panel "Analytics" Tab UI & IP Management

**Files:**
- Modify: `frontend/src/lib/api.ts:35-120`
- Modify: `frontend/src/pages/AdminPage.tsx:40-200, 600-900`
- Test: `scripts/test-admin-analytics-ui.mjs`

**Interfaces:**
- Consumes: `fetchAdminAnalytics`, `addAdminExcludedIp`, `removeAdminExcludedIp`, `isDeviceExcluded`, `setDeviceExcluded`.
- Produces: New third tab `analytics` in `AdminPage.tsx`.

- [ ] **Step 1: Write test for admin analytics client API methods**

Create `scripts/test-admin-analytics-ui.mjs` testing:
1. `fetchAdminAnalytics(adminKey, 'today' | '7d' | '30d')` formats request headers and returns summary data.
2. `fetchAdminDetectedIp(adminKey)` fetches detected client IP.
3. `addAdminExcludedIp(adminKey, ip)` and `removeAdminExcludedIp(adminKey, ip)` make correct REST requests.

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-admin-analytics-ui.mjs`
Expected: FAIL with "fetchAdminAnalytics is not exported"

- [ ] **Step 3: Add API functions to `frontend/src/lib/api.ts`**

Export:
- `fetchAdminAnalytics(adminKey: string, range?: string): Promise<AnalyticsSummary>`
- `fetchAdminDetectedIp(adminKey: string): Promise<{ ip: string }>`
- `fetchAdminExcludedIps(adminKey: string): Promise<{ ips: string[] }>`
- `addAdminExcludedIp(adminKey: string, ip: string): Promise<{ ok: boolean }>`
- `removeAdminExcludedIp(adminKey: string, ip: string): Promise<{ ok: boolean }>`

- [ ] **Step 4: Build Analytics tab in `frontend/src/pages/AdminPage.tsx`**

1. Add tab button: `pastes` | `live` | `analytics` with `BarChart2` icon.
2. State:
   - `analyticsRange`: `'today' | '7d' | '30d'`
   - `analyticsData`: `AnalyticsSummary | null`
   - `isLaptopExcluded`: boolean (synced with `isDeviceExcluded()`)
   - `detectedIp`: string
   - `excludedIps`: string[]
   - `manualIpInput`: string
3. Render subcomponents:
   - **Metrics Overview Cards:** Total Page Views, Unique Visitors, Top Page, Primary Device.
   - **Range Selector:** Quick pills for `Today`, `Last 7 Days`, `Last 30 Days`.
   - **Breakdown Grid:**
     - Top Pages table with progress proportion bars.
     - Top Referrers list.
     - Top Countries list with country codes and counts.
     - Devices split (% Desktop vs % Mobile vs % Tablet).
   - **Laptop & IP Exclusion Management Card:**
     - Toggle switch: *"Exclude this Device / Laptop"* with badge status.
     - Detected IP box with instant button: *"Exclude Current IP (<ip>)"*.
     - List of currently excluded IPs with red trash icon to unblock.
     - Manual IP entry input to add any custom IP.

- [ ] **Step 5: Run test to verify it passes**

Run: `node scripts/test-admin-analytics-ui.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/pages/AdminPage.tsx scripts/test-admin-analytics-ui.mjs
git commit -m "feat(analytics): add Analytics dashboard tab with device & IP exclusion controls in Admin"
```

---

### Task 5: End-to-End Verification & Full Regression Testing

**Files:**
- Modify: `package.json:11`
- Create: `scripts/e2e-analytics.mjs`

- [ ] **Step 1: Write full end-to-end analytics workflow test**

Create `scripts/e2e-analytics.mjs`:
1. Simulates visitor beacon from public IP -> verifies view count increments in analytics store.
2. Simulates second visitor from same IP on same day -> verifies totalViews increments by 1, but uniqueVisitors stays 1.
3. Adds visitor IP to excluded IP list in admin -> sends beacon from that IP -> verifies view count does NOT increment.
4. Sends beacon with simulated `clip_analytics_opt_out` or admin secret -> verifies view count does NOT increment.
5. Verifies dynamic slug masking (`/my-random-test-slug` recorded as `/:slug`).
6. Verifies Admin analytics endpoint returns properly aggregated top pages, countries, devices, and referrers.

- [ ] **Step 2: Run end-to-end analytics test**

Run: `node scripts/e2e-analytics.mjs`
Expected: PASS with all 6 stages verified.

- [ ] **Step 3: Run entire project test suite to verify no regressions**

Run: `npm test`
Expected: All existing tests pass (crypto, OT, beam, big files, SEO, etc.).

- [ ] **Step 4: Update `package.json` test script**

Include `node scripts/test-analytics-do.mjs && node scripts/test-analytics-api.mjs && node scripts/e2e-analytics.mjs` in `npm test`.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/e2e-analytics.mjs
git commit -m "test(analytics): add end-to-end test suite and integrate into project test runner"
```
