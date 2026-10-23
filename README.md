<div align="center">

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg" />
    <img src="docs/logo-light.svg" width="260" alt="Clip" />
  </picture>
</p>

**Temporary text and file sharing with custom links, optional encryption and a live pad.**

<a href="https://clip.foo.ng"><img src="https://img.shields.io/badge/Live_Demo-Open_the_app-2ea44f?style=for-the-badge" alt="Live demo" /></a>

<br/>

<img src="docs/screenshot.png" width="860" alt="Clip screenshot" />

</div>

---

### 💡 Why Clip was built

> *"I created Clip because I was tired of having to log into WhatsApp Web or cloud drives on college library and lab PCs every single time I needed to quickly transfer a code snippet, link, or document to myself or a classmate."*

**Clip** solves this exact problem: a friction-free, lightweight web utility to create temporary, shareable links for text, markdown, and files in seconds - without leaving personal accounts signed in on public computers.

---

### ⭐ Key Features

- 🚀 **Zero Friction, No Sign-up**: Open the site, paste text or drop files, and get a link in seconds. No account, email, or credentials.
- 📡 **Clip Beam (`/beam`), files of any size, browser to browser**: Send multi-gigabyte files straight from your disk to someone else's over an encrypted WebRTC connection. Nothing is uploaded or stored.
  - **Send to up to 8 people at once**, each with their own progress, speed, and a live time-left countdown.
  - **Nearby radar**: people on your network who switch on Receive mode appear as avatars with cute names. Tap one or several, and they just tap Accept. No PIN needed (a 6-digit PIN and QR code still work). Receive mode is off by default, and they can Decline or Block.
  - **Reconnect and resume**: if the connection drops, press Reconnect (or let it retry by itself) and the transfer continues from where it stopped, even after a reload in Chrome and Edge.
  - **Verified**: SHA-256 is checked on both ends, and a damaged transfer is caught instead of saved.
- ⚡ **Real-Time Live Pad (`/live/:slug`)**: Collaborative notepad and live file room with instant WebSocket sync (Cloudflare Durable Objects). Several people can type together with multi-cursor and random cute names like *Mochi* or *Biscuit*, without overwriting each other.
- 🔒 **Zero-Knowledge Encryption**: Browser-side **PBKDF2 + AES-256-GCM** for pastes, files, edits, and live rooms. The server never sees your password or plaintext.
- 🕒 **Flexible Expiry**: `10 Minutes`, `1 Hour`, `6 Hours` *(Default)*, `1 Day`, `7 Days`, `30 Days`, or `Permanent` for text (attached files auto-purge after 48h).
- 💻 **Terminal / CLI**: Fetch pastes and files from Linux, macOS, or Windows with simple `curl` commands, plus a 1-command ZIP download.
- ⚡ **Edge-Powered**: Cloudflare Workers + KV + Durable Objects + Pages for fast global responses.

### ➕ More Features

- 🖱️ **Multi-Cursor Editing**: Opt in to see everyone's caret in a Live Pad (operational transform, tested with randomized multi-client simulations). Off by default.
- 🎬 **Universal Media & Document Viewer**: Full-screen theater viewer for both LivePad and URL pastes. Cinematic video player, high-res image lightbox with 25%-500% zoom and pan, line-numbered syntax-highlighted code with search and copy, and embedded PDF / audio playback.
- 🗜️ **Client-Side ZIP Archive Inspector**: Click any attached `.zip` to explore its folders and files, search inside it, and extract single files without downloading the whole archive.
- 📦 **1-Command ZIP Download**: Retrieve text (`<slug>.txt`) and all attached files as one ZIP, decrypted on the fly when encrypted.
- 📱 **Phone Pair via QR Code**: Connect your phone to a Live Pad or a Beam in one second by scanning a QR code.
- 📋 **Clipboard & Drag-and-Drop**: Paste screenshots straight from your clipboard (<kbd>Ctrl+V</kbd> / <kbd>Cmd+V</kbd>) or drag and drop files up to 25 MB (use Beam for bigger ones).
- 🔑 **Secret Edit Code**: Protect a link with a custom edit password to modify content, add or remove files, or delete early.
- 🔗 **Custom & Retained Slugs**: Pick your own readable slug (`clip.foo.ng/my-notes`) or convert a live room into a permanent clip with the same slug.
- 📁 **Rich Markdown & KaTeX Math**: GitHub Flavored Markdown, task lists, tables, and KaTeX typesetting (LaTeX, matrices, piecewise functions, integrals).
- 🔤 **Developer Typography & Code Blocks**: Syntax highlighting for 40+ languages with JetBrains Mono / Fira Code and 1-click Copy buttons.
- 🛡️ **Admin Live Pad & Expiration Monitor**: Admin section to track active Live Pad rooms, 24-hour rolling expiry countdowns, connected peers, and to terminate rooms.
- 🖥️ **Zero-Scroll Viewport Layout**: The desktop workspace fits 100% of the viewport height and collapses into mobile tabs on narrow screens.
- 🎨 **Pure Monochrome Look**: Solid black (`#000000`) and pure white with Lucide icons.
- 🌐 **SEO & Rich Snippets**: Schema.org `WebApplication` and `FAQPage` snippets, OpenGraph / Twitter cards, `robots.txt`, and `sitemap.xml`.

