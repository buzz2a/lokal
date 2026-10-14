// Magic Sort (from LibViz): songs put in an order where each leads into the
// next (key, tempo, energy, mood) while the whole follows an arc: energy
// builds to a peak about 70% of the way in, then eases off. Greedy: from the
// song that best fits the opening, always the one that best follows the last
// and fits the arc at that point. The best order of all is a travelling
// salesman problem; this one sounds right and takes a moment.

const { camelotOf, harmonic } = require('./camelot')

const WEIGHTS = { key: 0.35, tempo: 0.3, energy: 0.2, mood: 0.15 }
const MAX_SONGS = 1500 // every pair is weighed: past this, the order is kept

const num = value => {
  const n = Number(value)
  return value == null || value === '' || !Number.isFinite(n) ? null : n
}
const clamp01 = value => Math.min(1, Math.max(0, value))

/** Tempo closeness, 0–1: within ~6% (a pitch fader's easy range) is near 1; half and double time count. */
function tempoFit(a, b) {
  if (!(a > 0) || !(b > 0)) return 0.5
  let best = 0
  for (const ratio of [b / a, (b * 2) / a, b / (a * 2)]) {
    const off = Math.abs(Math.log2(ratio)) / 0.084 // log2(1.06)
    best = Math.max(best, Math.exp(-off * off))
  }
  return best
}

const closeness = (a, b, scale) => (a == null || b == null ? 0.5 : Math.max(0, 1 - Math.abs(a - b) / scale))

/** How well song `b` follows song `a` (their features), 0–1. */
function transition(a, b) {
  return harmonic(a.key, b.key) * WEIGHTS.key + tempoFit(a.bpm, b.bpm) * WEIGHTS.tempo
    + closeness(a.energy, b.energy, 0.5) * WEIGHTS.energy + closeness(a.mood, b.mood, 0.6) * WEIGHTS.mood
}

/**
 * What the sort goes on, per song: key and tempo (the library's own, else its
 * AutoMix `analysis`), mood (imported valence) and energy. Imported energy
 * when every song has it, so they're all on one scale; otherwise the
 * analysis' loudness with the tempo, since loudness alone barely differs
 * between songs mastered loud.
 */
function features(songs) {
  const imported = songs.length > 0 && songs.every(song => num(song.energy) !== null)
  return songs.map(song => {
    const analysis = song.analysis || null
    const key = camelotOf(song.track_key, song.mode) || camelotOf(analysis?.key, analysis?.mode)
    const bpm = num(song.tempo) || num(analysis?.bpm)
    let energy = imported ? clamp01(num(song.energy)) : null
    if (energy === null && num(analysis?.energy) !== null) {
      energy = clamp01(0.6 * num(analysis.energy) + 0.4 * (bpm ? clamp01((bpm - 70) / 100) : 0.5))
    }
    return { key, bpm, energy, mood: num(song.valence) }
  })
}

/** The energy the arc wants at `p` (0 start – 1 end): from 0.35 up to 1 at `peakAt`, then down to 0.55. */
function targetEnergy(p, peakAt = 0.7) {
  if (p <= peakAt) return 0.35 + 0.65 * (0.5 - 0.5 * Math.cos(Math.PI * (p / peakAt)))
  return 1 - 0.45 * (0.5 - 0.5 * Math.cos(Math.PI * ((p - peakAt) / (1 - peakAt))))
}

/** Mean transition quality of an order (indexes into `f`), 0–1. */
function flow(f, order) {
  if (order.length < 2) return 1
  let sum = 0
  for (let i = 1; i < order.length; i++) sum += transition(f[order[i - 1]], f[order[i]])
  return sum / (order.length - 1)
}

/**
 * `songs` (tracks, each with its `analysis` or null) in Magic Sort's order:
 * { order (indexes into songs), before, after (how smooth the transitions
 * are, 0–1), known (songs with a key or tempo to go on) }.
 */
function magicSort(songs, { peakAt = 0.7, arcWeight = 0.35 } = {}) {
  const n = songs.length
  const f = features(songs)
  const known = f.filter(song => song.key || song.bpm).length
  const original = songs.map((_, i) => i)
  const before = flow(f, original)
  if (n <= 2 || n > MAX_SONGS) return { order: original, before, after: before, known }

  const remaining = new Set(original)
  const opening = targetEnergy(0, peakAt)
  let current = 0
  let closest = Infinity
  for (const i of remaining) {
    const off = Math.abs((f[i].energy ?? 0.5) - opening)
    if (off < closest) { closest = off; current = i }
  }
  remaining.delete(current)
  const order = [current]
  while (remaining.size) {
    const target = targetEnergy(order.length / (n - 1), peakAt)
    let best = -1
    let bestScore = -Infinity
    for (const i of remaining) {
      const arc = 1 - Math.abs((f[i].energy ?? 0.5) - target)
      const score = transition(f[current], f[i]) * (1 - arcWeight) + arc * arcWeight
      if (score > bestScore) { bestScore = score; best = i }
    }
    remaining.delete(best)
    order.push(best)
    current = best
  }
  return { order, before, after: flow(f, order), known }
}

module.exports = { magicSort, features, transition, tempoFit, targetEnergy, MAX_SONGS }
