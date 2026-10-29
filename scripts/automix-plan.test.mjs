import test from 'node:test'
import assert from 'node:assert/strict'
import { planTransition, albumContinues, matchRate, tempoOf } from '../src/audio/automix.js'

const analysis = (over = {}) => ({ duration: 200, leadIn: 0.4, audibleEnd: 198, fadeOutStart: 197, energy: 0.7, intro: -2, outro: -1, bpm: 124, beatConfidence: 0.6, firstBeat: 0.2, key: 0, mode: 1, ...over })

test('songs of one album in order play as made (unless asked to mix them)', () => {
  const a = { album: 'Discovery', artist: 'Daft Punk', track_num: 1 }
  const b = { album: 'Discovery', artist: 'Daft Punk', track_num: 2 }
  assert.equal(albumContinues(a, b), true)
  assert.equal(albumContinues(a, { ...b, track_num: 5 }), false)
  assert.equal(albumContinues(a, { ...b, album: 'Homework' }), false)
  assert.equal(planTransition({ out: analysis(), outTrack: a, outDuration: 200, next: analysis(), nextTrack: b }), null)
  assert.equal(planTransition({ out: analysis(), outTrack: a, outDuration: 200, next: analysis(), nextTrack: b, sameAlbum: true }).kind, 'beatmatch')
})

test('steady songs at close tempos are beat-matched on the beat grid, with a bass swap', () => {
  const plan = planTransition({ out: analysis({ bpm: 124 }), outTrack: { title: 'a' }, outDuration: 200, next: analysis({ bpm: 120, leadIn: 1.1, firstBeat: 0.3 }), nextTrack: { title: 'b' } })
  assert.equal(plan.kind, 'beatmatch')
  assert.ok(Math.abs(plan.rate - 124 / 120) < 1e-3)
  const beat = 60 / 124
  assert.ok(Math.abs(plan.length - 16 * beat) < 0.01, `16 beats (${plan.length})`)
  // On the grid, ending before the song's audible end.
  const k = (plan.start - 0.2) / beat
  assert.ok(Math.abs(k - Math.round(k)) < 1e-3, 'starts on a beat')
  assert.ok(plan.start + plan.length <= 198 + 1e-6)
  // The next song from its first beat after its 1.1 s of silence (beats every 0.5 s from 0.3).
  assert.ok(Math.abs(plan.inOffset - 1.3) < 1e-3, `in at ${plan.inOffset}`)
  assert.equal(plan.bassSwap, true)
  assert.ok(plan.swapAt > 0 && plan.swapAt < plan.length)
  // Double time counts too: 62 → 124.
  assert.ok(Math.abs(matchRate(124, 62) - 1) < 1e-9)
  assert.equal(matchRate(124, 100), null)
})

test('anything else: a crossfade on the song\'s own fade-out, silence cut', () => {
  // Far apart in tempo, with a 9 s fade-out and 3 s of silence after it.
  const plan = planTransition({ out: analysis({ bpm: 90, audibleEnd: 197, fadeOutStart: 188 }), outTrack: {}, outDuration: 200, next: analysis({ bpm: 140, leadIn: 2 }), nextTrack: {} })
  assert.equal(plan.kind, 'smart')
  assert.equal(plan.start, 188)
  assert.equal(plan.length, 9)
  assert.equal(plan.inOffset, 2)
  assert.equal(plan.rate, 1)
  // A hard ending between songs of very different energy: short.
  const hard = planTransition({ out: analysis({ bpm: 90, energy: 0.9, audibleEnd: 199.5, fadeOutStart: 199.4 }), outTrack: {}, outDuration: 200, next: analysis({ bpm: 70, energy: 0.3 }), nextTrack: {} })
  assert.equal(hard.length, 3)
  assert.equal(hard.start, 196.5)
  // A quiet ballad pair isn't beat-matched even at the same tempo.
  assert.equal(planTransition({ out: analysis({ energy: 0.2 }), outTrack: {}, outDuration: 200, next: analysis({ energy: 0.2 }), nextTrack: {} }).kind, 'smart')
  // Not analysed: an even crossfade over the last 6 s.
  assert.deepEqual(planTransition({ out: null, outTrack: {}, outDuration: 200, next: null, nextTrack: {} }), { kind: 'crossfade', start: 194, length: 6, inOffset: 0, fadeIn: 3, rate: 1, bassSwap: false })
})

