# 📋 Clip — Engineering Changelog & Fix Archive

This document serves as a permanent reference archive of all architectural updates, bug fixes, rendering upgrades, and typography enhancements across the Clip codebase.

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
