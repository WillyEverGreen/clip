import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const distDir = path.resolve(__dirname, '../frontend/dist')
const templatePath = path.join(distDir, 'index.html')

if (!fs.existsSync(templatePath)) {
  console.error(`[SEO Generator] Error: ${templatePath} not found. Run vite build first.`)
  process.exit(1)
}

const template = fs.readFileSync(templatePath, 'utf8')

const routes = [
  {
    path: 'about',
    canonical: 'https://clip.foo.ng/about',
    title: 'About Clip - Free File Sharing, Encrypted Pastebin & Features',
    description: 'Learn how Clip provides instant anonymous file sharing, client-side AES-256 encryption, collaborative live pads, and peer-to-peer file transfers.',
    keywords: 'about clip, file sharing features, encrypted pastebin, zero-account upload, anonymous share, webrtc file transfer',
    heading: 'About Clip - Free File Sharing, Encrypted Pastebin & Live Sync',
    fallbackHtml: `
      <header style="max-width:800px;margin:2rem auto;padding:0 1rem;font-family:system-ui,-apple-system,sans-serif;color:#e2e8f0;line-height:1.6">
        <h1>About Clip - Free File Sharing &amp; Text Sharing</h1>
        <p>Clip is a modern, privacy-first file and text sharing platform built on Cloudflare Workers and WebRTC. We believe sharing files and code should require zero signups, zero tracking, and zero friction.</p>
        <nav style="display:flex;gap:1rem;margin:1.5rem 0">
          <a href="/" style="color:#38bdf8;text-decoration:none">Create Share</a>
          <a href="/live" style="color:#38bdf8;text-decoration:none">Live Pad</a>
          <a href="/beam" style="color:#38bdf8;text-decoration:none">Clip Beam (P2P Transfer)</a>
        </nav>
      </header>
      <main style="max-width:800px;margin:0 auto 2rem;padding:0 1rem;font-family:system-ui,-apple-system,sans-serif;color:#cbd5e1;line-height:1.6">
        <section>
          <h2>Platform Architecture &amp; Capabilities</h2>
          <ul>
            <li><strong>Zero Registration:</strong> Generate instant shareable links for texts, snippets, and files with zero account setup.</li>
            <li><strong>Client-Side Encryption:</strong> Client-side AES-GCM 256-bit encryption ensures files and notes remain private before hitting servers.</li>
            <li><strong>Peer-to-Peer Beam Transfer:</strong> WebRTC browser-to-browser streaming bypasses cloud file size caps for direct device transfers.</li>
            <li><strong>Real-Time Collaborative Pad:</strong> Operational Transformation (OT) powered Live Pad enables simultaneous typing and file drops.</li>
            <li><strong>Global Edge Performance:</strong> Powered by Cloudflare Edge for sub-50ms response times worldwide.</li>
          </ul>
        </section>
      </main>
    `,
  },
  {
    path: 'live',
    canonical: 'https://clip.foo.ng/live',
    title: 'Live Pad - Real-Time Collaborative Notepad & File Sync | Clip',
    description: 'Instant collaborative notepad and live room. Type, edit markdown, and drop files with real-time WebSocket synchronization across all devices.',
    keywords: 'live pad, real-time notepad, collaborative markdown, instant sync, phone pair, live file drop, online collaborative editor',
    heading: 'Live Pad - Real-Time Collaborative Notepad &amp; Instant Sync',
    fallbackHtml: `
      <header style="max-width:800px;margin:2rem auto;padding:0 1rem;font-family:system-ui,-apple-system,sans-serif;color:#e2e8f0;line-height:1.6">
        <h1>Live Pad - Real-Time Collaborative Notepad &amp; File Sync</h1>
        <p>Live Pad allows multiple users and devices to collaborate in real time. Type notes, format markdown, and drop files into a shared live room with instant sub-second synchronization.</p>
        <nav style="display:flex;gap:1rem;margin:1.5rem 0">
          <a href="/" style="color:#38bdf8;text-decoration:none">Create Share</a>
          <a href="/beam" style="color:#38bdf8;text-decoration:none">Clip Beam (P2P Transfer)</a>
          <a href="/about" style="color:#38bdf8;text-decoration:none">About Clip</a>
        </nav>
      </header>
      <main style="max-width:800px;margin:0 auto 2rem;padding:0 1rem;font-family:system-ui,-apple-system,sans-serif;color:#cbd5e1;line-height:1.6">
        <section>
          <h2>Live Pad Highlights</h2>
          <ul>
            <li><strong>Conflict-Free Real-Time Sync:</strong> Powered by Cloudflare Durable Objects and Operational Transformation.</li>
            <li><strong>Phone Pair QR Code:</strong> Scan the on-screen QR code with your mobile phone to instantly sync between phone and computer.</li>
            <li><strong>Multi-File Live Staging:</strong> Drop files straight into the pad to share them instantly across active peers.</li>
            <li><strong>Markdown Preview:</strong> Live split preview with LaTeX math, syntax highlighting, and GFM tables.</li>
          </ul>
        </section>
      </main>
    `,
  },
  {
    path: 'beam',
    canonical: 'https://clip.foo.ng/beam',
    title: 'Clip Beam - Peer-to-Peer Browser File Transfer',
    description: 'Send files of any size straight from browser to browser over an encrypted peer-to-peer connection with zero upload limits. Powered by Clip.',
    keywords: 'p2p file transfer, browser to browser, webrtc file beam, send big files free, direct file sharing, wormhole alternative',
    heading: 'Clip Beam - Direct Browser-to-Browser File Transfer',
    fallbackHtml: `
      <header style="max-width:800px;margin:2rem auto;padding:0 1rem;font-family:system-ui,-apple-system,sans-serif;color:#e2e8f0;line-height:1.6">
        <h1>Clip Beam - Peer-to-Peer Browser File Transfer</h1>
        <p>Send gigabytes of files straight from your device to another browser over an encrypted direct WebRTC channel. Nothing is uploaded to a cloud server, and there are no file size limits.</p>
        <nav style="display:flex;gap:1rem;margin:1.5rem 0">
          <a href="/" style="color:#38bdf8;text-decoration:none">Create Share</a>
          <a href="/live" style="color:#38bdf8;text-decoration:none">Live Pad</a>
          <a href="/about" style="color:#38bdf8;text-decoration:none">About Clip</a>
        </nav>
      </header>
      <main style="max-width:800px;margin:0 auto 2rem;padding:0 1rem;font-family:system-ui,-apple-system,sans-serif;color:#cbd5e1;line-height:1.6">
        <section>
          <h2>Why Use Clip Beam?</h2>
          <ul>
            <li><strong>Zero Cloud Upload:</strong> Data streams directly between sender and receiver browsers with zero intermediate storage.</li>
            <li><strong>6-Digit PIN Pairing:</strong> Simple 6-digit room PIN or 1-click shareable link to connect sender and receiver.</li>
            <li><strong>End-to-End Encrypted:</strong> Native DTLS/SCTP WebRTC protocol encryption for bulletproof transfer security.</li>
            <li><strong>Chunk-Level Verification &amp; Resume:</strong> Built-in SHA-256 chunk integrity verification and automatic transfer resumption.</li>
          </ul>
        </section>
      </main>
    `,
  },
]

