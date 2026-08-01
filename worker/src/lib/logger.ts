import { hashIp } from './crypto'
import type { Env } from './types'

// NEVER log: edit codes, file content, markdown text, filenames
// Log only:  slug, hashed IP, endpoint, status, timestamps

type LogData = Record<string, string | number | boolean | undefined>

export async function log(
  event: string,
  data: LogData,
  env: Env,
): Promise<void> {
  const safeData = { ...data }

  // Auto-hash raw IPs before logging
  if (typeof safeData.ip === 'string') {
    safeData.ip = await hashIp(safeData.ip, env.APP_PEPPER)
  }

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...safeData,
    }),
  )
}
