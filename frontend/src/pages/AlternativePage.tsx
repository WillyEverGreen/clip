import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Plus } from 'lucide-react'
import Logo from '../components/Logo'
import { useSeo } from '../lib/useSeo'
import ALTERNATIVES from '../lib/alternatives.json'
import '../styles/landing.css'
import '../styles/landing-sections.css'
import '../styles/alternative.css'

export type AlternativeKind = 'snapdrop' | 'wetransfer'

function Faq({ items }: { items: { q: string; a: string }[] }) {
  const [open, setOpen] = useState<number | null>(0)
  return (
    <div className="sx-faq">
      {items.map((f, i) => (
        <div key={f.q} className={`sx-faq-item ${open === i ? 'is-open' : ''}`}>
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

export default function AlternativePage({ kind }: { kind: AlternativeKind }) {
  const data = ALTERNATIVES[kind]

  useSeo({
    title: data.seoTitle,
    description: data.description,
    canonicalUrl: data.canonical,
  })

  return (
    <div className="alt-page">
      <nav className="lp-nav" aria-label="Main">
        <Link to="/about" className="lp-brand"><Logo size="sm" linkable={false} /></Link>
        <Link to="/">App</Link>
        <Link to="/beam">Beam</Link>
        <Link to="/live">Live Pad</Link>
        <Link to="/about">About</Link>
        <Link to="/" className="lp-nav-cta">Open app</Link>
      </nav>

      <header className="alt-hero">
        <span className="sx-eyebrow">{data.eyebrow}</span>
        <h1>{data.h1}</h1>
        <p>{data.intro}</p>
        <div className="lp-actions">
          <Link to="/" className="lp-btn lp-btn-primary">Create a clip <ArrowRight size={16} /></Link>
          <Link to="/beam" className="lp-btn lp-btn-ghost">Open Clip Beam</Link>
        </div>
      </header>

      <section className="sx-section" id="compare">
        <div className="sx-head">
          <span className="sx-eyebrow">Side by side</span>
          <h2>How they <em>compare</em></h2>
          <p>Written to be useful rather than flattering: some rows favour Clip, and some favour the other tool.</p>
        </div>
        <div className="sx-compare-wrap">
          <table className="sx-compare-table">
            <thead>
              <tr>
                <th>Feature</th>
                <th className="sx-col-clip-head">{data.columns.clip}</th>
                <th>{data.columns.other}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.feature}>
                  <td>{row.feature}</td>
                  <td className="sx-col-clip"><span className="sx-cell-val">{row.clip}</span></td>
                  <td><span className="sx-cell-dim">{row.other}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="alt-crosslink">
          Also read <Link to={data.crossLink.path}>{data.crossLink.label}</Link>.
        </p>
      </section>

      <section className="sx-section sx-section-narrow">
        <div className="sx-head">
          <span className="sx-eyebrow">Straight answer</span>
          <h2>{data.whenOtherTitle}</h2>
        </div>
        <div className="alt-prose">
          <ul>
            {data.whenOther.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="sx-section sx-section-narrow" id="faq">
        <div className="sx-head">
          <span className="sx-eyebrow">FAQ</span>
          <h2>Questions, <em>answered.</em></h2>
        </div>
        <Faq items={data.faq} />
      </section>

      <section className="sx-cta">
        <div className="sx-cta-glow" />
        <h2>Share something in seconds.</h2>
        <p>No account, no upload queue, no email address.</p>
        <div className="lp-actions">
          <Link to="/" className="lp-btn lp-btn-primary">Create a clip <ArrowRight size={16} /></Link>
          <Link to="/beam" className="lp-btn lp-btn-ghost">Send with Beam</Link>
        </div>
      </section>

      <footer className="sx-footer">
        <div>
          <Link to="/about" className="lp-brand"><Logo size="sm" linkable={false} /></Link>
          <span>Temporary text and file sharing.</span>
        </div>
        <nav aria-label="Footer">
          <Link to="/">App</Link>
          <Link to="/beam">Beam</Link>
          <Link to="/about">About</Link>
          <Link to="/snapdrop-alternative">vs Snapdrop</Link>
          <Link to="/wetransfer-alternative">vs WeTransfer</Link>
        </nav>
      </footer>
    </div>
  )
}