for (const route of routes) {
  const routeDir = path.join(distDir, route.path)
  fs.mkdirSync(routeDir, { recursive: true })

  let html = template

  // Replace Title
  html = html.replace(/<title>.*?<\/title>/s, `<title>${route.title}</title>`)

  // Replace Canonical Tag
  html = html.replace(/<link rel="canonical" href=".*?" \/>/, `<link rel="canonical" href="${route.canonical}" />`)

  // Replace Meta Description
  html = html.replace(/<meta name="description" content=".*?" \/>/, `<meta name="description" content="${route.description}" />`)

  // Replace Keywords if present
  if (route.keywords) {
    html = html.replace(/<meta name="keywords" content=".*?" \/>/, `<meta name="keywords" content="${route.keywords}" />`)
  }

  // Replace OpenGraph tags
  html = html.replace(/<meta property="og:title" content=".*?" \/>/, `<meta property="og:title" content="${route.title}" />`)
  html = html.replace(/<meta property="og:description" content=".*?" \/>/, `<meta property="og:description" content="${route.description}" />`)
  html = html.replace(/<meta property="og:url" content=".*?" \/>/, `<meta property="og:url" content="${route.canonical}" />`)

  // Replace Twitter tags
  html = html.replace(/<meta name="twitter:title" content=".*?" \/>/, `<meta name="twitter:title" content="${route.title}" />`)
  html = html.replace(/<meta name="twitter:description" content=".*?" \/>/, `<meta name="twitter:description" content="${route.description}" />`)
  html = html.replace(/<meta name="twitter:url" content=".*?" \/>/, `<meta name="twitter:url" content="${route.canonical}" />`)

  // Replace #root fallback content
  html = html.replace(/<div id="root">[\s\S]*?<\/div>/, `<div id="root">${route.fallbackHtml}</div>`)

  const outPath = path.join(routeDir, 'index.html')
  fs.writeFileSync(outPath, html, 'utf8')
  console.log(`[SEO Generator] Generated ${outPath} (canonical: ${route.canonical})`)
}

console.log('[SEO Generator] All pre-rendered landing pages generated successfully!')
