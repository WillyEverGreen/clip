import type { Env } from './types'

/**
 * Notify all SSE clients watching a given slug that its content has changed.
 * This is fire-and-forget — always called via `waitUntil` so it never
 * delays the HTTP response.
 */
export async function notifyRoom(env: Env, slug: string, updatedAt?: number): Promise<void> {
  try {
    if (!env.CLIP_DO) return // graceful no-op if binding not configured
    const id  = env.CLIP_DO.idFromName(slug)
    const obj = env.CLIP_DO.get(id)
    await obj.fetch(
      new Request(`https://clip-do/room/${slug}/notify`, { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updatedAt })
      }),
    )
  } catch {
    // Never let notification failure bubble up to the caller
  }
}
