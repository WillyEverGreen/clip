import { Link } from 'react-router-dom'
import { Link2Off, Plus } from 'lucide-react'

export default function ExpiredPage() {
  return (
    <div className="page-wrapper">
      <div className="animate-fade-up" style={{ textAlign:'center', maxWidth:'480px' }}>

        <div style={{ display:'inline-flex', alignItems:'center', justifyContent:'center', width:80, height:80, borderRadius:'50%', background:'#0a0a0a', border:'1px solid var(--border)', marginBottom:'1.5rem' }}>
          <Link2Off size={36} color="#a1a1aa" />
        </div>

        <h1 style={{ fontSize:'2rem', fontWeight:700, letterSpacing:'-0.025em', marginBottom:'0.75rem', color:'#ffffff' }}>
          Link not found
        </h1>
        <p style={{ color:'var(--text-muted)', fontSize:'0.9375rem', lineHeight:1.65, marginBottom:'2rem' }}>
          This link has expired or never existed.<br/>
          Links are active for <strong style={{color:'#ffffff'}}>6 hours</strong> after creation.
        </p>

        <Link to="/" className="btn btn-primary" style={{ padding:'0.875rem 2rem', fontSize:'1rem', gap:'0.5rem' }}>
          <Plus size={18} /> Create a new link
        </Link>

        <p style={{ marginTop:'1.5rem', fontSize:'0.8rem', color:'var(--text-dim)' }}>
          No account required · Completely free
        </p>
      </div>
    </div>
  )
}
