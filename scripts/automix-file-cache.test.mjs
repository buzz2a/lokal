import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { automixFileCacheKey } = require('../electron/ipc/automix.js')

test('identical file revisions reuse their cached analysis', () => {
  const track = { id: '42', file_path: '/music/track.flac' }
  const stamp = { size: 1234567, mtimeMs: 1760000000000 }
  assert.equal(automixFileCacheKey(track, stamp), automixFileCacheKey({ ...track }, { ...stamp }))
})

test('overwriting or retagging the same ID invalidates cached analysis', () => {
  const track = { id: '42', file_path: '/music/track.flac' }
  const base = { size: 1234567, mtimeMs: 1760000000000 }
  const previous = automixFileCacheKey(track, base)
  assert.notEqual(automixFileCacheKey(track, { ...base, mtimeMs: base.mtimeMs + 5000 }), previous)
  assert.notEqual(automixFileCacheKey(track, { ...base, size: base.size + 100 }), previous)
  assert.notEqual(automixFileCacheKey({ ...track, start_offset_ms: 12345 }, base), previous)
  assert.notEqual(automixFileCacheKey({ ...track, id: '43' }, base), previous)
})

test('missing file stamps cannot create misleading cache entries', () => {
  assert.equal(automixFileCacheKey({ id: '42' }, null), null)
  assert.equal(automixFileCacheKey({ id: '42' }, { size: NaN, mtimeMs: 1 }), null)
})
