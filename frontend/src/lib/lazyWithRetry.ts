import { lazy, type ComponentType } from 'react'

const RELOAD_KEY = 'clip_chunk_reload'

/**
 * React.lazy for route pages. A new deploy replaces the old page files, so a tab that was open
 * before the deploy asks for a file that no longer exists. Reload once to pick up the new site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithRetry<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      const mod = await load()
      try { sessionStorage.removeItem(RELOAD_KEY) } catch { /* storage unavailable */ }
      return mod
    } catch (err) {
      let alreadyTried = true
      try {
        alreadyTried = sessionStorage.getItem(RELOAD_KEY) === '1'
        if (!alreadyTried) sessionStorage.setItem(RELOAD_KEY, '1')
      } catch { /* storage unavailable: do not loop */ }
      if (!alreadyTried) {
        window.location.reload()
        return new Promise<never>(() => undefined)
      }
      throw err
    }
  })
}
