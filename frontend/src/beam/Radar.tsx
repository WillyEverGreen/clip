import { Check } from 'lucide-react'
import { colorForId } from '../lib/cuteNames'
import { avatarFor } from './beamFormat'
import type { NearbyEntry } from './beamSender'

interface RadarProps {
  people: NearbyEntry[]
  selected: Set<string>
  /** ids that already have a transfer going, shown as connected and not selectable */
  connected: Set<string>
  onToggle: (id: string) => void
}

/** Where the i-th person sits: rings of 5, spread by the golden angle so neighbours do not overlap. */
export function radarPosition(i: number): { x: number; y: number } {
  const ring = Math.floor(i / 5)
  const radius = 26 + (ring % 3) * 11 + ((i % 2) * 4)
  const angle = ((i * 137.5 + ring * 40) % 360) * (Math.PI / 180)
  return { x: 50 + radius * Math.cos(angle), y: 50 + radius * Math.sin(angle) }
}

function badge(p: NearbyEntry, connected: boolean): string | null {
  if (connected) return 'Connected'
  if (p.status === 'invited') return 'Asked'
  if (p.status === 'accepted') return 'Joining'
  if (p.status === 'declined') return 'Declined'
  return null
}

/** Receivers on this network as avatars on a radar. Tap to select several, then send the request. */
export default function Radar({ people, selected, connected, onToggle }: RadarProps) {
  return (
    <div className="beam-radar" role="group" aria-label="People nearby">
      <div className="beam-radar-ring beam-radar-ring-1" />
      <div className="beam-radar-ring beam-radar-ring-2" />
      <div className="beam-radar-ring beam-radar-ring-3" />
      <div className="beam-radar-sweep" aria-hidden="true" />
      <div className="beam-radar-you" aria-hidden="true" />
      {people.map((p, i) => {
        const { x, y } = radarPosition(i)
        const isConnected = connected.has(p.id)
        const busy = isConnected || p.status === 'invited' || p.status === 'accepted'
        const isSelected = selected.has(p.id)
        const tag = badge(p, isConnected)
        return (
          <button
            key={p.id}
            type="button"
            className={`beam-peer${isSelected ? ' is-selected' : ''}${busy ? ' is-busy' : ''}`}
            style={{ left: `${x}%`, top: `${y}%` }}
            data-peer={p.name}
            data-peer-id={p.id}
            data-peer-status={isConnected ? 'connected' : p.status}
            aria-pressed={isSelected}
            aria-label={`${p.name}${tag ? `, ${tag}` : ''}`}
            disabled={busy}
            onClick={() => onToggle(p.id)}
          >
            <span className="beam-peer-avatar" style={{ background: `${colorForId(p.name)}33`, borderColor: isSelected ? '#fff' : colorForId(p.name) }}>
              <span aria-hidden="true">{avatarFor(p.name)}</span>
              {isSelected && <span className="beam-peer-check"><Check size={11} strokeWidth={3} /></span>}
            </span>
            <span className="beam-peer-name">{p.name}</span>
            {tag && <span className="beam-peer-tag">{tag}</span>}
          </button>
        )
      })}
    </div>
  )
}
