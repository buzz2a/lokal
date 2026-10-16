// A song's key as the library keeps it: track_key (the root's pitch class,
// C = 0) and mode (1 major, 0 minor), whatever form a source gives it in:
// Camelot ("8A"), a name ("A minor", "F#m", "Eb Major"), or Beatport's key
// object ({ camelot_number, camelot_letter }).

const { parseCamelot, keyOf, camelotOf, format } = require('../mixing/camelot')

const ROOTS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }

/** { track_key, mode } for a key in any of those forms, or null. */
function parseKey(value) {
  if (value == null || value === '') return null
  if (typeof value === 'object') {
    if (Number.isInteger(value.track_key) && (value.mode === 0 || value.mode === 1)) return { track_key: value.track_key, mode: value.mode }
    if (value.camelot_number && value.camelot_letter) return parseKey(`${value.camelot_number}${value.camelot_letter}`)
    return parseKey(value.name || '')
  }
  const text = String(value).trim()
  const wheel = parseCamelot(text)
  if (wheel) {
    const { root, mode } = keyOf(wheel)
    return { track_key: root, mode }
  }
  const match = /^([a-g])\s*([#♯]|b|♭)?\s*(m|min|minor|maj|major)?$/i.exec(text.replace(/\s+(?=[#♯♭])/g, ''))
  if (!match) return null
  let root = ROOTS[match[1].toLowerCase()]
  if (match[2] && /[#♯]/.test(match[2])) root += 1
  else if (match[2]) root -= 1
  const quality = (match[3] || '').toLowerCase()
  // "Am" is minor; "AM" or "A" alone is major.
  const minor = quality === 'min' || quality === 'minor' || (quality === 'm' && match[3] === 'm')
  return { track_key: (root + 12) % 12, mode: minor ? 0 : 1 }
}

/** "8A" for a stored key, or null. */
const camelotName = (trackKey, mode) => format(camelotOf(trackKey, mode))

module.exports = { parseKey, camelotName }
