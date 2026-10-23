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
const faq = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../frontend/src/lib/faq.json'), 'utf8'))
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const ldScript = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`
// The home page carries WebApplication and FAQPage markup that describes the home page; other routes get their own.
const stripPageLd = (html) => html.replace(/<script type="application\/ld\+json">[^]*?<\/script>\s*/g, (m) => (/"@type": "(?:WebApplication|FAQPage)"/.test(m) ? '' : m))

const routes = [
  {
    path: 'about',
    canonical: 'https://clip.foo.ng/about',
    title: 'About Clip - Free File Sharing, Encrypted Pastebin & Features',
    description: 'Learn how Clip gives you instant file sharing with no account, optional browser-side encryption, a collaborative live pad, and peer-to-peer file transfer.',
    keywords: 'about clip, file sharing features, encrypted pastebin, zero-account upload, anonymous share, webrtc file transfer',
    heading: 'About Clip - Free File Sharing, Encrypted Pastebin & Live Sync',
    ld: () => [
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      },
    ],
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
            <li><strong>Optional Client-Side Encryption:</strong> Add a password and notes and files are encrypted in your browser with AES-GCM 256-bit before they reach the server.</li>
            <li><strong>Peer-to-Peer Beam Transfer:</strong> WebRTC browser-to-browser streaming for large files, with nothing uploaded to a server.</li>
            <li><strong>Real-Time Collaborative Pad:</strong> Operational Transformation (OT) powered Live Pad enables simultaneous typing and file drops.</li>
            <li><strong>Global Edge Performance:</strong> Powered by Cloudflare Edge for sub-50ms response times worldwide.</li>
          </ul>
        </section>
        <section>
          <h2>Questions</h2>
          ${faq.map((f) => `<details><summary><strong>${esc(f.q)}</strong></summary><p>${esc(f.a)}</p></details>`).join('\n          ')}
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
    description: 'Send large files straight from one browser to another over an encrypted peer-to-peer connection. Nothing is uploaded, no account needed. Free, with resume.',
    keywords: 'p2p file transfer, browser to browser file transfer, send large files free, webrtc file sharing, share files without upload, wetransfer alternative, snapdrop alternative, pairdrop alternative',
    heading: 'Clip Beam - Direct Browser-to-Browser File Transfer',
    ld: () => [
      {
        '@context': 'https://schema.org',
        '@type': 'WebApplication',
        name: 'Clip Beam',
        url: 'https://clip.foo.ng/beam',
        applicationCategory: 'UtilitiesApplication',
        operatingSystem: 'Any modern browser',
        description: 'Send large files from one browser to another over an encrypted peer-to-peer WebRTC connection. Nothing is uploaded and no account is needed.',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        isPartOf: { '@type': 'WebSite', name: 'Clip', url: 'https://clip.foo.ng/' },
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Clip', item: 'https://clip.foo.ng/' },
          { '@type': 'ListItem', position: 2, name: 'Clip Beam', item: 'https://clip.foo.ng/beam' },
        ],
      },
    ],
    fallbackHtml: `
      <header style="max-width:800px;margin:2rem auto;padding:0 1rem;font-family:system-ui,-apple-system,sans-serif;color:#e2e8f0;line-height:1.6">
        <h1>Clip Beam - Peer-to-Peer Browser File Transfer</h1>
        <p>Send large files straight from your device to another browser over an encrypted direct WebRTC connection. Nothing is uploaded to a cloud server and no account is needed. Both people keep their tabs open until it finishes.</p>
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
            <li><strong>Nothing uploaded:</strong> Data streams directly between the sender and receiver browsers and is not stored on a server.</li>
            <li><strong>PIN, link or nearby radar:</strong> Pair with a 6-digit PIN, a link, or pick people on the same network. Send to several receivers at once.</li>
            <li><strong>Encrypted in transit:</strong> The browsers talk over WebRTC, which encrypts the connection with DTLS.</li>
            <li><strong>Checked and resumable:</strong> Every file is verified with SHA-256, and a dropped connection picks up where it stopped.</li>
            <li><strong>Big files:</strong> Chrome and Edge save straight to disk, so multi-gigabyte files work. Firefox and Safari handle up to about 2 GB.</li>
          </ul>
        </section>
      </main>
    `,
  },
]

for (const route of routes) {

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

  // The landing page's hero images are its largest paint: start them with the document
  if (route.path === 'about') {
    const preload = ['/hero-left.webp', '/hero-right.webp'].map((href) => `<link rel="preload" as="image" href="${href}" fetchpriority="high" />`).join('\n    ')
    html = html.replace('</head>', `${preload}\n  </head>`)
  }

  // Structured data that belongs to this page, not the home page
  html = stripPageLd(html)
  if (route.ld) html = html.replace('</head>', `${route.ld().map(ldScript).join('\n')}\n  </head>`)

  // Replace #root fallback content
  html = html.replace(/<div id="root">[\s\S]*?<\/div>/, `<div id="root">${route.fallbackHtml}</div>`)

  // beam.html rather than beam/index.html: Pages serves it at /beam, whereas a folder index redirects /beam to /beam/
  const outPath = path.join(distDir, `${route.path}.html`)
  fs.writeFileSync(outPath, html, 'utf8')
  console.log(`[SEO Generator] Generated ${outPath} (canonical: ${route.canonical})`)
}

console.log('[SEO Generator] All pre-rendered landing pages generated successfully!')
