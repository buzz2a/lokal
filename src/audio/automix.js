// AutoMix: how one song goes into the next, from both songs' analyses
// (electron/automix/analysis.js): when the transition starts, how long it
// runs, where the next song comes in, and whether it's beat-matched.
//
//   gapless    songs of one album in order: no transition (the album plays
//              as made), unless "Mix songs on the same album" is on.
//   beatmatch  two steady songs at nearly the same tempo (or double, or
//              half): the next one is sped up or slowed (pitch kept) to the
//              playing one's tempo, starts on its beat, and the two cross
//              over 16 beats (or 32 with suitable structural cues) with a bass swap halfway (two basslines at
//              once sound muddy); its tempo then glides back.
//   smart      the rest: a crossfade placed on the song's own fade-out (or
//              its last seconds when it ends hard), silence at either end
//              cut, shorter between songs of very different energy.
//
// Plain crossfade settings are separate (src/audio/crossfade.js).

export const AUTOMIX_PRELOAD_S = 10 // the next song starts loading this long before the transition
const MAX_RATE_CHANGE = 0.06 // ±6%: beyond, time-stretching is heard
const MIN_BEAT_CONFIDENCE = 0.4
const MIN_MIX_ENERGY = 0.3 // quieter (ballads, acoustic): no beat-matching
const BEATMATCH_BEATS = 16
const MAX_LEAD_IN_S = 15 // longer quiet starts are part of the song (an intro), not silence
const SWAP_HZ = 220 // the bass swap's high-pass

const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()

/** The next song is the playing one's album's next track: the album plays as made. */
export function albumContinues(outTrack, nextTrack) {
  if (!outTrack?.album || !nextTrack?.album || !sameText(outTrack.album, nextTrack.album)) return false
  const artistOf = track => track.album_artist || track.artist
  if (!sameText(artistOf(outTrack), artistOf(nextTrack))) return false
  const a = Number(outTrack.track_num)
  const b = Number(nextTrack.track_num)
  return !(a > 0 && b > 0) || b === a + 1
}

/** A song's tempo: an imported one (from Spotify's data) when it agrees with the analysis, else the analysis'. */
export function tempoOf(track, analysis) {
  const found = Number(analysis?.bpm) || null
  const imported = Number(track?.tempo) || null
  if (imported && found) {
    for (const factor of [1, 2, 0.5, 4 / 3, 3 / 4, 3 / 2, 2 / 3]) {
      if (Math.abs(found / (imported * factor) - 1) < 0.04) return { bpm: imported, confidence: Math.max(0.6, analysis.beatConfidence || 0), firstBeat: analysis.firstBeat, factor }
    }
  }
  if (found) return { bpm: found, confidence: analysis.beatConfidence || 0, firstBeat: analysis.firstBeat || 0, factor: 1 }
  return null
}

