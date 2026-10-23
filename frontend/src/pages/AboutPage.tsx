import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Lenis from 'lenis'
import Logo from '../components/Logo'
import HeroCubes from '../components/HeroCubes'
import LandingSections from '../components/LandingSections'
import { useSeo } from '../lib/useSeo'
import '../styles/landing.css'
import '../styles/landing-sections.css'

export default function AboutPage() {
  useSeo({
    title: 'Clip - Share text and files in seconds',
    description: 'Temporary text and file sharing with custom links, optional encryption and a real-time live pad. No account needed.',
    canonicalUrl: 'https://clip.foo.ng/about',
  })

  const rootRef = useRef<HTMLDivElement>(null)

  // Smooth, eased scrolling for the wheel and for the nav links. Skipped when the visitor asks for less motion.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const lenis = new Lenis({ duration: 1.15 })
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="#"]')
      const target = link ? document.querySelector<HTMLElement>(link.getAttribute('href') ?? '') : null
      if (!link || !target) return
      e.preventDefault()
      lenis.scrollTo(target.getBoundingClientRect().top + window.scrollY - 72, { duration: 1.4 })
      history.replaceState(null, '', link.getAttribute('href'))
    }
    document.addEventListener('click', onClick)
    lenis.on('scroll', ScrollTrigger.update)
    const tick = (time: number) => lenis.raf(time * 1000)
    gsap.ticker.add(tick)
    gsap.ticker.lagSmoothing(0)
    return () => {
      document.removeEventListener('click', onClick)
      gsap.ticker.remove(tick)
      lenis.destroy()
    }
  }, [])

  useEffect(() => {
    const ctx = gsap.context(() => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        gsap.set('.lp-reveal, .lp-nav', { opacity: 1, y: 0 })
        return
      }
      gsap.from('.lp-nav', { y: -40, opacity: 0, duration: 1.1, ease: 'expo.out', delay: 0.1 })
      gsap.from('.lp-reveal', {
        y: 36,
        opacity: 0,
        filter: 'blur(10px)',
        clearProps: 'filter,transform,opacity',
        duration: 1.2,
        ease: 'expo.out',
        stagger: 0.12,
        delay: 0.05,
      })
    }, rootRef)
    return () => ctx.revert()
  }, [])

  return (
    <div ref={rootRef} className="lp-page">
    <div className="lp">
      <HeroCubes />

      <nav className="lp-nav" aria-label="Main">
        <Link to="/about" className="lp-brand"><Logo size="sm" linkable={false} /></Link>
        <a href="#features">Features</a>
        <a href="#beam">Beam</a>
        <a href="#faq">FAQ</a>
        <Link to="/live">Live Pad</Link>
        <a href="https://github.com/WillyEverGreen/clip" target="_blank" rel="noreferrer">GitHub</a>
        <Link to="/" className="lp-nav-cta">Open app</Link>
      </nav>

      <header className="lp-hero">
        <h1 className="lp-reveal">
          Your text. Your files.
          <br />
          <span>One instant link.</span>
        </h1>
        <p className="lp-reveal">
          Paste a snippet, drop a file, get a shareable link in seconds. Lock it with a password,
          set it to expire, or open a live pad and type together in real time.
        </p>
        <div className="lp-reveal lp-actions">
          <Link to="/" className="lp-btn lp-btn-primary">Create a clip</Link>
          <Link to="/live" className="lp-btn lp-btn-ghost">Start a live pad</Link>
        </div>
      </header>
    </div>
    <LandingSections />
    </div>
  )
}
