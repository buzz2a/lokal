import React from 'react'
import { camelotKey } from '../smartPlaylists'

// A song's tempo and key in song lists: the BPM rounded, the key as its
// Camelot code ("8A") in the wheel's color, its name ("A minor") on hover.

export function bpmText(tempo) {
  const value = Number(tempo)
  return Number.isFinite(value) && value > 0 ? String(Math.round(value)) : ''
}

/** The wheel's colors: one hue per hour, minor (A) a little deeper than major (B). */
export function camelotColors(key) {
  const hue = ((key.num - 1) * 30 + 165) % 360
  const light = key.letter === 'B' ? 72 : 64
  return { color: `hsl(${hue} 70% ${light}%)`, backgroundColor: `hsl(${hue} 70% ${light}% / 0.12)`, borderColor: `hsl(${hue} 70% ${light}% / 0.3)` }
}

export function KeyBadge({ track, className = '' }) {
  const key = camelotKey(track?.track_key, track?.mode)
  if (!key) return <span className={`text-xs text-muted/50 ${className}`}>—</span>
  return (
    <span title={key.name} style={camelotColors(key)}
      className={`inline-flex min-w-[2.1rem] justify-center rounded-full border px-1.5 py-px text-[10px] font-semibold tabular-nums leading-[14px] ${className}`}>
      {key.code}
    </span>
  )
}

export function BpmValue({ track, className = '' }) {
  const text = bpmText(track?.tempo)
  return <span className={`text-xs tabular-nums ${text ? 'text-white/80' : 'text-muted/50'} ${className}`} title={text ? `${Math.round(Number(track.tempo) * 10) / 10} BPM` : undefined}>{text || '—'}</span>
}
