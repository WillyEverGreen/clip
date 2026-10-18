import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import type { CursorStore, RemoteCursor } from '../lib/cursorStore'
import { colorForId } from '../lib/cuteNames'
import '../styles/live-cursors.css'

/** Above this size, measuring carets would stall typing, so they are simply not drawn. */
const MAX_RENDER_CHARS = 300_000
/** Carets glide for ~120ms anyway, so re-measuring more often than this buys nothing. */
const MEASURE_INTERVAL_MS = 100
/** How far past a caret we lay out text, so a word that wraps in the real textarea wraps here too. */
const WORD_TAIL_CHARS = 200

// Text-layout properties copied onto the measuring mirror so it wraps exactly like the textarea
const MIRROR_PROPS = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
  'wordSpacing', 'textIndent', 'textTransform', 'tabSize',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
] as const

interface Placed extends RemoteCursor {
  x: number
  y: number
}

interface Box {
  left: number
  top: number
  width: number
  height: number
  lineHeight: number
}

interface OverlayProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  text: string
  store: CursorStore
}

function samePlacement(a: readonly Placed[], b: readonly Placed[]): boolean {
  if (a.length !== b.length) return false
  return a.every((p, i) => {
    const q = b[i]!
    return p.id === q.id && p.name === q.name && p.x === q.x && p.y === q.y
  })
}

function sameBox(a: Box | null, b: Box): boolean {
  return !!a && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height && a.lineHeight === b.lineHeight
}

// Draws other people's carets on top of the textarea, kept in place while it scrolls.
export function RemoteCursorsOverlay({ textareaRef, text, store }: OverlayProps) {
  const { others } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const holderRef = useRef<HTMLDivElement>(null)
  const mirrorRef = useRef<HTMLDivElement | null>(null)
  const [placed, setPlaced] = useState<Placed[]>([])
  const [box, setBox] = useState<Box | null>(null)
  const [scroll, setScroll] = useState({ x: 0, y: 0 })
  const [layoutTick, setLayoutTick] = useState(0)

  // The throttled measurer always reads the newest inputs from here
  const latest = useRef({ text, others })
  latest.current = { text, others }
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastMeasureRef = useRef(0)

  // Follow the textarea's scrolling and any size change (which rewraps the text)
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    const onScroll = () => setScroll({ x: ta.scrollLeft, y: ta.scrollTop })
    ta.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(() => setLayoutTick(t => t + 1))
    ro.observe(ta)
    return () => {
      ta.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [textareaRef])

  // Find every caret's pixel position with ONE layout pass: the text before the first caret, then one
  // span per distinct caret index holding the text up to the next one. A span starts exactly where
  // its caret is, and only text up to the last caret (plus the rest of its word) is laid out.
  const measure = useCallback(() => {
    timerRef.current = null
    lastMeasureRef.current = performance.now()
    const ta = textareaRef.current
    const holder = holderRef.current
    const { text: t, others: cs } = latest.current
    if (!ta || !holder || cs.length === 0 || t.length > MAX_RENDER_CHARS || document.hidden) {
      setPlaced(prev => (prev.length === 0 ? prev : []))
      return
    }
    const cstyle = getComputedStyle(ta)
    let mirror = mirrorRef.current
    if (!mirror) {
      mirror = document.createElement('div')
      mirror.style.cssText = 'position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;'
        + 'white-space:pre-wrap;overflow-wrap:break-word;word-break:normal;box-sizing:border-box;border:0;'
      holder.appendChild(mirror)
      mirrorRef.current = mirror
    }
    for (const prop of MIRROR_PROPS) mirror.style[prop] = cstyle[prop]
    mirror.style.width = `${ta.clientWidth}px`
    mirror.textContent = ''

    const indexed = cs
      .map(c => ({ c, idx: Math.min(Math.max(c.end, 0), t.length) }))
      .sort((a, b) => a.idx - b.idx)
    const distinct = Array.from(new Set(indexed.map(i => i.idx)))

    mirror.appendChild(document.createTextNode(t.slice(0, distinct[0]!)))
    const spans = new Map<number, HTMLSpanElement>()
    distinct.forEach((idx, i) => {
      let end = distinct[i + 1]
      if (end === undefined) {
        // last caret: include the remainder of its word so wrapping matches the real textarea
        end = idx
        const limit = Math.min(t.length, idx + WORD_TAIL_CHARS)
        while (end < limit && !/\s/.test(t[end]!)) end++
      }
      const span = document.createElement('span')
      span.textContent = t.slice(idx, end) || '.'
      mirror!.appendChild(span)
      spans.set(idx, span)
    })

    const out: Placed[] = indexed.map(({ c, idx }) => {
      const span = spans.get(idx)!
      return { ...c, x: span.offsetLeft, y: span.offsetTop }
    })
    mirror.textContent = ''

    const lineHeight = parseFloat(cstyle.lineHeight) || parseFloat(cstyle.fontSize) * 1.4
    const nextBox: Box = {
      left: ta.offsetLeft + ta.clientLeft,
      top: ta.offsetTop + ta.clientTop,
      width: ta.clientWidth,
      height: ta.clientHeight,
      lineHeight,
    }
    setPlaced(prev => (samePlacement(prev, out) ? prev : out))
    setBox(prev => (sameBox(prev, nextBox) ? prev : nextBox))
  }, [textareaRef])

  // Whenever text, carets or size change, schedule at most one measurement per interval
  useEffect(() => {
    if (timerRef.current) return
    const wait = Math.max(0, MEASURE_INTERVAL_MS - (performance.now() - lastMeasureRef.current))
    timerRef.current = setTimeout(measure, wait)
  }, [text, others, layoutTick, measure])

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  return (
    <div ref={holderRef} className="lc-holder" aria-hidden="true">
      {box && placed.length > 0 && (
        <div className="lc-clip" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
          {placed.map(c => {
            const color = colorForId(c.id)
            const screenY = c.y - scroll.y
            return (
              <div
                key={c.id}
                className="lc-caret"
                style={{
                  transform: `translate(${c.x - scroll.x}px, ${screenY}px)`,
                  height: box.lineHeight,
                  background: color,
                }}
              >
                <span className={`lc-flag${screenY < 22 ? ' lc-flag--below' : ''}`} style={{ background: color }}>
                  {c.name}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Shows who you are in this pad (the name is fixed) and who else is here.
export function CursorBar({ store }: { store: CursorStore }) {
  const { me, others } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const shown = others.slice(0, 4)
  const extra = others.length - shown.length
  return (
    <div className="lc-controls">
      <span className="lc-you" title="This is the name others see next to your cursor">
        <i style={{ background: 'var(--text-muted)' }} />
        You: {me || '…'}
      </span>
      {shown.map(c => (
        <span key={c.id} className="lc-peer">
          <i style={{ background: colorForId(c.id) }} />
          {c.name}
        </span>
      ))}
      {extra > 0 && <span className="lc-peer">+{extra} more</span>}
    </div>
  )
}
