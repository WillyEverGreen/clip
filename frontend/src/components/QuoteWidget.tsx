import { useCallback, useEffect, useState } from 'react'
import { Quote, RefreshCw, X } from 'lucide-react'
import '../styles/quote.css'

const QUOTES_API = 'https://quotes-api-ruddy.vercel.app'
const QUOTES_REPO = 'https://github.com/Chronos778/quotes_api'
const STORAGE_KEY = 'clip_show_quote'

interface QuoteData { text: string; author: string }

function readPref(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
}

function writePref(on: boolean) {
  try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0') } catch { /* storage unavailable */ }
}

// Opt-in quote of the moment for viewers. Off by default; the choice is remembered per browser.
export default function QuoteWidget() {
  const [enabled, setEnabled] = useState(readPref)
  const [quote, setQuote] = useState<QuoteData | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')

  const load = useCallback(async (signal?: AbortSignal) => {
    setState('loading')
    try {
      const res = await fetch(`${QUOTES_API}/quotes/random`, { signal })
      if (!res.ok) throw new Error(String(res.status))
      const json = await res.json()
      const q = json?.data
      if (!q?.text) throw new Error('bad shape')
      setQuote({ text: String(q.text), author: String(q.author ?? 'Unknown') })
      setState('idle')
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setState('error')
    }
  }, [])

  useEffect(() => {
    if (!enabled || quote) return
    const ctrl = new AbortController()
    void load(ctrl.signal)
    return () => ctrl.abort()
  }, [enabled, quote, load])

  const toggle = (on: boolean) => {
    setEnabled(on)
    writePref(on)
  }

  if (!enabled) {
    return (
      <button
        type="button"
        className="qw-fab"
        onClick={() => toggle(true)}
        title="Show a quote"
        aria-label="Show a quote"
      >
        <Quote size={15} />
      </button>
    )
  }

  return (
    <aside className="qw-card" aria-label="Quote">
      <div className="qw-actions">
        <button type="button" onClick={() => void load()} aria-label="New quote" title="New quote" disabled={state === 'loading'}>
          <RefreshCw size={13} className={state === 'loading' ? 'qw-spin' : ''} />
        </button>
        <button type="button" onClick={() => toggle(false)} aria-label="Hide quotes" title="Hide quotes">
          <X size={14} />
        </button>
      </div>
      {state === 'error' && !quote ? (
        <p className="qw-text qw-muted">Couldn&apos;t load a quote right now.</p>
      ) : quote ? (
        <>
          <p className="qw-text">&ldquo;{quote.text}&rdquo;</p>
          <p className="qw-author">&mdash; {quote.author}</p>
        </>
      ) : (
        <p className="qw-text qw-muted">Finding a quote&hellip;</p>
      )}
      <a className="qw-credit" href={QUOTES_REPO} target="_blank" rel="noopener noreferrer">
        Powered by Quotes API
      </a>
    </aside>
  )
}
