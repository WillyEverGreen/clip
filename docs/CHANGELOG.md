# 📋 Clip — Engineering Changelog & Fix Archive

This document serves as a permanent reference archive of all architectural updates, bug fixes, rendering upgrades, and typography enhancements across the Clip codebase.

---

## 🗓️ October 2026 — Hybrid Large File Transfer Architecture (Clip Beam & Vault Spec)

### 1. 🚀 Tri-Tier Hybrid Large File Transfer Plan
* **Architecture Specification:** Created comprehensive engineering specification [`docs/HYBRID_LARGE_FILE_TRANSFER_SPEC.md`](HYBRID_LARGE_FILE_TRANSFER_SPEC.md) detailing superfast file transfers from **100 MB to 100 GB+**.
* **Tier 1 (Instant KV):** Cloudflare KV for sub-50ms text, pastes, and attachments < 25 MB.
* **Tier 2 (Clip Vault / Cloudflare R2):** S3 multipart presigned direct-to-R2 uploads with zero egress fees for persistent 25 MB – 5 GB files.
* **Tier 3 (Clip Beam / WebRTC P2P):** Pure browser-to-browser disk-to-disk streaming via WebRTC DataChannels using `File.stream()` on sender and Chromium **File System Access API** (`window.showSaveFilePicker()`) on receiver.
* **Zero RAM Crashes:** Capped at < 35 MB browser memory overhead even when transferring 100 GB datasets.
* **Smart File Router:** Automatic detection of file size recommending instant KV, asynchronous Vault, or line-speed Beam.

---

## 🗓️ October 2026 — Admin Panel Live Pad Tracking, Expiration Monitor & Room Lifecycle Controls

### 1. ⚡ Dedicated Admin "Active Live Pads" Dashboard
* **Feature:** Added a dedicated **Active Live Pads** section in the Admin Dashboard with segmented switcher tabs (`[ Clips & Files ]` and `[ Active Live Pads ]`).
* **Real-Time Live Discovery:** Lists all active Live Pad rooms across Cloudflare KV (`live_room:*` index) and queries authoritative real-time state directly from Durable Objects (`ClipRoom`).
* **Authoritative Expiration Timestamps (`expiresAt`):**
  - Displays dynamic real-time countdown (`<Countdown expiresAt={room.expiresAt} />`) with color-coded urgency styling (<1h red, <6h amber, normal emerald).
  - Shows exact absolute expiration date/time (`Actual Expiry: DD MMM YYYY HH:mm GMT±X`).
  - Clarifies the 24-hour rolling inactivity expiration model (timer renews when users type or upload files).
* **Online Peer Tracking:** Real-time indicator of connected WebSocket peers (`🟢 N online now` with animated pulse glow).
* **Attached Live Files & Storage:** Reports file counts and total byte volume uploaded per active room.
* **Room Inspection & Remote Termination:**
  - **Inspect Modal:** Detailed view of room timestamps (Created At, Last Activity, Exact Expiration, Connected Peers).
  - **Zero-Knowledge Security Enforcement:** Password-protected / encrypted Live Pads display a `🔒 Protected` badge and hide private text/files from server and admin inspection, keeping Zero-Knowledge guarantees intact.
  - **Remote Termination:** Admin can terminate a live room immediately (`DELETE /api/admin/live/:slug`), closing all connected WebSockets and permanently purging attached files from Cloudflare KV and DO storage.

---

## 🗓️ October 2026 — Universal Media & Document Viewer, Client-Side ZIP Inspector & Zero-Knowledge Encryption Expansion

### 1. 🎬 Universal High-Quality File Previewer (`FilePreviewModal`)
* **Feature:** Built a unified, responsive media and document preview modal for both **LivePad** (`/live/:slug`) and **Static URL Pastes** (`/:slug`).
* **Cinematic Video Player:** Generous player container (`maxWidth: 1240px`, up to `100vw` in fullscreen/theater mode) up to `86vh / 94vh` height with native controls, picture-in-picture, and duration/resolution tags. No cramped or tiny boxes.
* **High-Res Image Lightbox:** Crisp uncompressed rendering (`image-rendering: auto`), 25% to 500% zoom controls, 90° rotation, mouse wheel zoom, drag-to-pan when zoomed in, and natural pixel dimension badges (`width × height px`).
* **Interactive Code & Text Viewer:** Monospace typography with line numbers gutter, Prism syntax highlighting across 30+ languages, word-wrap toggle, in-file search, and 1-click clipboard copy.
* **Audio & PDF Players:** Sleek dark audio card with waveform badge, and full-height embedded PDF frame with quick "Open in new tab" fallback.
* **Keyboard Navigation:** Cycle through all files in a paste or room using `ArrowLeft` / `ArrowRight` or floating chevrons; `Escape` to close.

### 2. 🗜️ Client-Side ZIP Archive Inspector
* **Feature:** Interactive ZIP archive explorer powered by `fflate` in client memory.
* **Capability:** Users can click on `.zip` attachments to inspect the complete archive manifest, folder structure, file counts, and uncompressed sizes with a live search filter.
* **Individual Extraction:** Users can extract and download individual files directly from within the ZIP archive without downloading the full package.

