import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

const require = createRequire(import.meta.url)
const store = require('../electron/metadata/store.js')

function db() {
  const d = new DatabaseSync(':memory:')
  d.exec(`CREATE TABLE tracks (id TEXT PRIMARY KEY, file_path TEXT, title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT, album_artist TEXT,
      track_num INTEGER, year INTEGER, genre TEXT, genres TEXT, record_label TEXT, isrc TEXT, explicit INTEGER DEFAULT 0, instrumental INTEGER,
      energy REAL, track_key INTEGER, mode INTEGER, tempo REAL, artwork_path TEXT);
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL);
    CREATE TABLE artist_track_links (artist_id TEXT NOT NULL, track_id TEXT NOT NULL, PRIMARY KEY (artist_id, track_id));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE lyrics_cache (track_id TEXT, file_path TEXT);
    CREATE TABLE lyrics_translations (track_id TEXT);`)
  d.prepare("INSERT INTO tracks (id, file_path, title, artist, album, genre, genres) VALUES ('t1', '/music/a.flac', 'Song', 'Band', 'Album', 'Rock', 'Rock, Pop')").run()
  d.prepare("INSERT INTO tracks (id, file_path, title, artist, album) VALUES ('t2', '/music/b.flac', 'Other', 'Band', 'Album')").run()
  return d
}

const row = (d, id = 't1') => d.prepare('SELECT * FROM tracks WHERE id = ?').get(id)

test('the user\'s edits are locked: other sources leave them, the user can still change them', () => {
  const d = db()
  const edited = store.applyFields(d, 't1', { title: 'Song (Edit)', year: '2001' }, { source: 'user' })
  assert.deepEqual(edited.changed.sort(), ['title', 'year'])
  assert.equal(row(d).year, 2001)
  const prov = store.provenance(d, 't1')
  assert.equal(prov.title.source, 'user')
  assert.equal(prov.title.locked, true)

  for (const source of ['import', 'itunes', 'file', 'download']) {
    const result = store.applyFields(d, 't1', { title: 'Wrong', year: 1999, album: 'New Album' }, { source })
    assert.deepEqual(result.skipped.sort(), ['title', 'year'], source)
  }
  assert.equal(row(d).title, 'Song (Edit)')
  assert.equal(row(d).album, 'New Album')

  store.applyFields(d, 't1', { title: 'Song' }, { source: 'user' })
  assert.equal(row(d).title, 'Song')
})

test('genre and genres move together, and their lock covers both', () => {
  const d = db()
  store.applyFields(d, 't1', { genres: ['House', ' Techno', 'House'] }, { source: 'user' })
  assert.equal(row(d).genres, 'House, Techno')
  assert.equal(row(d).genre, 'House')
  const result = store.applyFields(d, 't1', { genre: 'Pop' }, { source: 'import' })
  assert.deepEqual(result.changed, [])
  assert.equal(row(d).genre, 'House')
})

test('a rescan keeps locked fields and what another source filled in where the file has nothing', () => {
  const d = db()
  store.applyFields(d, 't1', { title: 'Mine' }, { source: 'user' })
  store.applyFields(d, 't2', { genre: 'Jazz' }, { source: 'itunes' })
  store.applyFields(d, 't2', { year: 1990 }, { source: 'musicbrainz' })

  const kept = store.keepProtectedFields(d, 't1', { title: 'From File', artist: 'Band', album: 'Album', genre: 'Rock' })
  assert.equal(kept.title, 'Mine')

  const second = store.keepProtectedFields(d, 't2', { title: 'Other', artist: 'Band', genre: null, year: 1991 })
  assert.equal(second.genre, 'Jazz', 'an empty file genre does not wipe the looked-up one')
  assert.equal(second.year, 1991, 'a value the file does have wins over an unlocked lookup')
  assert.equal(store.provenance(d, 't2').year, undefined, 'and the year is from the file again')
  assert.equal(store.provenance(d, 't2').genre.source, 'itunes')
})

test('fill-only writes (the analysis) never overwrite a value', () => {
  const d = db()
  d.prepare("UPDATE tracks SET tempo = 128 WHERE id = 't1'").run()
  const result = store.applyFields(d, 't1', { tempo: 124.7, track_key: 9, mode: 0 }, { source: 'analysis', overwrite: false })
  assert.deepEqual(result.changed.sort(), ['mode', 'track_key'])
  assert.equal(row(d).tempo, 128)
  assert.equal(store.provenance(d, 't1').track_key.source, 'analysis')
})

test('a batch can be undone, sources included, unless the value changed since', () => {
  const d = db()
  store.applyFields(d, 't1', { record_label: 'Old Label' }, { source: 'import' })
  const batch = store.applyMany(d, [
    { trackId: 't1', fields: { record_label: 'Warp', year: 2004 } },
    { trackId: 't2', fields: { record_label: 'Warp' } },
  ], { source: 'beatport', ref: 'bp:1', lock: true })
  assert.ok(batch.batchId)
  assert.equal(batch.tracks.length, 2)
  assert.equal(store.provenance(d, 't1').record_label.source, 'beatport')
  assert.equal(store.provenance(d, 't1').record_label.locked, true)

  store.applyFields(d, 't2', { record_label: 'Hand Typed' }, { source: 'user' })
  const undone = store.undo(d, batch.batchId)
  assert.deepEqual(undone.tracks.map(track => track.id), ['t1'])
  assert.equal(row(d).record_label, 'Old Label')
  assert.equal(row(d).year, null)
  assert.equal(store.provenance(d, 't1').record_label.source, 'import')
  assert.equal(store.provenance(d, 't1').record_label.locked, false)
  assert.equal(store.provenance(d, 't1').year, undefined)
  assert.equal(row(d, 't2').record_label, 'Hand Typed')
})

