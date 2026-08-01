import { Link } from 'react-router-dom'
import cLogo from '../assets/C.png'

interface Props {
  size?: 'sm' | 'md' | 'lg'
  linkable?: boolean
}

export default function Logo({ size = 'lg', linkable = true }: Props) {
  const isSm = size === 'sm'
  const isMd = size === 'md'

  const iconSize = isSm ? 22 : isMd ? 30 : 42
  const fontSize = isSm ? '1.35rem' : isMd ? '2rem' : '2.75rem'

  const content = (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: isSm ? '0.05rem' : '0.1rem', userSelect: 'none' }}>
      <img
        src={cLogo}
        alt="C"
        width={iconSize}
        height={iconSize}
        style={{ display: 'block', objectFit: 'contain' }}
      />
      <span style={{ fontSize, fontWeight: 800, letterSpacing: '-0.03em', color: '#ffffff', lineHeight: 1 }}>
        lip
      </span>
    </div>
  )

  if (linkable) {
    return (
      <Link to="/" style={{ textDecoration: 'none' }}>
        {content}
      </Link>
    )
  }

  return content
}
