import { useEffect, useRef } from 'react'

const BASE_URL = import.meta.env.VITE_API_URL || ''

interface Options {
  /** Called whenever an "update" SSE event arrives for this slug */
  onUpdate: () => void
}

/**
 * useEntrySSE — subscribes to real-time updates for a slug via Server-Sent Events.
 *
 * Behaviour:
 *  - Opens EventSource to /api/entry/:slug/events
 *  - On "update" event → calls onUpdate() so ViewPage re-fetches entry data
 *  - Reconnects automatically with exponential backoff (1s → 2s → 4s → max 30s)
 *  - Falls back to a 5s polling interval if EventSource is not supported
 *  - Cleans up on unmount or when slug changes
 */
export function useEntrySSE(slug: string | undefined, { onUpdate }: Options) {
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate

  useEffect(() => {
    if (!slug) return

    // Fallback for very old browsers (basically IE11 only)
    if (typeof EventSource === 'undefined') {
      const id = setInterval(() => onUpdateRef.current(), 5_000)
      return () => clearInterval(id)
    }

    let es: EventSource | null = null
    let retryDelay = 1_000      // start at 1s
    const MAX_DELAY = 30_000    // cap at 30s
    let destroyed = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (destroyed) return

      const url = `${BASE_URL}/api/entry/${slug}/events`
      es = new EventSource(url)

      es.addEventListener('update', () => {
        retryDelay = 1_000  // reset backoff on successful message
        onUpdateRef.current()
      })

      es.addEventListener('connected', () => {
        retryDelay = 1_000  // reset backoff once stream confirmed live
      })

      es.onerror = () => {
        es?.close()
        es = null
        if (destroyed) return
        // Exponential backoff reconnect
        retryTimer = setTimeout(() => {
          retryDelay = Math.min(retryDelay * 2, MAX_DELAY)
          connect()
        }, retryDelay)
      }
    }

    connect()

    return () => {
      destroyed = true
      if (retryTimer) clearTimeout(retryTimer)
      es?.close()
    }
  }, [slug])
}
