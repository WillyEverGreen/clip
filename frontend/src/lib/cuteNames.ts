// Friendly one-word display names and colors for Live Pad multi-cursor.

const NAMES = [
  'Mochi', 'Biscuit', 'Pudding', 'Waffles', 'Pebble', 'Noodle', 'Bubbles', 'Peanut',
  'Cupcake', 'Muffin', 'Sprout', 'Marshmallow', 'Pixel', 'Button', 'Cookie', 'Nugget',
  'Pickles', 'Tofu', 'Boba', 'Sesame', 'Jellybean', 'Pumpkin', 'Cocoa', 'Daisy',
  'Poppy', 'Clover', 'Maple', 'Honey', 'Ziggy', 'Fudge', 'Cinnamon', 'Truffle',
  'Gizmo', 'Pancake', 'Sunny', 'Twinkle', 'Dumpling', 'Bean', 'Toast', 'Pretzel',
  'Sprinkles', 'Jelly', 'Brownie', 'Cashew', 'Olive', 'Peaches', 'Kiwi', 'Mango',
  'Lemon', 'Ginger', 'Willow', 'Pip', 'Bumble', 'Fizz', 'Wobble', 'Snickers',
  'Taffy', 'Butterscotch', 'Gumdrop', 'Marzipan', 'Biscotti', 'Churro', 'Pepper', 'Ember',
]

// Pastel-bright colors that stay readable on the pad's near-black background
export const CURSOR_COLORS = [
  '#f472b6', '#60a5fa', '#34d399', '#fbbf24',
  '#a78bfa', '#fb7185', '#2dd4bf', '#fb923c',
]

function randomInt(max: number): number {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return buf[0]! % max
}

/** A random one-word name, avoiding any in `taken` (names already in the room or our own). */
export function randomCuteName(taken: ReadonlySet<string> = new Set()): string {
  const free = NAMES.filter(n => !taken.has(n))
  const pool = free.length > 0 ? free : NAMES
  return pool[randomInt(pool.length)]!
}

/** Stable color for a participant, derived from their id so every client agrees. */
export function colorForId(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0
  return CURSOR_COLORS[h % CURSOR_COLORS.length]!
}

const ENABLED_KEY = 'clip_live_cursors'
const NAME_KEY = 'clip_live_name'

export function loadCursorPrefs(): { enabled: boolean; name: string } {
  let enabled = false
  let name = ''
  try {
    enabled = localStorage.getItem(ENABLED_KEY) === '1'
    name = localStorage.getItem(NAME_KEY) ?? ''
  } catch { /* storage unavailable */ }
  // Only keep a remembered name that is still one of ours (older builds used two-word names)
  return { enabled, name: NAMES.includes(name) ? name : randomCuteName() }
}

export function saveCursorPrefs(enabled: boolean, name: string): void {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0')
    localStorage.setItem(NAME_KEY, name)
  } catch { /* storage unavailable */ }
}
