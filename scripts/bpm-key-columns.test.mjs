import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { sortPlaylistTracks } from '../src/playlistSorting.js'
import { trackColumnDefaults, trackColumnLayout, trackColumnPreferences } from '../src/trackColumns.js'
import { camelotKey } from '../src/smartPlaylists.js'

const require = createRequire(import.meta.url)
const { safeSort } = require('../electron/trackErrors.js')

// 9/0 = A minor (8A), 0/1 = C major (8B), 7/1 = G major (9B), 4/0 = E minor (9A).
const tracks = [
  { id: 'g', tempo: 128, track_key: 7, mode: 1 },
  { id: 'none', tempo: null, track_key: null, mode: null },
  { id: 'am', tempo: 95.6, track_key: 9, mode: 0 },
  { id: 'c', tempo: 0, track_key: 0, mode: 1 },
  { id: 'em', tempo: 174, track_key: 4, mode: 0 },
]
const ids = list => list.map(track => track.id)

test('keys read as Camelot codes with their names', () => {
  assert.deepEqual(camelotKey(9, 0), { code: '8A', num: 8, letter: 'A', name: 'A minor', order: 16 })
  assert.equal(camelotKey(0, 1).code, '8B')
  assert.equal(camelotKey(null, 1), null)
  assert.equal(camelotKey(-1, 0), null)
})

test('playlists sort by BPM and round the Camelot wheel, unknowns last either way', () => {
  assert.deepEqual(ids(sortPlaylistTracks(tracks, { column: 'bpm', direction: 'asc' })), ['am', 'g', 'em', 'none', 'c'])
  assert.deepEqual(ids(sortPlaylistTracks(tracks, { column: 'bpm', direction: 'desc' })), ['em', 'g', 'am', 'none', 'c'])
  assert.deepEqual(ids(sortPlaylistTracks(tracks, { column: 'key', direction: 'asc' })), ['am', 'c', 'em', 'g', 'none'])
  assert.deepEqual(ids(sortPlaylistTracks(tracks, { column: 'key', direction: 'desc' })), ['g', 'em', 'c', 'am', 'none'])
})

test('the library sorts by tempo and Camelot key in SQL, unknowns last either way', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE tracks (id TEXT, tempo REAL, track_key INTEGER, mode INTEGER)')
  const add = db.prepare('INSERT INTO tracks VALUES (?, ?, ?, ?)')
  for (const track of tracks) add.run(track.id, track.tempo, track.track_key, track.mode)
  const order = sort => db.prepare(`SELECT id FROM tracks ORDER BY ${safeSort(sort)}, id`).all().map(row => row.id)
  assert.deepEqual(order('tempo ASC').slice(0, 3), ['am', 'g', 'em'])
  assert.deepEqual(order('tempo DESC').slice(0, 3), ['em', 'g', 'am'])
  assert.deepEqual(order('camelot ASC'), ['am', 'c', 'em', 'g', 'none'])
  assert.deepEqual(order('camelot DESC'), ['g', 'em', 'c', 'am', 'none'])
  assert.equal(safeSort('tempo; DROP TABLE tracks'), 'added_at DESC')
})

test('BPM and Key are off by default, saved choices stick, and they fit before quality', () => {
  assert.equal(trackColumnDefaults().bpm, false)
  assert.equal(trackColumnDefaults().key, false)
  const columns = trackColumnPreferences({ bpm: true, key: true }, true)
  const wide = trackColumnLayout(90, columns)
  assert.equal(wide.bpm, true)
  assert.equal(wide.key, true)
  assert.ok(wide.template.includes('minmax(0,2fr) 3rem 3.5rem'), wide.template)
  // Narrow: tempo and key keep their place while quality gives way.
  const narrow = trackColumnLayout(24, columns)
  assert.equal(narrow.bpm, true)
  assert.equal(narrow.key, true)
  assert.equal(narrow.quality, false)
})
