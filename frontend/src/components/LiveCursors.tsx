import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { MousePointer2, Shuffle } from 'lucide-react'
import type { RemoteCursor } from '../lib/useLiveSocket'
import { colorForId } from '../lib/cuteNames'
import '../styles/live-cursors.css'

/** Above this size, measuring carets would stall typing, so they are simply not drawn. */
const MAX_RENDER_CHARS = 300_000

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
  cursors: RemoteCursor[]
}

// Draws other people's carets on top of the textarea, kept in place while it scrolls.
export function RemoteCursorsOverlay({ textareaRef, text, cursors }: OverlayProps) {
  const holderRef = useRef<HTMLDivElement>(null)
  const [placed, setPlaced] = useState<Placed[]>([])
  const [box, setBox] = useState<Box | null>(null)
  const [scroll, setScroll] = useState({ x: 0, y: 0 })
  const [layoutTick, setLayoutTick] = useState(0)

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

  // Measure where each caret sits by laying the same text out in an invisible mirror
  useLayoutEffect(() => {
    const ta = textareaRef.current
    const holder = holderRef.current
    if (!ta || !holder || cursors.length === 0 || text.length > MAX_RENDER_CHARS) {
      setPlaced(prev => (prev.length === 0 ? prev : []))
      return
    }
    const cs = getComputedStyle(ta)
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4
    const mirror = document.createElement('div')
    mirror.style.cssText = 'position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;'
      + 'white-space:pre-wrap;overflow-wrap:break-word;word-break:normal;box-sizing:border-box;border:0;'
    for (const prop of MIRROR_PROPS) mirror.style[prop] = cs[prop]
    mirror.style.width = `${ta.clientWidth}px`
    holder.appendChild(mirror)

    const out: Placed[] = cursors.map(c => {
      const idx = Math.min(Math.max(c.end, 0), text.length)
      mirror.textContent = text.slice(0, idx)
      const marker = document.createElement('span')
      marker.textContent = '​'
      mirror.appendChild(marker)
      return { ...c, x: marker.offsetLeft, y: marker.offsetTop }
    })
    holder.removeChild(mirror)

    setPlaced(out)
    setBox({
      left: ta.offsetLeft + ta.clientLeft,
      top: ta.offsetTop + ta.clientTop,
      width: ta.clientWidth,
      height: ta.clientHeight,
      lineHeight,
    })
  }, [text, cursors, layoutTick, textareaRef])

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

interface ControlsProps {
  enabled: boolean
  name: string
  others: RemoteCursor[]
  onToggle: (enabled: boolean) => void
  onReroll: () => void
}

// Opt-in switch for multi-cursor, plus who is currently showing a cursor.
export function CursorControls({ enabled, name, others, onToggle, onReroll }: ControlsProps) {
  const shown = others.slice(0, 3)
  const extra = others.length - shown.length
  return (
    <div className="lc-controls">
      <button
        type="button"
        className={`lc-toggle${enabled ? ' is-on' : ''}`}
        onClick={() => onToggle(!enabled)}
        aria-pressed={enabled}
        title={enabled
          ? 'Multi-cursor is on: others who enable it can see where you type'
          : 'Turn on multi-cursor to see and show cursors while typing together'}
      >
        <MousePointer2 size={13} />
        Multi-cursor {enabled ? 'on' : 'off'}
      </button>

      {enabled && (
        <>
          <span className="lc-you" title="This is the name others see">
            <i style={{ background: 'var(--text-muted)' }} />
            You: {name}
          </span>
          <button type="button" className="lc-reroll" onClick={onReroll} aria-label="Pick a new random name" title="New random name">
            <Shuffle size={12} />
          </button>
          {shown.map(c => (
            <span key={c.id} className="lc-peer">
              <i style={{ background: colorForId(c.id) }} />
              {c.name}
            </span>
          ))}
          {extra > 0 && <span className="lc-peer">+{extra} more</span>}
        </>
      )}
    </div>
  )
}
