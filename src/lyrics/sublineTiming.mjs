// Project the original singer's timed vocal units onto translated/romanized
// display text. This is only visual timing, not translated phoneme alignment.
// Source-provided timed subline units always take precedence.
const count = text => Array.from(String(text || '')).length

/**
 * Create painted subline fragments that never cross a source vocal gap.
 * Split a translated word at a source-unit boundary WITHOUT adding spaces:
 * the last fragment alone carries the word's actual trailing-space flag.
 * The original source timing and any provider-authored subline timing survive.
 */
export function projectSublineUnits(source, sub) {
  if (!sub || typeof sub !== 'object' || !sub.text || !source?.words?.length) return sub
  if (sub.words?.length) return sub
  const units = source.words.filter(u => u && Number.isFinite(u.time) &&
    Number.isFinite(u.end) && u.end >= u.time && count(u.word) > 0)
  if (!units.length) return sub

  const sourceChars = units.reduce((n, u) => n + count(u.word), 0)
  if (!sourceChars) return sub
  const sourceSpans = []
  let sourceOffset = 0
  for (const unit of units) {
    const width = count(unit.word)
    sourceSpans.push({ unit, start: sourceOffset, end: sourceOffset + width, width })
    sourceOffset += width
  }

  const text = sub.text.trim()
  if (!text) return sub
  const parts = /\s/u.test(text)
    ? text.match(/\S+\s*/gu) || []
    : Array.from(text)
  const total = parts.reduce((n, part) => n + count(part.trim()), 0)
  if (!total) return sub

  const words = []
  let charOffset = 0
  let slot = 0
  // Assign each displayed character to ONE original timed unit. A projected
  // fragment can never animate through the silence before the next unit.
  for (const part of parts) {
    const letters = Array.from(part.trim())
    let fragment = ''
    let fragmentStart = 0
    let previousSlot = -1

    const flush = (endChar, space = false) => {
      if (!fragment) return
      const span = sourceSpans[previousSlot]
      const position = index => {
        const x = Math.min(span.end, Math.max(span.start, index / total * sourceChars))
        return span.unit.time + (span.unit.end - span.unit.time) *
          ((x - span.start) / span.width)
      }
      const time = position(fragmentStart)
      words.push({ word: fragment, time, end: Math.max(time, position(endChar)), space })
      fragment = ''
    }

    for (const letter of letters) {
      const midpoint = (charOffset + 0.5) / total * sourceChars
      while (slot < sourceSpans.length - 1 && midpoint >= sourceSpans[slot].end) slot++
      if (fragment && slot !== previousSlot) flush(charOffset)
      if (!fragment) { fragmentStart = charOffset; previousSlot = slot }
      fragment += letter
      charOffset++
    }
    flush(charOffset, /\s$/u.test(part))
  }

  return words.length ? { ...sub, words } : sub
}