---

### 📡 Using Clip Beam

Open `/beam` (for example `https://clip.foo.ng/beam`) in Chrome or Edge on both devices.

1. **Send**: drop a file. You get a radar of people nearby, and a 6-digit PIN with a QR code underneath.
2. **Receive, with the radar**: switch on **Show me to nearby senders**. When someone picks you, tap **Accept** (or **Decline** / **Block**) and choose where to save. No PIN.
3. **Receive, with a PIN**: type the sender's PIN (or scan the QR code) and tap **Accept and save**.
4. **If the connection drops**: press **Reconnect** (it also retries by itself). It continues from where it stopped, and the sender keeps their page open. After a reload, `/beam` lists **Unfinished transfers** you can continue (Chrome and Edge).

Good to know: the file goes straight between the two browsers and is never stored on Clip's servers. One sender can send to up to 8 people at once. Chrome and Edge save straight to disk with no size limit; Firefox and Safari keep the file in memory (up to 2 GB) and can only resume while the page stays open. Both devices need a direct connection (same Wi-Fi works best); very strict networks may need a relay, which is not built yet. Full design: [docs/CLIP_BEAM_ARCHITECTURE.md](docs/CLIP_BEAM_ARCHITECTURE.md).

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
| **Real-Time Engine** | Cloudflare Durable Objects (SQLite-backed): `ClipRoom` for Live Pad sync, `BeamRoom` for Beam connection setup, `BeamLobby` for the nearby radar |
| **Clip Beam** | WebRTC data channels (peer to peer), File System Access API, IndexedDB (resume), `hash-wasm` (SHA-256) |
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
For how Clip Beam works (rooms, radar, resume, tests), see [docs/CLIP_BEAM_ARCHITECTURE.md](docs/CLIP_BEAM_ARCHITECTURE.md). The wider large-file plan is in [docs/HYBRID_LARGE_FILE_TRANSFER_SPEC.md](docs/HYBRID_LARGE_FILE_TRANSFER_SPEC.md).  
For a full history of bug fixes and architectural updates, see [docs/CHANGELOG.md](docs/CHANGELOG.md).

---

### 🧪 Automated Testing

Clip includes automated tests for crypto, uploads, expiration, CLI generation, live sync, and Clip Beam (room and radar logic, speed and time-left maths, a real worker, and real Chrome pages sending files to each other, including dropped connections):

```bash
npm test                 # unit tests, nothing needs to be running
npm run test:beam        # all Clip Beam tests (needs the worker and site running locally)
npm run test:all         # everything
```

See [docs/TESTING.md](docs/TESTING.md) for what each suite covers and how to run the ones that need the worker and site.

---

### 📡 1-Command Deployment

Deploy both the Cloudflare Worker API and Frontend Pages build in a single step from the root directory:

```bash
npm run deploy
```

* Deploy worker only: `npm run deploy:worker`
* Deploy frontend only: `npm run deploy:frontend`
* The first deploy that includes Clip Beam also creates the `BeamRoom` and `BeamLobby` Durable Objects (migrations `v2` and `v3`); nothing else needs configuring.
* Run it from the `main` branch: Cloudflare Pages only treats `main` as production, and any other branch is published as a preview.

---

### 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

