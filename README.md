<div align="center">

  <h1>clip</h1>

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
- 🕒 **Custom Expiration Timers**: Choose how long your link stays active: `10 Minutes`, `1 Hour`, `6 Hours` *(Default)*, `1 Day`, `7 Days`, or `30 Days`.
- 🔑 **Secret Edit Code**: Protect your links with a custom edit password to edit content or delete early.
- 🔗 **Custom URLs**: Pick your own readable slug (`clip.foo.ng/my-notes`).
- 📁 **File & Markdown Support**: Render rich formatted Markdown text and upload files alongside your snippets.
- 🌐 **Timezone-Aware Metadata**: Automatically formats publication & edit dates in the viewer's local timezone (e.g. `GMT+5:30`).
- ⚡ **Edge-Powered Speed**: Built on Cloudflare Workers + KV + Pages for near-instant global response times.

---

### 🛠️ Tech Stack

| Component | Technology |
| :--- | :--- |
| **Frontend** | React 18, TypeScript, Vite, Vanilla CSS (Monochrome Dark UI), Lucide Icons |
| **Backend** | Cloudflare Workers, Hono.js, Cloudflare KV Storage |
| **Hosting** | Cloudflare Pages + Custom Domain (`clip.foo.ng`) |

---

### 🚀 Local Development

```bash
# 1. Clone the repository
git clone https://github.com/WillyEverGreen/clip.git
cd clip

# 2. Install dependencies (Frontend & Worker)
cd frontend && npm install
cd ../worker && npm install
cd ..

# 3. Run Frontend Development Server
cd frontend
npm run dev
```

---

### 📡 1-Command Deployment

Deploy both the Cloudflare Worker API and Frontend Pages build in a single step from the root directory:

```bash
npm run deploy
```

---

### 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
