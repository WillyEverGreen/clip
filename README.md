<div align="center">

  <a href="https://clip.foo.ng">
    <img src="frontend/public/clip-header.png" height="50" alt="clip" />
  </a>

  <p><b>Share text snippets &amp; files instantly - no accounts, no logging in on public PCs.</b></p>

  <p>
    <a href="https://clip.foo.ng"><b>🌐 Live Demo: clip.foo.ng</b></a>
  </p>

</div>

---

### 💡 Why Clip was built

> *"I created Clip because I was tired of having to log into WhatsApp Web on college library and lab PCs every single time I needed to quickly transfer a code snippet, link, or document to myself or a classmate."*

**Clip** solves this exact problem: a friction-free, lightweight web utility to create temporary, shareable links for text, markdown, and files in seconds - without leaving personal accounts signed in on public computers.

---

### ✨ Features

- 🚀 **Zero Friction & No Sign-up**: Open the site, paste your text or drag-and-drop a file, get your link. Done.
- 💻 **Terminal / CLI Downloads**: Download pastes and files straight from Linux or Windows terminals using simple `curl` commands.
- 🗜️ **1-Command ZIP Download**: Retrieve text (`<slug>.txt`) and all attached files combined into a single ZIP archive.
- 🕒 **Custom Expiration Timers**: Choose how long your link stays active: `10 Minutes`, `1 Hour`, `6 Hours` *(Default)*, `1 Day`, `7 Days`, or `30 Days`.
- 🔒 **Zero-Knowledge Password Lock**: Secure your text pastes and file uploads with browser-side **PBKDF2 + AES-256-GCM** encryption. The server never sees your password or plaintext data.
- 🔑 **Secret Edit Code**: Protect your links with a custom edit password to edit content or delete early.
- 🔗 **Custom URLs**: Pick your own readable slug (`clip.foo.ng/my-notes`).
- 📁 **File & Markdown Support**: Render rich formatted Markdown text and upload files alongside your snippets.
- 🌐 **Timezone-Aware Metadata**: Automatically formats publication & edit dates in the viewer's local timezone (e.g. `GMT+5:30`).
- ⚡ **Edge-Powered Speed**: Built on Cloudflare Workers + KV + Pages for near-instant global response times.

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
| **Frontend** | React 18, TypeScript, Vite, Vanilla CSS (Monochrome Dark UI), Lucide Icons |
| **Backend** | Cloudflare Workers, Hono.js, Cloudflare KV Storage, fflate (zip generation) |
| **Hosting** | Cloudflare Pages + Custom Domain (`clip.foo.ng`) |

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

---

### 📡 1-Command Deployment

Deploy both the Cloudflare Worker API and Frontend Pages build in a single step from the root directory:

```bash
npm run deploy
```

---

### 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
