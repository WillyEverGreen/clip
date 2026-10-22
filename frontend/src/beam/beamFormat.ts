/** Pure text helpers for the Beam page (no browser or Vite dependencies, so they are unit tested in Node). */

export function formatPin(pin: string): string {
  return pin.length === 6 ? `${pin.slice(0, 3)}-${pin.slice(3)}` : pin
}

/** Pulls the six digits out of whatever was typed or pasted ("748 219", "748-219", a /beam?pin= link). */
export function parsePin(input: string): string | null {
  const fromLink = input.match(/[?&]pin=(\d{6})/)
  if (fromLink) return fromLink[1]
  const digits = input.replace(/\D/g, '')
  return digits.length === 6 ? digits : null
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : v < 10 ? 2 : 1)} ${units[i]}`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--'
  if (seconds > 0 && seconds < 1) return '<1s'
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Time left as shown to the user: whole seconds up to a minute, then minutes and seconds. */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'Calculating...'
  return `${formatDuration(seconds)} left`
}

const AVATARS = ['🍡', '🧁', '🥟', '🍪', '🍩', '🥐', '🍑', '🍋', '🥭', '🫐', '🍓', '🌸', '🌼', '🍀', '🐣', '🦊']

/** A stable emoji avatar for a display name (the trailing " 2" the room adds is ignored). */
export function avatarFor(name: string): string {
  const base = name.replace(/ \d+$/, '').toLowerCase()
  let h = 0
  for (let i = 0; i < base.length; i++) h = (Math.imul(h, 31) + base.charCodeAt(i)) >>> 0
  return AVATARS[h % AVATARS.length]
}
