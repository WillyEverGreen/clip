import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { BASE } from './api'

export const OPT_OUT_KEY = 'clip_analytics_opt_out'

/**
 * Checks whether the current browser/device is excluded from analytics tracking.
 */
export function isDeviceExcluded(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(OPT_OUT_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Enables or disables device-level analytics exclusion via localStorage.
 */
export function setDeviceExcluded(excluded: boolean): void {
  if (typeof window === 'undefined') return
  try {
    if (excluded) {
      localStorage.setItem(OPT_OUT_KEY, '1')
    } else {
      localStorage.removeItem(OPT_OUT_KEY)
    }
  } catch {
    // Gracefully ignore storage write failures (e.g. private browsing quota)
  }
}

/**
 * Reports a page view event to the analytics beacon endpoint.
 * Silently drops if excluded, under /admin, or if window is undefined.
 */
export function reportPageView(pathname: string): void {
  if (typeof window === 'undefined') return
  if (isDeviceExcluded()) return
  if (pathname.startsWith('/admin')) return

  const payload = {
    path: pathname,
    referrer: typeof document !== 'undefined' ? document.referrer || '' : '',
  }

  const url = `${BASE}/api/analytics/event`

  // First try navigator.sendBeacon with a JSON Blob
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
      const sent = navigator.sendBeacon(url, blob)
      if (sent) return
    }
  } catch {
    // If sendBeacon fails or throws, fall through to fetch
  }

  // Fallback to fetch with keepalive: true
  try {
    if (typeof fetch === 'function') {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {
        // Silently swallow network errors to never impact UX
      })
    }
  } catch {
    // Silently swallow any synchronous errors
  }
}

/**
 * React hook that triggers a page view report whenever the router location pathname changes.
 */
export function useAnalytics(): void {
  const location = useLocation()
  useEffect(() => {
    reportPageView(location.pathname)
  }, [location.pathname])
}
