import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectSublineUnits } from '../src/lyrics/sublineTiming.mjs'

const original = {
  text: 'お は よ',
  words: [
    { word: 'お', time: 10, end: 10.5, space: true },
    { word: 'は', time: 11, end: 11.3, space: true },
    { word: 'よ', time: 12, end: 13, space: false },
  ],
}

const display = units => units.map(u => u.word + (u.space ? ' ' : '')).join('').trim()

test('translated fragments retain exact text and stay within their source vocal windows', () => {
  const result = projectSublineUnits(original, { text: 'Good morning friend' })
  assert.equal(display(result.words), 'Good morning friend')
  assert.equal(result.words[0].time, 10)
  assert.equal(result.words.at(-1).end, 13)
  assert.ok(result.words.length > 3, 'words crossing source units must split')
  const sourceWindows = original.words.map(u => [u.time, u.end])
  for (const unit of result.words) {
    assert.ok(sourceWindows.some(([start, end]) =>
      unit.time >= start && unit.end <= end),
    `unit "${unit.word}" crosses a vocal pause: ${unit.time}–${unit.end}`)
  }
})

test('highlight stops throughout a silent gap instead of sweeping the next syllable', () => {
  const projected = projectSublineUnits(original, { text: 'abc' })
  assert.deepEqual(projected.words.map(u => u.word), ['a', 'b', 'c'])
  assert.deepEqual(projected.words.map(u => [u.time, u.end]), [
    [10, 10.5], [11, 11.3], [12, 13],
  ])
  assert.ok(projected.words[0].end < projected.words[1].time)
  assert.ok(projected.words[1].end < projected.words[2].time)
})

test('romanization without spaces follows original syllables', () => {
  const result = projectSublineUnits(original, { text: 'ohayo' })
  assert.equal(display(result.words), 'ohayo')
  assert.equal(result.words[0].time, 10)
  assert.equal(result.words.at(-1).end, 13)
  assert.ok(result.words.every(u => original.words.some(s =>
    u.time >= s.time && u.end <= s.end)))
})

test('existing provider-supplied romanization timing remains authoritative', () => {
  const romaji = { text: 'o ha yo', words: [{ word: 'o', time: 10.12, end: 10.35 }] }
  assert.equal(projectSublineUnits(original, romaji), romaji)
})

test('untimed and absent sublines remain unchanged', () => {
  const translated = { text: 'Hello' }
  assert.equal(projectSublineUnits({ text: 'こんにちは' }, translated), translated)
  assert.equal(projectSublineUnits(original, null), null)
})

test('projection does not mutate source or translated text', () => {
  const translated = { text: 'Hello world' }
  const copy = JSON.stringify(original)
  const projected = projectSublineUnits(original, translated)
  assert.deepEqual(translated, { text: 'Hello world' })
  assert.equal(JSON.stringify(original), copy)
  assert.equal(display(projected.words), 'Hello world')
})