### 3. 🔐 Zero-Knowledge Binary File Encryption Expansion
* **Edit Mode Client-Side Encryption:** Newly added files in `EditPage.tsx` are encrypted client-side with AES-256-GCM before upload when the paste is password-protected.
* **Worker-Side ENC1 Decryption for Downloads & ZIPs:** Cloudflare Worker can decrypt `ENC1` files on-the-fly when provided a valid decryption password via `x-pass` or `?pass=`, enabling direct CLI downloads and complete decrypted ZIP bundle archives.
* **In-Memory Preview Decryption:** `ViewPage.tsx` decrypts `ENC1` files directly in memory via `decryptFileBuffer` so password-protected images, videos, audio, code, and zip archives can be viewed seamlessly in the previewer.

### 4. ⏳ Decoupled File Expiration & Storage Management
* **Separation of Concerns:** Entry expiration and file attachment expiration are completely decoupled.
* **Auto-Purge:** Permanent text pastes now cleanly purge attached files after 48 hours for storage efficiency while preserving permanent text forever.

### 5. 📊 Real-Time View Tracking & ETag Cache Fixes
* **Isolated KV Metrics:** View tracking stored atomically in `views:${slug}` without corrupting or mutating core entry documents.
* **Cache Integrity:** Active page visits increment view counters, while background SSE polling and ETag 304 revalidations are ignored.
* **Admin Dashboard:** Dynamic view counts enriched in real time.

---

## 🗓️ September 27, 2026 — Live Pad, Real-Time Sync, Zero-Scroll Monochrome UI & Full SEO Suite

### 1. ⚡ Live Pad Real-Time Sync (`/live/:slug`)
* **Feature:** Introduced collaborative live typing and file drop rooms.
* **Architecture:**
  * Backed by Cloudflare Durable Objects (`ClipRoom`) with in-memory and SQLite state persistence.
  * Real-time WebSocket sync between all connected devices with automatic peer count broadcasts and ping-pong keepalives.
  * Unsent local edits are safely tracked across network reconnections to prevent server snapshot overwrites.
  * Selection and cursor position are preserved across incoming remote edits to avoid cursor jumping.

### 2. 📱 Phone Pair via QR Code
* **Feature:** Instant cross-device collaboration using camera-scanned QR codes.
* **Implementation:** Integrated lightweight dynamic QR generator modal with 1-click clipboard URL copying.

### 3. 🖼️ Direct Clipboard & Drag-and-Drop Sharing
* **Feature:** Users can paste images directly from their system clipboard (<kbd>Ctrl+V</kbd> / <kbd>Cmd+V</kbd>) or drag files anywhere on the browser window.
* **Handling:** Automatic file renaming for unnamed clipboard screenshots, live upload progress bars, and support for up to 25 MB per file.

### 4. 🖥️ Zero-Scroll Viewport Layout & Mobile Tabs
* **Design Enhancement:** Workspaces dynamically fit 100% of the viewport height with zero vertical page scrolling on desktop displays.
* **Mobile Adaptation:** Side-by-side desktop panels automatically collapse into responsive `[ Editor ]` / `[ Files ]` segmented tabs on narrow mobile screens.

### 5. 🎨 Pure Monochrome Design System
* **Aesthetic Overhaul:** Fully transitioned to a strict black & white palette (`#000000`, `#050505`, `#141414`, `#262626`, `#ffffff`).
* **Iconography:** Replaced all emojis across the application with crisp Lucide vector icons (`<Zap />`, `<Upload />`, `<Lock />`, `<Folder />`, `<Check />`, `<AlertTriangle />`).

### 6. 🌐 Comprehensive Search Engine Optimization (SEO)
* **Structured Data:** Added Schema.org `WebApplication` and `FAQPage` rich snippets for Google SERP expandable accordions.
* **Metadata & Social:** Configured dynamic page title management via `useSeo`, comprehensive OpenGraph tags, Twitter `summary_large_image` cards, and canonical URLs.
* **Crawler Discovery:** Created valid `robots.txt` and `sitemap.xml` in `frontend/public/` for automated search engine bot discovery.

---

## 🗓️ August 28, 2026 — Typography, Code Blocks, Spacing & Markdown Enhancements

### 1. 🔤 Code Font & Typography Upgrade
* **Issue:** Code blocks rendered with a hollow/wireframe "outline" effect and lacked proper developer coding fonts.
* **Root Cause:**
  * `MarkdownRenderer.tsx` was importing Prism's light-mode default stylesheet (`prismjs/themes/prism.css`), which had `color: black;` and `text-shadow: 0 1px white;`. Against the dark `#09090b` background, non-keyword tokens (identifiers like `name`, `user`, `age`) became pitch-black with a 1px white drop shadow, producing a hollow wireframe appearance.
  * Monospace fonts relied on generic `monospace` without Google Font links in `index.html`.