test('editing the artist relinks the song to its artists', () => {
  const d = db()
  store.applyFields(d, 't1', { artist: 'Alice feat. Bob' }, { source: 'user' })
  const links = d.prepare("SELECT artist_id FROM artist_track_links WHERE track_id = 't1' ORDER BY artist_id").all().map(link => link.artist_id)
  assert.deepEqual(links, ['a-alice', 'a-bob'])
  const batch = store.applyMany(d, [{ trackId: 't1', fields: { artist: 'Carol' } }], { source: 'user' })
  store.undo(d, batch.batchId)
  assert.equal(row(d).artist, 'Alice feat. Bob')
  assert.deepEqual(d.prepare('SELECT id FROM artists ORDER BY id').all().map(artist => artist.id), ['a-alice', 'a-bob'])
})

test('marking a song instrumental drops its lyrics; title and artist are never emptied', () => {
  const d = db()
  d.prepare("INSERT INTO lyrics_cache (track_id, file_path) VALUES ('t1', '/music/a.flac')").run()
  store.applyFields(d, 't1', { instrumental: true, title: '  ', artist: null }, { source: 'user' })
  assert.equal(row(d).instrumental, 1)
  assert.equal(row(d).title, 'Song')
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM lyrics_cache').get().n, 0)
})

test('locks can be set and lifted by hand', () => {
  const d = db()
  store.setLock(d, 't1', 'genre', true)
  assert.equal(store.provenance(d, 't1').genres.locked, true)
  assert.deepEqual(store.applyFields(d, 't1', { genre: 'Pop' }, { source: 'itunes' }).changed, [])
  store.setLock(d, 't1', ['genre'], false)
  assert.deepEqual(store.applyFields(d, 't1', { genre: 'Pop' }, { source: 'itunes' }).changed.sort(), ['genre'])
})

test('the edit dialog and the batch editor go through the store', async () => {
  const d = db()
  assert.deepEqual(store.editTrack(d, 'nope', { title: 'x' }), { error: 'Track not found' })
  assert.deepEqual(store.editTrack(d, 't1', { nothing: 1 }), { error: 'No fields to update' })
  const saved = store.editTrack(d, 't1', { album: 'B-Sides', explicit: true })
  assert.equal(saved.success, true)
  assert.equal(saved.track.explicit, 1)
  assert.ok(saved.batchId)

  const tracks = await store.applyBatchOperations(d, ['t1', 't2'], { album: { mode: 'removeText', value: 'B-' }, year: { mode: 'fillMissing', value: 1999 } })
  assert.deepEqual(tracks.map(track => [track.id, track.album, track.year]), [['t1', 'Sides', 1999], ['t2', 'Album', 1999]])
  assert.equal(store.provenance(d, 't2').year.locked, true)
})

test('a merge moves the sources of what the kept copy took', () => {
  const d = db()
  store.applyFields(d, 't2', { year: 1990 }, { source: 'musicbrainz' })
  store.moveProvenance(d, 't2', 't1', ['year'])
  assert.equal(store.provenance(d, 't1').year.source, 'musicbrainz')
  assert.deepEqual(store.provenance(d, 't2'), {})
})

test('a rescan of a changed file keeps the user\'s edits (scanner)', async t => {
  const { initDB, getDB } = require('../electron/ipc/db')
  const { scanFolder } = require('../electron/ipc/scanner')
  const mm = require('../electron/musicMetadata')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-metadata-'))
  const previous = process.env.LOKAL_DATA_DIR
  process.env.LOKAL_DATA_DIR = path.join(dir, 'data')
  initDB()
  const real = getDB()
  t.after(() => {
    real.close()
    if (previous === undefined) delete process.env.LOKAL_DATA_DIR
    else process.env.LOKAL_DATA_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const music = path.join(dir, 'music')
  fs.mkdirSync(music)
  const file = path.join(music, 'song.mp3')
  fs.writeFileSync(file, 'synthetic audio')
  t.mock.method(mm, 'parseFile', async () => ({ common: { title: 'File Title', artist: 'File Artist', album: 'File Album', genre: ['Rock'] }, format: { duration: 200 } }))
  await scanFolder(music)
  const id = real.prepare('SELECT id FROM tracks WHERE file_path = ?').get(file).id
  store.editTrack(real, id, { title: 'My Title', artist: 'My Artist' })

  fs.writeFileSync(file, 'synthetic audio, re-tagged elsewhere')
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000))
  t.mock.method(mm, 'parseFile', async () => ({ common: { title: 'New File Title', artist: 'New File Artist', album: 'New Album', genre: ['Pop'] }, format: { duration: 200 } }))
  await scanFolder(music)
  const track = real.prepare('SELECT * FROM tracks WHERE file_path = ?').get(file)
  assert.equal(track.title, 'My Title')
  assert.equal(track.artist, 'My Artist')
  assert.equal(track.album, 'New Album')
  assert.equal(track.genre, 'Pop')
  const linked = real.prepare('SELECT a.name FROM artist_track_links l JOIN artists a ON a.id = l.artist_id WHERE l.track_id = ?').all(track.id).map(artist => artist.name)
  assert.deepEqual(linked, ['My Artist'])
})
