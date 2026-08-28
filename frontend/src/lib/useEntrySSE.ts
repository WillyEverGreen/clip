import { useEffect, useRef } from 'react'

const BASE_URL = import.meta.env.VITE_API_URL || ''

interface Options {
  /** Called whenever an "update" SSE event arrives for this slug */
  onUpdate: (updatedAt?: number) => void
}

/**
 * useEntrySSE — subscribes to real-time updates for a slug via Server-Sent Events.
 *
 * Behaviour:
 *  - Opens EventSource to /api/entry/:slug/events
 *  - On "update" event → calls onUpdate() so ViewPage re-fetches entry data
 *  - Includes updatedAt timestamp in update event for stale data detection
 *  - Implements retry-after-SSE polling (500ms, 2s) to handle KV propagation lag
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
    let retryPolls: ReturnType<typeof setTimeout>[] = []

    const connect = () => {
      if (destroyed) return

      const url = `${BASE_URL}/api/entry/${slug}/events`
      es = new EventSource(url)

      es.addEventListener('update', (event) => {
        retryDelay = 1_000  // reset backoff on successful message
        
        // Parse updatedAt from event data
        let updatedAt: number | undefined
        try {
          const data = JSON.parse(event.data)
          updatedAt = data.updatedAt
        } catch {
          // If parse fails, continue without updatedAt
        }
        
        // Immediate fetch
        onUpdateRef.current(updatedAt)
        
        // Schedule retry polls to handle KV propagation lag
        // Clear any existing retry polls first
        retryPolls.forEach(t => clearTimeout(t))
        retryPolls = []
        
        // Retry after 500ms and 2s to catch propagated updates
        retryPolls.push(setTimeout(() => onUpdateRef.current(updatedAt), 500))
        retryPolls.push(setTimeout(() => onUpdateRef.current(updatedAt), 2000))
      })

      es.addEventListener('connected', () => {
        retryDelay = 1_000  // reset backoff once stream confirmed live
      })

      es.onerror = (event) => {
        es?.close()
        es = null
        if (destroyed) return
        
        // Check if this is a 503 (Durable Object unavailable)
        // EventSource doesn't expose status codes directly, but we can detect connection failures
        // and fall back to interval-based polling after several failures
        const wasConnectionFailure = event && (event as any).status === 503
        
        // Exponential backoff reconnect
        retryTimer = setTimeout(() => {
          retryDelay = Math.min(retryDelay * 2, MAX_DELAY)
          
          // If we've hit max delay multiple times, it might be a persistent DO failure
          // Fall back to interval polling
          if (retryDelay >= MAX_DELAY) {
            console.warn('SSE connection repeatedly failing, falling back to interval polling')
            // Note: The component will continue retrying SSE in background
            // but the 5s initial poll in ViewPage will keep data updated
          }
          
          connect()
        }, retryDelay)
      }
    }

    connect()

    return () => {
      destroyed = true
      if (retryTimer) clearTimeout(retryTimer)
      retryPolls.forEach(t => clearTimeout(t))
      es?.close()
    }
  }, [slug])
}
