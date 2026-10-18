import { useEffect, useRef } from 'react'
import { gsap } from 'gsap'

// Two static glow images on the left/right edges, brought to life with GSAP.
export default function HeroCubes() {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let onMove: ((e: PointerEvent) => void) | null = null

    const ctx = gsap.context(() => {
      // Entrance: slide in from beyond the edges while fading and de-blurring
      gsap.from('.glow-img-l', { xPercent: -60, yPercent: 25, rotation: -8, opacity: 0, filter: 'blur(24px)', duration: 2.2, ease: 'expo.out', delay: 0.2 })
      gsap.from('.glow-img-r', { xPercent: 60, yPercent: -25, rotation: 8, opacity: 0, filter: 'blur(24px)', duration: 2.2, ease: 'expo.out', delay: 0.45 })

      // Idle drift once settled
      gsap.to('.glow-img-l', { y: -18, duration: 5.5, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: 2.6 })
      gsap.to('.glow-img-r', { y: 20, duration: 6.5, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: 2.8 })

      // Mouse parallax
      const lx = gsap.quickTo('.glow-img-l', 'x', { duration: 1.2, ease: 'power3.out' })
      const rx = gsap.quickTo('.glow-img-r', 'x', { duration: 1.2, ease: 'power3.out' })
      onMove = (e: PointerEvent) => {
        const nx = e.clientX / window.innerWidth - 0.5
        lx(nx * 36)
        rx(nx * -36)
      }
      window.addEventListener('pointermove', onMove)
    }, root)

    return () => {
      if (onMove) window.removeEventListener('pointermove', onMove)
      ctx.revert()
    }
  }, [])

  return (
    <div ref={rootRef} className="hero-glows" aria-hidden="true">
      <img className="glow-img glow-img-l" src="/hero-left.webp" alt="" />
      <img className="glow-img glow-img-r" src="/hero-right.webp" alt="" />
    </div>
  )
}

