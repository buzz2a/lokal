// Keys on the Camelot wheel, for mixing. The library keeps a song's key as
// track_key (the root's pitch class, C = 0) and mode (1 major, 0 minor), the
// way imported audio features and AutoMix's analysis give it; here that's a
// wheel position ("8A" = A minor, "8B" = C major) and how well two keys mix.

// The wheel number of each root, as in electron/automix/analysis.js.
const MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
const MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]

const pitch = value => {
  const n = Number(value)
  return value != null && value !== '' && Number.isInteger(n) && n >= 0 && n <= 11 ? n : null
}

/** { num 1–12, letter 'A' minor / 'B' major } for a root and mode, or null when either is unknown (an imported key of -1). */
function camelotOf(root, mode) {
  const r = pitch(root)
  const m = Number(mode)
  if (r === null || mode == null || mode === '' || (m !== 0 && m !== 1)) return null
  return m === 1 ? { num: MAJOR[r], letter: 'B' } : { num: MINOR[r], letter: 'A' }
}

/** "8A" (any case, spaces allowed) as a wheel position, or null. */
function parseCamelot(text) {
  const match = /^\s*(\d{1,2})\s*([ab])\s*$/i.exec(String(text ?? ''))
  if (!match) return null
  const num = Number(match[1])
  return num >= 1 && num <= 12 ? { num, letter: match[2].toUpperCase() } : null
}

const format = key => (key ? `${key.num}${key.letter}` : null)

/** The root and mode stored for a wheel position. */
function keyOf(key) {
  const table = key.letter === 'B' ? MAJOR : MINOR
  return { root: table.indexOf(key.num), mode: key.letter === 'B' ? 1 : 0 }
}

const wrap = num => ((num - 1 + 12) % 12) + 1

/** The keys that mix with `key` the usual way: itself, one step either side, and its relative major or minor. */
function mixesWith(key) {
  const other = key.letter === 'A' ? 'B' : 'A'
  return [key, { num: wrap(key.num - 1), letter: key.letter }, { num: wrap(key.num + 1), letter: key.letter }, { num: key.num, letter: other }]
}

/**
 * How well two keys mix, 0–1: the same key 1, one step round the wheel 0.9,
 * the relative major/minor 0.85, a diagonal step 0.6, two steps 0.4, then
 * less with distance. Unknown: 0.5, so it neither helps nor hurts.
 */
function harmonic(a, b) {
  if (!a || !b) return 0.5
  const d = Math.abs(a.num - b.num) % 12
  const dist = Math.min(d, 12 - d)
  const same = a.letter === b.letter
  if (dist === 0) return same ? 1 : 0.85
  if (dist === 1) return same ? 0.9 : 0.6
  if (dist === 2 && same) return 0.4
  return Math.max(0, 0.3 - dist * 0.04)
}

module.exports = { camelotOf, parseCamelot, format, keyOf, mixesWith, harmonic }