* **Fix Applied:**
  * Switched Prism theme to `prismjs/themes/prism-tomorrow.css` and added explicit dark-theme overrides (`text-shadow: none !important; color: #e4e4e7 !important;`).
  * Imported **JetBrains Mono** and **Fira Code** with ligatures enabled (`font-feature-settings: "liga" 1, "calt" 1; font-variant-ligatures: normal;`).
  * Added Google Font `<link>` preconnects and stylesheet tags in `index.html` to eliminate FOUT and guarantee instant font delivery.
  * Added fallback font stack: `'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace`.

---

### 2. 📐 Code Block Padding & Edge Spacing
* **Issue:** Code block text touched the left and top borders with 0px spacing.
* **Root Cause:**
  * The CSS rule `.markdown-body pre[class*="language-"]` was grouped with inline code reset rules and had `padding: 0 !important;`. This inadvertently stripped all padding from the `<pre class="language-*">` container.
* **Fix Applied:**
  * Separated `pre` container styling from `code` element styling.
  * Configured generous, balanced padding on all code blocks: `padding: 1.25rem 1.5rem !important;` and header padding `0.5rem 1rem`.
  * Set `display: block; padding: 0 !important;` on the inner `<code>` element, allowing `<pre>` to govern comfortable inner boundaries.

---

### 3. 📋 Code Block Copy-to-Clipboard Button
* **Feature:** Added a dedicated **Copy** button in the header of every fenced code block.
* **Implementation Details:**
  * Updated `renderer.code` in `MarkdownRenderer.tsx` to generate an interactive header with language badge (`TYPESCRIPT`, `PYTHON`, `RUST`, etc.) on the left and a copy button on the right.
  * Implemented clipboard helper with modern `navigator.clipboard.writeText` and a hidden textarea `document.execCommand('copy')` fallback for non-HTTPS / restricted contexts.
  * Added real-time visual feedback: button displays a green checkmark + **"Copied!"** for 2 seconds before reverting to **"Copy"**.
  * Updated DOMPurify allowlist (`ADD_TAGS`: `button`, `rect`, `polyline`; `ADD_ATTR`: `stroke-width`, `viewBox`, `aria-label`, `type`) so SVG icons and buttons are safely preserved.

---

### 4. 🧮 KaTeX Multi-line Mathematics & Matrix Rendering
* **Issue:** Multi-line LaTeX matrix blocks (`\begin{matrix}`, `\begin{pmatrix}`, `\begin{bmatrix}`, `\begin{cases}`, `\begin{aligned}`) failed to parse when `breaks: true` was enabled in Marked.
* **Root Cause:** Marked's line-break parser inserted `<br>` HTML tags between LaTeX matrix rows, corrupting the KaTeX grammar parser.
* **Fix Applied:**
  * Implemented pre-normalization pipeline in `normalizeMathAndText()` inside `MarkdownRenderer.tsx`.
  * Flattened internal newlines of `$$...$$` blocks to space-separated single lines while preserving double backslashes `\\` for matrix row breaks.
  * Converted standard LaTeX delimiters `\[ ... \]` and `\( ... \)` to KaTeX standard `$$` and `$` delimiters.

---

### 5. ☑️ GFM Task List Checkboxes
* **Issue:** GFM checkboxes (`- [x]` / `- [ ]`) rendered as circular bullet points instead of interactive checkboxes.
* **Root Cause:** DOMPurify had `'input'` in `FORBID_TAGS`.
* **Fix Applied:**
  * Removed `'input'` from `FORBID_TAGS` and added `'input'` to `ADD_TAGS` with `checked` and `disabled` in `ADD_ATTR`.
  * Checkboxes now render cleanly with custom accent colors.

---

### 6. 🛡️ XSS Sanitization & Generic Types
* **Implementation:**
  * Generic programming types (e.g. `List<String>`, `Map<K, V>`, `<slug>`) are safely escaped in custom `renderer.html` without breaking layout or getting stripped.
  * Raw `<script>`, `<iframe>`, `<object>`, and `javascript:` URLs are strictly neutralized by DOMPurify before DOM injection.

---

## 🧪 Comprehensive Verification Summary

| Category | Status | Verified Behavior |
| :--- | :---: | :--- |
| **Fonts & Typography** | ✅ Passed | JetBrains Mono / Fira Code render crisp glyphs with ligatures |
| **Code Block Padding** | ✅ Passed | Generous `1.25rem 1.5rem` internal margin & padding |
| **Code Block Copy Button** | ✅ Passed | 1-click clipboard copy with 2s "Copied!" feedback & fallback |
| **KaTeX Formulas & Matrices** | ✅ Passed | Full support for pmatrix, bmatrix, cases, aligned, and integrals |
| **GFM Task Checkboxes** | ✅ Passed | Checked `[x]` and unchecked `[ ]` square checkboxes |
| **Tables & Alignment** | ✅ Passed | Left, center, right columns with embedded math & code |
| **Nested Quotes & Lists** | ✅ Passed | 3-level deep nesting with correct indentation |
| **Security / XSS** | ✅ Passed | 0 script executions, 0 event handler leaks |
