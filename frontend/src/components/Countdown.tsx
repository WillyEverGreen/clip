import { useState, useEffect, useRef } from 'react'

interface Props { expiresAt: number }

function pad(n: number) { return String(n).padStart(2, '0') }

export default function Countdown({ expiresAt }: Props) {
  const [remaining, setRemaining] = useState(Math.max(0, expiresAt - Date.now()))
  const ref = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    ref.current = setInterval(() => {
      const left = Math.max(0, expiresAt - Date.now())
      setRemaining(left)
      if (left === 0 && ref.current) clearInterval(ref.current)
    }, 1000)
    return () => { if (ref.current) clearInterval(ref.current) }
  }, [expiresAt])

  const hours   = Math.floor(remaining / 3_600_000)
  const minutes = Math.floor((remaining % 3_600_000) / 60_000)
  const seconds = Math.floor((remaining % 60_000) / 1_000)

  const expired = remaining === 0
  const color   = expired ? '#a1a1aa' : '#a1a1aa'

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8125rem', color, fontVariantNumeric: 'tabular-nums' }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <polyline points="12 6 12 12 16 14"/>
      </svg>
      {expired
        ? 'Expired'
        : `${pad(hours)}:${pad(minutes)}:${pad(seconds)} remaining`}
    </span>
  )
}