/** The next song's playback rate that puts it on the playing song's tempo (or null when too far apart). */
export function matchRate(outBpm, inBpm) {
  if (!outBpm || !inBpm) return null
  let best = null
  for (const multiple of [1, 2, 0.5]) {
    const rate = outBpm / (inBpm * multiple)
    if (Math.abs(rate - 1) <= MAX_RATE_CHANGE && (!best || Math.abs(rate - 1) < Math.abs(best - 1))) best = rate
  }
  return best
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
/** Pick a strong, credible bar-level energy cue near the intended handoff.
 * These are lightweight analysis hints, never a guarantee of vocal absence.
 */
export function cueNear(candidates, target, tolerance, min = 0, max = Infinity) {
  if (!Array.isArray(candidates) || !Number.isFinite(target) || tolerance <= 0) return null
  const options = candidates.filter(item => item &&
    Number.isFinite(item.time) && Number.isFinite(item.confidence) &&
    item.confidence >= 0.55 && item.time >= min && item.time <= max &&
    Math.abs(item.time - target) <= tolerance)
  options.sort((a, b) =>
    (Math.abs(a.time - target) / tolerance - a.confidence * 0.15) -
    (Math.abs(b.time - target) / tolerance - b.confidence * 0.15))
  return options[0] || null
}


/**
 * The transition from the playing song into the next.
 * @param out the playing song's analysis (or null), outTrack its track, outDuration its length (s)
 * @param next the next song's analysis (or null), nextTrack its track
 * @returns null (no transition: it plays to its end and the next starts as usual), or
 *   { kind, start, length, inOffset, fadeIn, rate, bassSwap, swapAt, highpass }
 *   start: the playing song's time the transition begins; length: seconds it runs;
 *   inOffset: where the next song starts; fadeIn: how long it takes to come up;
 *   rate: its playback rate during the transition (back to 1 after).
 */
export function planTransition({ out, outTrack, outDuration, next, nextTrack, sameAlbum = false }) {
  const duration = Number(outDuration) || Number(out?.duration) || Number(outTrack?.duration) || 0
  if (!(duration > 20)) return null
  if (!sameAlbum && albumContinues(outTrack, nextTrack)) return null
  const outEnd = Math.min(duration, Number(out?.audibleEnd) || duration)
  const inOffset = next && Number(next.leadIn) > 0.05 && Number(next.leadIn) <= MAX_LEAD_IN_S ? Number(next.leadIn) : 0
  const earliest = Math.max(20, duration * 0.4)
  // The incoming source cannot replace the outgoing one after its last
  // audible sample. In particular, a short track with a long suggested
  // beat overlap must not run an overlong fade into silence.
  const finish = plan => {
    if (!(Number.isFinite(outEnd) && outEnd - earliest >= 0.5)) return null
    const start = clamp(plan.start, earliest, outEnd - 0.5)
    const length = Math.min(plan.length, outEnd - start)
    if (!(Number.isFinite(start) && Number.isFinite(length) && length >= 0.5)) return null
    const rounded = value => Math.round(value * 1000) / 1000
    // A partial beatmatch would lose its intended beat count/phase. Fall
    // back to a short ordinary handoff rather than time-stretch off-grid.
    if (plan.kind === 'beatmatch' && length < plan.length - 0.01) {
      return {
        kind: 'smart', start: rounded(start), length: rounded(length),
        inOffset: plan.inOffset, fadeIn: rounded(Math.min(plan.fadeIn, length)),
        rate: 1, bassSwap: false,
      }
    }
    const result = {
      ...plan, start: rounded(start), length: rounded(length),
      fadeIn: rounded(Math.min(plan.fadeIn, length)),
    }
    // Shortening an overlap can put the bass swap beyond its endpoint.
    // When there is no room to exchange basslines, use an ordinary fade.
    if (result.bassSwap && (!Number.isFinite(result.swapAt) || result.swapAt >= length - 0.1)) {
      result.bassSwap = false
      delete result.swapAt
      delete result.highpass
    }
    return result
  }

  if (!out || !next) {
    // Not analysed (yet, or it couldn't be): an even crossfade over the last seconds.
    return finish({ kind: 'crossfade', start: duration - 6, length: 6, inOffset, fadeIn: 3, rate: 1, bassSwap: false })
  }

  const outTempo = tempoOf(outTrack, out)
  const inTempo = tempoOf(nextTrack, next)
  const rate = outTempo && inTempo ? matchRate(outTempo.bpm, inTempo.bpm) : null
  const steady = outTempo?.confidence >= MIN_BEAT_CONFIDENCE && inTempo?.confidence >= MIN_BEAT_CONFIDENCE
  const driving = Number(out.energy) >= MIN_MIX_ENERGY && Number(next.energy) >= MIN_MIX_ENERGY
  const fadeSpan = outEnd - (Number(out.fadeOutStart) || outEnd)

  if (rate && steady && driving) {
    const beat = 60 / outTempo.bpm
    const baseLength = clamp(BEATMATCH_BEATS * beat, 5, 14)
    const firstBeat = Number(outTempo.firstBeat) || 0
    const inBeat = 60 / inTempo.bpm
    const inFirst = Number(inTempo.firstBeat) || 0
    let entry = inOffset > inFirst
      ? inFirst + Math.ceil((inOffset - inFirst) / inBeat) * inBeat
      : inFirst

    // A paired CUE-DETR report supplies 32-beat overlap *start* points,
    // not the later downbeats. Use those only if both roles are available
    // and lie in safe regions; missing pairs keep the heuristic planner.
    const modelEntrance = (next.transitionCues?.entrances || []).find(c =>
      c?.source === 'cue-detr' && Number.isFinite(c.time) &&
      c.time >= 0 && c.time <= Math.min(45, Number(next.duration || 180) - 20))
    const phraseLength = 32 * beat
    const modelExits = (out.transitionCues?.exits || []).filter(c =>
      c?.source === 'cue-detr' && Number.isFinite(c.time) &&
      c.time >= Math.max(earliest, outEnd - 90) &&
      c.time <= outEnd - phraseLength)
    const modelExit = modelExits.sort((a, b) => b.time - a.time)[0] || null
    if (modelEntrance && modelExit &&
        Number(outTempo.bpm) > 0 && Number(inTempo.bpm) > 0 &&
        phraseLength >= 9 && phraseLength <= 22) {
      const entryBeat = Math.round((modelEntrance.time - inFirst) / inBeat)
      const modelEntry = Math.max(0, inFirst + entryBeat * inBeat)
      const outBeat = Math.round((modelExit.time - firstBeat) / beat)
      const modelStart = Math.max(earliest, firstBeat + outBeat * beat)
      if (modelStart + phraseLength <= outEnd) {
        return finish({
          kind: 'beatmatch', start: modelStart,
          length: Math.round(phraseLength * 1000) / 1000,
          inOffset: Math.round(modelEntry * 1000) / 1000,
          fadeIn: Math.round(phraseLength * 500) / 1000,
          rate: Math.round(rate * 10000) / 10000,
          bassSwap: true,
          swapAt: Math.round(Math.min(phraseLength - 1, 16 * beat) * 1000) / 1000,
          highpass: SWAP_HZ,
        })
      }
    }

    // Optional strong intro cue: shift the incoming song to its next
    // musically convincing entrance, but never skip more than 15 seconds.
    const entrance = cueNear(
      next.transitionCues?.entrances, entry, 12,
      entry, Math.min(Number(next.duration) || Infinity, entry + MAX_LEAD_IN_S),
    )
    if (entrance) {
      entry = inFirst + Math.ceil((entrance.time - inFirst) / inBeat) * inBeat
    }

    // AutoMix Engine uses 32-beat handoffs. Attempt one only when independent
    // source analysis gives credible entry AND exit cues with enough runway.
    // Otherwise retain the tested 16-beat path rather than forcing long fades.
    const phraseLatest = outEnd - phraseLength
    const exitCue = phraseLength >= 9 && phraseLength <= 22
      ? cueNear(out.transitionCues?.exits, phraseLatest, 12 * beat, earliest, phraseLatest)
      : null
    const phrase = !!entrance && !!exitCue && outEnd - earliest >= phraseLength + 0.5
    const length = phrase ? phraseLength : baseLength
    const latest = (fadeSpan >= 3 && !phrase
      ? Math.min(outEnd, Number(out.fadeOutStart) + length)
      : outEnd) - length
    const target = phrase ? exitCue.time : latest
    const snapped = firstBeat + Math.round((target - firstBeat) / beat) * beat
    const start = snapped <= latest ? snapped : snapped - beat
    const beats = phrase ? 32 : BEATMATCH_BEATS
    const swapBeats = Math.round(beats / 2)
    return finish({
      kind: 'beatmatch', start, length: Math.round(length * 1000) / 1000,
      inOffset: Math.round(Math.max(0, entry) * 1000) / 1000,
      fadeIn: Math.round(length * 0.5 * 1000) / 1000,
      rate: Math.round(rate * 10000) / 10000,
      bassSwap: true, swapAt: Math.round(Math.min(length - 1, swapBeats * beat) * 1000) / 1000, highpass: SWAP_HZ,
    })
  }

  // A smart crossfade: on the song's own fade-out, else over its last seconds.
  const apart = Math.abs(Number(out.energy) - Number(next.energy))
  const softIntro = Number(next.intro) < -6
  let length
  let start
  if (fadeSpan >= 3) {
    length = clamp(fadeSpan, 3, 10)
    start = Number(out.fadeOutStart)
  } else {
    length = apart > 0.35 ? 3 : softIntro ? 7 : 5
    start = outEnd - length
  }
  return finish({
    kind: 'smart', start, length: Math.round(length * 1000) / 1000, inOffset,
    // A soft intro is already quiet: it comes in at once rather than fading from nothing.
    fadeIn: Math.round((softIntro ? Math.min(1, length) : length * 0.6) * 1000) / 1000,
    rate: 1, bassSwap: false,
  })
}
