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

/** A random one-word name. */
export function randomCuteName(): string {
  return NAMES[randomInt(NAMES.length)]!
}

/** Stable color for a participant, derived from their id so every client agrees. */
export function colorForId(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0
  return CURSOR_COLORS[h % CURSOR_COLORS.length]!
}

const NAME_KEY = 'clip_live_name'

/**
 * This browser's display name: picked at random the first time and remembered after that.
 * There is deliberately no way to change it; the server only adds a number if two people in one
 * room end up with the same name.
 */
export function loadMyName(): string {
  try {
    const saved = localStorage.getItem(NAME_KEY)
    if (saved && NAMES.includes(saved)) return saved
  } catch { /* storage unavailable */ }
  const name = randomCuteName()
  try {
    localStorage.setItem(NAME_KEY, name)
  } catch { /* storage unavailable */ }
  return name
}
