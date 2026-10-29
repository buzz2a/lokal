import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const sharp = require('sharp')
const { candidatesFromHistory, pixelSide } = require('../electron/artwork/repairDownloads')

function fakeDB(rows) {
  return { prepare(query) {
    assert.match(query, /download_jobs/)
    return { all: () => rows }
  } }
}

test('repair uses exact saved addon job cover and indexed track IDs only', () => {
  const make = data => ({ data: JSON.stringify(data) })
  const records = [
    make({ opts: { addonSource: { provider: 'qobuz-addon' }, tags: {
      cover: 'https://cdn.example/album.jpg' } }, indexedTracks: [
      { id: 't-saved', filepath: '/Music/a.flac' }] }),
    make({ opts: { tags: { cover: 'https://cdn.example/untrusted.jpg' } },
      indexedTracks: [{ id: 't-local' }] }),
    make({ opts: { addonSource: { provider: 'addon' }, tags: {
      cover: 'http://insecure.example/image.jpg' } },
      indexedTracks: [{ id: 't-insecure' }] }),
    { data: '{bad json' },
  ]
  const found = candidatesFromHistory(fakeDB(records))
  assert.deepEqual([...found.entries()], [
    ['t-saved', { url: 'https://cdn.example/album.jpg', source: 'qobuz-addon' }],
  ])
})

test('pixel-based repair reads image bytes rather than 150px UI cache dimensions', async () => {
  const full = await sharp({ create: {
    width: 1200, height: 1100, channels: 3, background: '#222222',
  } }).jpeg().toBuffer()
  assert.equal(await pixelSide(full), 1100)
  assert.equal(await pixelSide(Buffer.from('not an image')), null)
  assert.equal(await pixelSide(null), 0)
})
