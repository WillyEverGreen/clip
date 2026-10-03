<div align="center">

  <a href="https://clip.foo.ng">
    <img src="frontend/public/clip-header.png" height="50" alt="clip" />
  </a>

  <p><b>Instant free file sharing, text sharing, and real-time collaborative Live Pad. Zero accounts, zero tracking, end-to-end encrypted.</b></p>

  <p>
    <a href="https://clip.foo.ng"><b>🌐 Live Demo: clip.foo.ng</b></a> • <a href="https://clip.foo.ng/live"><b>⚡ Live Pad: clip.foo.ng/live</b></a>
  </p>

</div>

---

### 💡 Why Clip was built

> *"I created Clip because I was tired of having to log into WhatsApp Web or cloud drives on college library and lab PCs every single time I needed to quickly transfer a code snippet, link, or document to myself or a classmate."*

**Clip** solves this exact problem: a friction-free, lightweight web utility to create temporary, shareable links for text, markdown, and files in seconds - without leaving personal accounts signed in on public computers.

---

### ✨ Features

- 🚀 **Zero Friction & No Sign-up**: Open the site, paste your text or drop your files, get your link instantly. No account, email, or credentials required.
- ⚡ **Real-Time Live Pad (`/live/:slug`)**: Collaborative notepad and live file sharing room with instant WebSocket synchronization powered by Cloudflare Durable Objects (SQLite). Everything synchronizes live across devices as you type.
- 🎬 **Universal Media & Document Viewer**: Full-screen theater viewer for both LivePad and URL pastes. Generous cinematic video player, uncompromised high-res image lightbox with 25%–500% zoom and pan, line-numbered syntax-highlighted code with search and copy, and embedded PDF / audio playback.
- 🗜️ **Client-Side ZIP Archive Inspector**: Click on any attached `.zip` to explore its internal directories and files in real-time, search inside the archive, and extract/download individual files without downloading the full archive.
- 🛡️ **Admin Live Pad & Expiration Monitor**: Dedicated admin section to track all active Live Pad rooms, view exact 24-hour rolling expiration countdowns and timestamps, monitor live connected peers, and terminate rooms.
- 📱 **Phone Pair via QR Code**: Connect your phone to any Live Pad room in one second by scanning a QR code with your camera.
- 📋 **Direct Clipboard & Drag-and-Drop Sharing**: Paste images or screenshots directly from your clipboard (<kbd>Ctrl+V</kbd> / <kbd>Cmd+V</kbd>) or drag and drop any file up to 25 MB.
- 🖥️ **Zero-Scroll Viewport Layout**: Desktop workspace dynamically adapts to 100% viewport height with no vertical page scroll. Seamlessly collapses into dedicated mobile tabs on narrow screens.
- 🎨 **Pure Monochrome (Black & White) Aesthetics**: Clean, distraction-free solid black (`#000000`) and pure white theme with Lucide iconography and zero emojis.
- 💻 **Terminal / CLI Downloads**: Fetch pastes and files straight from Linux, macOS, or Windows terminals using simple `curl` commands with optional password flags.
- 📦 **1-Command ZIP Download**: Retrieve text (`<slug>.txt`) and all attached files combined into a single ZIP archive, decrypted on-the-fly when encrypted.
- 🕒 **Custom Expiration Timers**: Choose how long your link stays active: `10 Minutes`, `1 Hour`, `6 Hours` *(Default)*, `1 Day`, `7 Days`, `30 Days`, or `Permanent` (files cleanly auto-purge after 48h to optimize storage).
- 🔒 **Zero-Knowledge Client-Side Encryption**: Secure text pastes and file uploads with browser-side **PBKDF2 + AES-256-GCM** encryption across creation, edits, and live rooms. The server never sees your password or plaintext data.
- 🔑 **Secret Edit Code**: Protect your links with a custom edit password to modify content, add/remove files, or delete early.
- 🔗 **Custom & Retained Slugs**: Pick your own readable URL slug (`clip.foo.ng/my-notes`) or convert live rooms into permanent clips while preserving the same slug.
- 📁 **Rich Markdown & KaTeX Math**: Full support for GitHub Flavored Markdown (GFM), task lists, tables, and KaTeX mathematical typesetting ($\LaTeX$, matrices, piecewise functions, integrals).
- 🔤 **Developer Typography & Code Blocks**: Crisp syntax highlighting for 40+ languages with **JetBrains Mono** / **Fira Code** fonts and 1-click code block **Copy** buttons.
- 🌐 **Comprehensive SEO & Rich Snippets**: Schema.org `WebApplication` & `FAQPage` rich snippets, dynamic OpenGraph/Twitter social cards, `robots.txt`, and `sitemap.xml`.
- ⚡ **Edge-Powered Speed**: Built on Cloudflare Workers + KV + Durable Objects + Pages for near-instant global response times.

---

### 💻 Terminal / CLI Usage

Download your pastes & files directly from any terminal without opening a browser:

#### 1. Download Everything as ZIP (Text + All Files)
```bash
# Linux / macOS
curl -fLO https://clip.foo.ng/z/<slug>.zip

# Windows (PowerShell / CMD)
curl.exe -fLO https://clip.foo.ng/z/<slug>.zip
```

#### 2. Print Raw Text to Terminal
```bash
# Linux / macOS
curl -sL https://clip.foo.ng/r/<slug>

# Windows (PowerShell / CMD)
curl.exe -sL https://clip.foo.ng/r/<slug>
```

#### 3. Download File Attachment
```bash
# Linux / macOS
curl -fLJO https://clip.foo.ng/f/<slug>

# Windows (PowerShell / CMD)
curl.exe -fLJO https://clip.foo.ng/f/<slug>
```

---

### 🛠️ Tech Stack

| Component | Technology |
| :--- | :--- |
| **Frontend** | React 18, TypeScript, Vite, Vanilla CSS (Pure Monochrome), Lucide Icons, Marked, KaTeX, Prism.js, fflate |
| **Backend API** | Cloudflare Workers, Hono.js, Cloudflare KV Storage, fflate (zip generation) |
| **Real-Time Engine** | Cloudflare Durable Objects (SQLite-backed WebSocket state synchronization) |
| **Hosting & CDN** | Cloudflare Pages + Custom Domain (`clip.foo.ng`) |
| **Search & SEO** | Schema.org JSON-LD (WebApplication & FAQPage), XML Sitemap, Robots.txt, OpenGraph |

---

### 🚀 Local Development

Run both the frontend and backend locally with just two commands from the root workspace directory:

```bash
# 1. Install all dependencies (installs root, frontend, and worker dependencies automatically)
npm install

# 2. Run both Vite frontend and Wrangler worker concurrently
npm run dev
```

For a detailed breakdown of the codebase architecture, environment setup, and contribution guidelines, please refer to the [CONTRIBUTING.md](CONTRIBUTING.md) guide.  
For a full history of bug fixes and architectural updates, see [docs/CHANGELOG.md](docs/CHANGELOG.md).

---

### 🧪 Automated Testing

Clip includes an end-to-end automated test suite covering crypto, file uploads, expiration, CLI curl generation, and real-time live sync:

```bash
npm test
```

---

### 📡 1-Command Deployment

Deploy both the Cloudflare Worker API and Frontend Pages build in a single step from the root directory:

```bash
npm run deploy
```

* Deploy worker only: `npm run deploy:worker`
* Deploy frontend only: `npm run deploy:frontend`

---

### 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
