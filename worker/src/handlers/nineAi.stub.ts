// Placeholder used when the private 9ai module is not present (fresh clone, CI, forks).
// scripts/postinstall.js copies this to nineAi.ts only when nineAi.ts is missing, so the real
// 9ai code (kept out of the repository on purpose) is never overwritten.
import type { Context } from 'hono'
import type { Env } from '../lib/types'

const notFound = (c: Context<{ Bindings: Env }>) => c.text('Not Found', 404)

export const handleNineAiIndex = notFound
export const handleNineAiInstall = notFound
export const handleNineAiAsk = notFound
export const handleNineAiHealth = notFound
