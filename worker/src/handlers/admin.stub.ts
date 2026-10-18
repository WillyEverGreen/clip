// Placeholder used when the private admin module is not present (fresh clone, CI, forks).
// scripts/postinstall.js copies this to admin.ts only when admin.ts is missing, so the real
// admin code (kept out of the repository on purpose) is never overwritten.
import type { Context } from 'hono'
import type { Env } from '../lib/types'

const notAvailable = (c: Context<{ Bindings: Env }>) => c.json({ error: 'not_found' }, 404)

export const handleAdminList = notAvailable
export const handleAdminDelete = notAvailable
export const handleAdminPurgeAll = notAvailable
export const handleAdminLiveRooms = notAvailable
export const handleAdminDeleteLiveRoom = notAvailable