test('an imported tempo wins when the analysis agrees with it (octave or triplet readings too)', () => {
  assert.equal(tempoOf({ tempo: 82 }, { bpm: 109.3, beatConfidence: 0.48 }).bpm, 82)
  assert.equal(tempoOf({ tempo: 87 }, { bpm: 174, beatConfidence: 0.2 }).bpm, 87)
  assert.equal(tempoOf({ tempo: 120 }, { bpm: 97, beatConfidence: 0.5 }).bpm, 97)
  assert.equal(tempoOf({}, { bpm: 128, beatConfidence: 0.5 }).bpm, 128)
})


test('short audible tails never produce an overlong AutoMix overlap', () => {
  const outgoing = analysis({ duration: 30, audibleEnd: 23, fadeOutStart: 22, bpm: 124 })
  const incoming = analysis({ bpm: 124 })
  const plan = planTransition({ out: outgoing, outTrack: {}, outDuration: 30, next: incoming, nextTrack: {} })
  assert.ok(plan)
  assert.equal(plan.kind, 'smart', 'incomplete beat sequences fall back to a safe mix')
  assert.equal(plan.rate, 1)
  assert.ok(plan.start + plan.length <= 23.001)
  assert.ok(plan.fadeIn <= plan.length)
  if (plan.bassSwap) assert.ok(plan.swapAt < plan.length - 0.1)
  const noRoom = planTransition({
    out: analysis({ duration: 30, audibleEnd: 20.2 }),
    outTrack: {}, outDuration: 30, next: incoming, nextTrack: {},
  })
  assert.equal(noRoom, null)
})


test('strong outgoing and incoming cues allow a validated 32-beat handoff', () => {
  const outgoing = analysis({
    transitionCues: { exits: [{ time: 182, confidence: 0.9 }] },
    audibleEnd: 198,
  })
  const incoming = analysis({
    bpm: 120, leadIn: 0.5, firstBeat: 0.3,
    transitionCues: { entrances: [{ time: 3.3, confidence: 0.9 }] },
  })
  const plan = planTransition({
    out: outgoing, outTrack: {}, outDuration: 200,
    next: incoming, nextTrack: {},
  })
  assert.equal(plan.kind, 'beatmatch')
  assert.ok(Math.abs(plan.length - (32 * 60 / 124)) < 0.01)
  assert.ok(plan.start + plan.length <= outgoing.audibleEnd + 0.001)
  assert.ok(plan.inOffset >= 3.3)
  assert.ok(plan.swapAt > 7)
  const withoutCues = planTransition({
    out: { ...outgoing, transitionCues: { exits: [] } }, outTrack: {},
    outDuration: 200, next: incoming, nextTrack: {},
  })
  assert.ok(withoutCues.length < 14, 'uncertain cues keep a short fade')
})

test('structural cue selection rejects malformed and low-confidence candidates', async () => {
  const { cueNear } = await import('../src/audio/automix.js')
  assert.equal(cueNear([{ time: 8, confidence: 0.2 }], 8, 2), null)
  assert.equal(cueNear([{ time: Infinity, confidence: 0.9 }], 8, 2), null)
  assert.equal(cueNear([null, { time: 8, confidence: 0.9 }], 8, 2)?.time, 8)
  assert.equal(cueNear([{ time: 8, confidence: 0.9 }], 8, 2)?.time, 8)
  assert.equal(cueNear([{ time: 80, confidence: 0.9 }], 8, 2), null)
})

test('offline CUE-DETR start points control a complete 32-beat overlap', () => {
  const out = analysis({
    duration: 200, audibleEnd: 198, bpm: 124,
    firstBeat: .2, beatConfidence: .8, energy: .7,
    transitionCues: { exits: [{time:166,confidence:.95,source:'cue-detr'}] },
  })
  const next = analysis({
    duration: 200, bpm:120, firstBeat:.3,
    beatConfidence:.8, energy:.7,
    transitionCues:{entrances:[{time:8,confidence:.95,source:'cue-detr'}]},
  })
  const p = planTransition({
    out, next, outTrack:{}, nextTrack:{}, outDuration:200,
  })
  assert.equal(p.kind,'beatmatch')
  assert.ok(p.start>=165.5 && p.start<=166.5)
  assert.ok(p.inOffset>=7.5 && p.inOffset<=8.5)
  assert.ok(p.start+p.length<=198)
  assert.ok(p.length>15 && p.length<17)
  const fallback=planTransition({
    out, next:{...next,transitionCues:{entrances:[]}},
    outTrack:{}, nextTrack:{},outDuration:200,
  })
  assert.ok(fallback.start>p.start, 'unpaired model cue must not skip the outro')
})
