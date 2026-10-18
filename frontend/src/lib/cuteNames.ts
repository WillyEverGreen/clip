// Friendly display names and colors for Live Pad multi-cursor.

const ADJECTIVES = [
  'Fluffy', 'Sleepy', 'Bouncy', 'Cozy', 'Sparkly', 'Giggly', 'Snuggly', 'Mellow',
  'Peppy', 'Dizzy', 'Toasty', 'Wiggly', 'Breezy', 'Jolly', 'Fuzzy', 'Zippy',
  'Dreamy', 'Cheery', 'Bubbly', 'Tiny', 'Sunny', 'Mighty', 'Gentle', 'Silly',
]

const ANIMALS = [
  'Otter', 'Panda', 'Fox', 'Bunny', 'Koala', 'Penguin', 'Hedgehog', 'Duckling',
  'Kitten', 'Puppy', 'Llama', 'Quokka', 'Axolotl', 'Capybara', 'Owl', 'Hamster',
  'Seal', 'Narwhal', 'Sloth', 'Corgi', 'Lamb', 'Chick', 'Dolphin', 'Squirrel',
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

export function randomCuteName(): string {
  return `${ADJECTIVES[randomInt(ADJECTIVES.length)]} ${ANIMALS[randomInt(ANIMALS.length)]}`
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
  return { enabled, name: name || randomCuteName() }
}

export function saveCursorPrefs(enabled: boolean, name: string): void {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0')
    localStorage.setItem(NAME_KEY, name)
  } catch { /* storage unavailable */ }
}
