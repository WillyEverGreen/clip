import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { gsap } from 'gsap'
import Logo from './Logo'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import {
  Link2, Quote, Zap, Lock, Timer, FileUp, Terminal, ArrowRight, Plus, Check, Copy,
  ClipboardPaste, Share2, Flame, Code2, QrCode,
} from 'lucide-react'

import FAQ from '../lib/faq.json'

gsap.registerPlugin(ScrollTrigger)

const MARQUEE = [
  'Code snippets', 'Markdown notes', 'Screenshots', 'PDFs', 'ZIP archives', 'Passwords & keys',
  'Math with KaTeX', 'Voice notes', 'Meeting links', 'Lab files', 'Homework',
]

function Spotlight({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`)
    e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`)
  }
  return (
    <div className={`sx-card ${className}`} onPointerMove={onMove}>
      <div className="sx-card-glow" />
      {children}
    </div>
  )
}

function UrlMock() {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const slug = 'my-notes'
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = slug; return }
    const o = { n: 0 }
    const tw = gsap.to(o, {
      n: slug.length, duration: 1.6, ease: 'none', repeat: -1, repeatDelay: 2.2,
      onUpdate: () => { el.textContent = slug.slice(0, Math.round(o.n)) },
      scrollTrigger: { trigger: el, start: 'top 90%', toggleActions: 'play pause resume pause' },
    })
    return () => { tw.scrollTrigger?.kill(); tw.kill() }
  }, [])
  return (
    <div className="mock-url">
      <Link2 size={15} />
      <span className="mock-url-host">clip.foo.ng/</span>
      <span ref={ref} className="mock-url-slug" />
      <i className="mock-caret" />
      <span className="mock-url-btn"><Copy size={13} /> Copy</span>
    </div>
  )
}

function Ring() {
  return (
    <div className="mock-ring">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="42" className="ring-bg" />
        <circle cx="50" cy="50" r="42" className="ring-fg" />
      </svg>
      <div><b>06:00:00</b><span>until it vanishes</span></div>
    </div>
  )
}

function Faq() {
  const [open, setOpen] = useState<number | null>(0)
  return (
    <div className="sx-faq">
      {FAQ.map((f, i) => (
        <div key={f.q} className={`sx-faq-item sx-reveal ${open === i ? 'is-open' : ''}`}>
          <button onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
            {f.q}
            <Plus size={18} />
          </button>
          <div className="sx-faq-body"><p>{f.a}</p></div>
        </div>
      ))}
    </div>
  )
}

