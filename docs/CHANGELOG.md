# 📋 Clip — Engineering Changelog & Fix Archive

This document serves as a permanent reference archive of all architectural updates, bug fixes, rendering upgrades, and typography enhancements across the Clip codebase.

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
