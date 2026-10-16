// The song details Fix Metadata and the edit dialog show, how each one reads,
// and the names of the places they come from (electron/metadata/store.js).
import { keyLabel } from './smartPlaylists'

export const SOURCE_LABELS = {
  file: 'File',
  user: 'You',
  import: 'Import',
  analysis: 'Analysis',
  download: 'Download',
  merge: 'Merge',
  itunes: 'iTunes',
  musicbrainz: 'MusicBrainz',
  deezer: 'Deezer',
  beatport: 'Beatport',
}

// `key` stands for track_key and mode together; `artwork` for the cover.
export const TRACK_FIELDS = [
  { id: 'title', label: 'Title' },
  { id: 'artist', label: 'Artist' },
  { id: 'album', label: 'Album' },
  { id: 'album_artist', label: 'Album artist' },
  { id: 'track_num', label: 'Track #', type: 'number' },
  { id: 'year', label: 'Year', type: 'number' },
  { id: 'genres', label: 'Genres' },
  { id: 'record_label', label: 'Label' },
  { id: 'isrc', label: 'ISRC' },
  { id: 'tempo', label: 'BPM', type: 'number' },
  { id: 'key', label: 'Key', pickOnly: true },
  { id: 'explicit', label: 'Explicit', pickOnly: true },
  { id: 'artwork', label: 'Cover', pickOnly: true },
]

// Album mode: what goes on every song, and what each song gets from its own match.
export const ALBUM_FIELDS = ['album', 'album_artist', 'year', 'record_label', 'genres', 'artwork']
export const ALBUM_TRACK_FIELDS = [
  { id: 'title', label: 'Titles', defaultOn: true },
  { id: 'track_num', label: 'Track numbers', defaultOn: true },
  { id: 'artist', label: 'Artists', defaultOn: false },
  { id: 'isrc', label: 'ISRCs', defaultOn: true },
  { id: 'tempo', label: 'BPM', defaultOn: true },
  { id: 'key', label: 'Keys', defaultOn: true },
]

/** The store's fields behind a shown field. */
export const storeFields = id => (id === 'key' ? ['track_key', 'mode'] : id === 'artwork' ? ['artwork_path'] : id === 'genres' ? ['genre', 'genres'] : [id])

/** A shown field's value on a track or a result's fields (genres falls back to genre). */
export function fieldValue(fields, id) {
  if (!fields) return null
  if (id === 'key') return fields.track_key == null || fields.mode == null ? null : { track_key: fields.track_key, mode: fields.mode }
  if (id === 'artwork') return fields.artwork_url || null
  if (id === 'genres') return fields.genres || fields.genre || null
  const value = fields[id]
  return value === '' || value === undefined ? null : value
}

/** The fields to send to the store for a shown field's value. */
export function storeValues(id, value) {
  if (id === 'key') return value ? { track_key: value.track_key, mode: value.mode } : { track_key: null, mode: null }
  if (id === 'artwork') return value ? { artwork_url: value } : {}
  if (id === 'genres') return { genres: value || null }
  return { [id]: value === '' ? null : value }
}

export function formatValue(id, value) {
  if (value === null || value === undefined || value === '') return ''
  if (id === 'key') return keyLabel(value.track_key, value.mode)
  if (id === 'explicit') return Number(value) ? 'Yes' : 'No'
  if (id === 'tempo') return String(Math.round(Number(value) * 10) / 10)
  return String(value)
}

export const sameValue = (id, left, right) => {
  if (id === 'key') return (!left && !right) || (!!left && !!right && left.track_key === right.track_key && left.mode === right.mode)
  if (id === 'tempo') return Math.abs(Number(left) - Number(right)) < 0.05 || (left == null && right == null)
  return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase()
}

/** Where a shown field came from, given a track's provenance ({ field: { source, locked } }). */
export function fieldSource(provenance, id) {
  const [first] = storeFields(id)
  return provenance?.[first] || null
}