export default function LandingSections() {
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      root.current?.querySelectorAll<HTMLElement>('.sx-reveal').forEach(el => { el.style.opacity = '1' })
      return
    }
    const ctx = gsap.context(() => {
      gsap.utils.toArray<HTMLElement>('.sx-reveal').forEach(el => {
        gsap.from(el, {
          y: 40, opacity: 0, filter: 'blur(8px)', duration: 1, ease: 'expo.out', clearProps: 'filter,transform,opacity',
          scrollTrigger: { trigger: el, start: 'top 88%', once: true },
        })
      })
      gsap.from('.sx-step-line i', {
        scaleX: 0, transformOrigin: 'left center', duration: 1.6, ease: 'power3.inOut',
        scrollTrigger: { trigger: '.sx-steps', start: 'top 75%', once: true },
      })
      gsap.from('.mock-cursor', {
        scale: 0, opacity: 0, duration: 0.6, stagger: 0.25, ease: 'back.out(2)',
        scrollTrigger: { trigger: '.mock-pad', start: 'top 85%', once: true },
      })
      gsap.to('.mock-cursor-a', { x: 70, y: 16, duration: 3.2, yoyo: true, repeat: -1, ease: 'sine.inOut' })
      gsap.to('.mock-cursor-b', { x: -60, y: 26, duration: 3.8, yoyo: true, repeat: -1, ease: 'sine.inOut' })
      gsap.to('.sx-cta-glow', {
        scale: 1.12, opacity: 0.8, duration: 4, yoyo: true, repeat: -1, ease: 'sine.inOut',
      })
    }, root)
    return () => ctx.revert()
  }, [])

  return (
    <div className="sx" ref={root}>
      {/* ── Marquee ─────────────────────────────────────────────── */}
      <section className="sx-marquee" aria-label="What people share">
        <div className="sx-marquee-track">
          {[...MARQUEE, ...MARQUEE].map((m, i) => (
            <span key={i}><i /> {m}</span>
          ))}
        </div>
      </section>

      {/* ── Bento features ──────────────────────────────────────── */}
      <section className="sx-section" id="features">
        <div className="sx-head sx-reveal">
          <span className="sx-eyebrow">Features</span>
          <h2>Everything you need to move<br /><em>things between devices.</em></h2>
          <p>No installs, no logins, no clutter. Just the fast path from one screen to another.</p>
        </div>

        <div className="sx-bento">
          <Spotlight className="a-url sx-reveal">
            <div className="sx-ico"><Link2 size={18} /></div>
            <h3>Instant custom links</h3>
            <p>Pick a readable URL or let Clip generate one. Share it anywhere.</p>
            <UrlMock />
          </Spotlight>

          <Spotlight className="a-pad sx-reveal">
            <div className="sx-ico"><Zap size={18} /></div>
            <h3>Real-time Live Pad</h3>
            <p>A shared room that syncs as you type, with files and a QR to pair your phone.</p>
            <div className="mock-pad">
              <div className="mock-pad-bar"><i /><i /><i /><span>/live/study-group</span></div>
              <div className="mock-pad-body">
                <p><b>Lab 4 notes</b></p>
                <p>- tokens expire after 24h</p>
                <p>- upload the dataset here</p>
                <span className="mock-cursor mock-cursor-a"><em>Aarav</em></span>
                <span className="mock-cursor mock-cursor-b"><em>You</em></span>
              </div>
              <div className="mock-qr"><QrCode size={16} /> Scan to join</div>
            </div>
          </Spotlight>

          <Spotlight className="a-lock sx-reveal">
            <div className="sx-ico"><Lock size={18} /></div>
            <h3>Zero-knowledge encryption</h3>
            <p>PBKDF2 + AES-256-GCM in your browser. We never see your password.</p>
            <div className="mock-lock">
              <Lock size={16} />
              <span>••••••••••</span>
              <b>AES-256</b>
            </div>
          </Spotlight>

          <Spotlight className="a-ring sx-reveal">
            <div className="sx-ico"><Timer size={18} /></div>
            <h3>Self-destructing</h3>
            <p>From 10 minutes to 30 days, or keep it permanent.</p>
            <Ring />
          </Spotlight>

          <Spotlight className="a-files sx-reveal">
            <div className="sx-ico"><FileUp size={18} /></div>
            <h3>Files up to 25 MB</h3>
            <p>Drag, drop or paste a screenshot. Peek inside ZIPs without downloading.</p>
            <div className="mock-files">
              <span>report.pdf</span><span>diagram.png</span><span>dataset.zip</span>
            </div>
          </Spotlight>

          <Spotlight className="a-term sx-reveal">
            <div className="sx-ico"><Terminal size={18} /></div>
            <h3>Built for terminals too</h3>
            <p>Pull text, files or a full ZIP with a single command.</p>
            <pre className="mock-term"><code><span className="t-dim">$</span> curl -sL clip.foo.ng/r/<span className="t-hl">my-notes</span>{'\n'}<span className="t-dim">Lab 4 notes{'\n'}- tokens expire after 24h</span></code></pre>
          </Spotlight>
        </div>
      </section>

      {/* ── How it works ────────────────────────────────────────── */}
      <section className="sx-section" id="how">
        <div className="sx-head sx-reveal">
          <span className="sx-eyebrow">How it works</span>
          <h2>Three steps. <em>Under ten seconds.</em></h2>
        </div>
        <div className="sx-steps">
          <div className="sx-step-line"><i /></div>
          {[
            { i: ClipboardPaste, t: 'Paste or drop', d: 'Text, markdown, code, or any file. Ctrl+V works for screenshots.' },
            { i: Share2, t: 'Get your link', d: 'Custom slug, optional password and an expiry you control.' },
            { i: Flame, t: 'Open it anywhere', d: 'Any browser or terminal. When time is up, it is gone.' },
          ].map((s, n) => (
            <div className="sx-step sx-reveal" key={s.t}>
              <div className="sx-step-n"><s.i size={20} /><span>0{n + 1}</span></div>
              <h3>{s.t}</h3>
              <p>{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── FAQ ─────────────────────────────────────────────────── */}
      <section className="sx-section sx-section-narrow" id="faq">
        <div className="sx-head sx-reveal">
          <span className="sx-eyebrow">FAQ</span>
          <h2>Questions, <em>answered.</em></h2>
        </div>
        <Faq />
      </section>

      {/* ── CTA ─────────────────────────────────────────────────── */}
      <section className="sx-cta sx-reveal">
        <div className="sx-cta-glow" />
        <h2>Stop emailing yourself files.</h2>
        <p>Open Clip and have a link in the time it takes to read this sentence.</p>
        <div className="lp-actions">
          <Link to="/" className="lp-btn lp-btn-primary">Create a clip <ArrowRight size={16} /></Link>
          <Link to="/live" className="lp-btn lp-btn-ghost">Start a live pad</Link>
        </div>
        <span className="sx-cta-note"><Check size={14} /> Free · No account · Open source</span>
      </section>

      {/* ── Footer ──────────────────────────────────────────────── */}
      <footer className="sx-footer">
        <div>
          <Link to="/about" className="lp-brand"><Logo size="sm" linkable={false} /></Link>
          <span>Temporary text and file sharing.</span>
        </div>
        <nav aria-label="Footer">
          <Link to="/">App</Link>
          <Link to="/live">Live Pad</Link>
          <a href="https://github.com/WillyEverGreen/clip" target="_blank" rel="noreferrer"><Code2 size={15} /> GitHub</a>
          <a href="https://github.com/Chronos778/quotes_api" target="_blank" rel="noreferrer"><Quote size={15} /> Quotes API</a>
        </nav>
      </footer>
    </div>
  )
}
