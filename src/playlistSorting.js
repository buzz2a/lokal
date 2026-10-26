import { camelotKey } from './smartPlaylists.js'

export function nextPlaylistSort(current, column) {
  return { column, direction: current?.column === column && current.direction === 'asc' ? 'desc' : 'asc' }
}

// Library timestamps are seconds; playlist membership timestamps are ms.
function addedTime(value) {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null
  return timestamp < 1e12 ? timestamp * 1000 : timestamp
}

const positive = value => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

// Each sortable column's value of a track; null sorts last.
const SORT_VALUES = {
  added: track => addedTime(track.added_at),
  time: track => positive(track.duration),
  bpm: track => positive(track.tempo),
  // Round the Camelot wheel: 1A, 1B, 2A... 12B.
  key: track => camelotKey(track.track_key, track.mode)?.order ?? null,
}

/** Sort the view, retaining playlist order for ties and unknown metadata last. */
export function sortPlaylistTracks(tracks, sort) {
  const descending = sort?.direction === 'desc'
  if (sort?.column === 'number') return descending ? [...tracks].reverse() : tracks
  const valueOf = SORT_VALUES[sort?.column]
  if (!valueOf) return tracks
  return tracks.map((track, index) => ({ track, index, value: valueOf(track) }))
    .sort((a, b) => {
      if (a.value === null) return b.value === null ? a.index - b.index : 1
      if (b.value === null) return -1
      return (a.value - b.value) * (descending ? -1 : 1) || a.index - b.index
    })
    .map(item => item.track)
}
