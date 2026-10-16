import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

const require = createRequire(import.meta.url)
const { parseKey, camelotName } = require('../electron/metadata/keys.js')
const { scoreTrack, matchTracks } = require('../electron/metadata/match.js')
const lookup = require('../electron/metadata/lookup.js')
const { applyChanges, fetchExternalArtwork } = require('../electron/metadata/apply.js')
const store = require('../electron/metadata/store.js')

function db() {
  const d = new DatabaseSync(':memory:')
  d.exec(`CREATE TABLE tracks (id TEXT PRIMARY KEY, file_path TEXT, title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT, album_artist TEXT,
      track_num INTEGER, year INTEGER, genre TEXT, genres TEXT, record_label TEXT, isrc TEXT, explicit INTEGER DEFAULT 0, instrumental INTEGER,
      track_key INTEGER, mode INTEGER, tempo REAL, duration REAL, artwork_path TEXT);
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL);
    CREATE TABLE artist_track_links (artist_id TEXT NOT NULL, track_id TEXT NOT NULL, PRIMARY KEY (artist_id, track_id));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`)
  const add = d.prepare('INSERT INTO tracks (id, file_path, title, artist, album, track_num, duration, isrc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  add.run('t1', '/m/1.flac', 'Windowlicker', 'Aphex Twin', 'Windowlicker', 1, 367, 'GBBPW9900001')
  add.run('t2', '/m/2.flac', 'Nannou', 'Aphex Twin', 'Windowlicker', 2, 252, null)
  return d
}

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body })
const image = () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]).buffer })

/** A fetch that answers by URL: [pattern, response] pairs, first match wins. */
function fakeFetch(routes, calls = []) {
  return async url => {
    const href = String(url)
    calls.push(href)
    for (const [pattern, answer] of routes) if (pattern.test(href)) return typeof answer === 'function' ? answer(href) : answer
    return json({}, 404)
  }
}

test('keys from any notation become track_key and mode', () => {
  assert.deepEqual(parseKey('8A'), { track_key: 9, mode: 0 })
  assert.deepEqual(parseKey('F#m'), { track_key: 6, mode: 0 })
  assert.deepEqual(parseKey('Eb Major'), { track_key: 3, mode: 1 })
  assert.deepEqual(parseKey('A♭ Minor'), { track_key: 8, mode: 0 })
  assert.deepEqual(parseKey('AM'), { track_key: 9, mode: 1 })
  assert.deepEqual(parseKey({ camelot_number: 8, camelot_letter: 'B', name: 'C Major' }), { track_key: 0, mode: 1 })
  assert.equal(parseKey('H dorian'), null)
  assert.equal(camelotName(9, 0), '8A')
})

test('results are scored against the song: ISRC first, then title, artist and length', () => {
  const query = { title: 'Windowlicker', artist: 'Aphex Twin', duration: 367, isrc: 'GBBPW9900001' }
  assert.ok(scoreTrack(query, { title: 'Windowlicker (Remaster)', artist: 'Aphex Twin', isrc: 'GBBPW9900001' }) >= 97)
  assert.ok(scoreTrack(query, { title: 'Windowlicker', artist: 'Aphex Twin', duration: 366 }) >= 95)
  assert.ok(scoreTrack(query, { title: 'Windowlicker', artist: 'Someone Else', duration: 200 }) < 60)
})

test('an album\'s songs are paired with a release\'s by number, title and length', () => {
  const local = [{ title: 'Nannou', track_num: 2, duration: 252 }, { title: 'Windowlicker', track_num: 1, duration: 367 }, { title: 'Bonus', track_num: 9 }]
  const release = [{ fields: { title: 'Windowlicker', track_num: 1, duration: 367 } }, { fields: { title: 'ΔMi−1 = −∂Σn=1NDi[n][Σj∈C[i]Fji[n − 1] + Fexti[n−1]]', track_num: 2, duration: 350 } }, { fields: { title: 'Nannou', track_num: 3, duration: 252 } }]
  assert.deepEqual(matchTracks(local, release).map(item => item.index), [2, 0, -1])
})

const routes = () => [
  [/musicbrainz\.org\/ws\/2\/isrc\/GBBPW9900001/, json({ recordings: [{ id: 'rec1', title: 'Windowlicker', length: 367000, 'artist-credit': [{ name: 'Aphex Twin' }],
    releases: [{ id: 'rel1', title: 'Windowlicker', date: '1999-03-22', status: 'Official', 'release-group': { 'primary-type': 'Single' } }] }] })],
  [/api\.deezer\.com\/track\/isrc:GBBPW9900001/, json({ id: 11, title: 'Windowlicker', duration: 368, isrc: 'GBBPW9900001', bpm: 126.5, track_position: 1, release_date: '1999-03-22',
    contributors: [{ name: 'Aphex Twin' }], album: { id: 22, title: 'Windowlicker', cover_xl: 'https://cdn.example/cover.jpg' } })],
  [/api\.deezer\.com\/album\/22/, json({ id: 22, title: 'Windowlicker', label: 'Warp Records', genres: { data: [{ name: 'Electro' }, { name: 'Dance' }] }, artist: { name: 'Aphex Twin' } })],
  [/itunes\.apple\.com\/search/, json({ error: 'busy' }, 503)],
]

test('one song asked of every source: best first, details read, a failing source reported', async () => {
  const d = db()
  const calls = []
  const result = await lookup.lookupTrack(d, 't1', { fetchImpl: fakeFetch(routes(), calls), gapMs: 0 })
  assert.deepEqual(result.providers, ['musicbrainz', 'deezer', 'itunes'], 'Beatport is skipped when not signed in')
  assert.deepEqual(result.errors, [{ provider: 'itunes', error: 'iTunes answered 503' }])
  assert.deepEqual(result.candidates.map(candidate => candidate.provider).sort(), ['deezer', 'musicbrainz'])
  const deezer = result.candidates.find(candidate => candidate.provider === 'deezer')
  assert.equal(deezer.score, 100)
  assert.equal(deezer.fields.tempo, 126.5)
  assert.equal(deezer.fields.record_label, 'Warp Records')
  assert.equal(deezer.fields.genres, 'Electro, Dance')
  assert.equal(deezer.fields.year, 1999)
  assert.equal(result.candidates.find(candidate => candidate.provider === 'musicbrainz').fields.artwork_url, 'https://coverartarchive.org/release/rel1/front-500')
  assert.ok(calls.some(url => url.includes('/isrc/')), 'the ISRC is looked up first')

  const searched = await lookup.lookupTrack(d, 't1', { fetchImpl: fakeFetch([[/./, json({})]], []), gapMs: 0, query: { title: 'Something Else' }, providers: ['musicbrainz'] })
  assert.equal(searched.query.isrc, null, 'a changed search does not use the ISRC')
  assert.equal(searched.query.title, 'Something Else')
})

test('an album asked of the sources comes back with its songs paired', async () => {
  const d = db()
  const fetchImpl = fakeFetch([
    [/musicbrainz\.org\/ws\/2\/release\/\?/, json({ releases: [{ id: 'r1' }] })],
    [/musicbrainz\.org\/ws\/2\/release\/r1/, json({ id: 'r1', title: 'Windowlicker', date: '1999', 'artist-credit': [{ name: 'Aphex Twin' }], 'label-info': [{ label: { name: 'Warp' } }],
      media: [{ position: 1, tracks: [{ position: 1, title: 'Windowlicker', length: 367000 }, { position: 2, title: 'ΔMi−1', length: 350000 }, { position: 3, title: 'Nannou', length: 252000 }] }] })],
    [/api\.deezer\.com\/search\/album/, json({ data: [] })],
    [/itunes\.apple\.com\/search/, json({ results: [] })],
  ])
  const result = await lookup.lookupAlbum(d, ['t2', 't1'], { fetchImpl, gapMs: 0 })
  assert.deepEqual(result.tracks.map(track => track.id), ['t1', 't2'])
  assert.equal(result.query.album, 'Windowlicker')
  const [release] = result.releases
  assert.equal(release.fields.record_label, 'Warp')
  assert.deepEqual(release.mapping.map(item => item.index), [0, 2])
  assert.ok(release.score >= 90)
})

test('apply writes the picked values and cover as one locked, undoable batch', async t => {
  const d = db()
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-apply-'))
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }))
  const fetchImpl = fakeFetch([[/cover\.jpg/, image()], [/broken/, json({}, 404)]])
  const result = await applyChanges(d, [
    { trackId: 't1', source: 'deezer', ref: 'deezer:track:11', fields: { tempo: 126.5, record_label: 'Warp Records', artwork_url: 'https://cdn.example/cover.jpg' } },
    { trackId: 't2', source: 'user', fields: { year: 1999, artwork_url: 'https://cdn.example/broken' } },
  ], { storageDir, fetchImpl })
  assert.equal(result.tracks.length, 2)
  assert.deepEqual(result.errors, ["Cover: The cover's server answered 404"])
  const t1 = d.prepare("SELECT * FROM tracks WHERE id = 't1'").get()
  assert.equal(t1.tempo, 126.5)
  assert.ok(fs.existsSync(t1.artwork_path))
  const prov = store.provenance(d, 't1')
  assert.equal(prov.record_label.source, 'deezer')
  assert.equal(prov.record_label.ref, 'deezer:track:11')
  assert.equal(prov.record_label.locked, true)
  assert.equal(prov.artwork_path.source, 'deezer')

  store.undo(d, result.batchId)
  const back = d.prepare("SELECT * FROM tracks WHERE id = 't1'").get()
  assert.equal(back.tempo, null)
  assert.equal(back.artwork_path, null)
  assert.equal(d.prepare("SELECT year FROM tracks WHERE id = 't2'").get().year, null)
})

test('"find artwork" takes a cover only from a result by the same artist', async t => {
  const d = db()
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-artwork-'))
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }))
  lookup._clearCache()
  const fetchImpl = fakeFetch([
    [/itunes\.apple\.com\/search/, json({ results: [
      { wrapperType: 'track', trackId: 1, trackName: 'Nannou', artistName: 'A Cover Band', artworkUrl100: 'https://img.example/wrong/100x100bb.jpg', primaryGenreName: 'Pop' },
      { wrapperType: 'track', trackId: 2, trackName: 'Nannou', artistName: 'Aphex Twin', trackTimeMillis: 252000, artworkUrl100: 'https://img.example/right/100x100bb.jpg', primaryGenreName: 'Electronic' },
    ] })],
    [/img\.example\/right\/600x600bb\.jpg/, image()],
  ])
  const result = await fetchExternalArtwork(d, 't2', {}, { storageDir, fetchImpl })
  assert.equal(result.success, true)
  assert.match(result.artworkPath, /t2\.itunes\./)
  assert.equal(store.provenance(d, 't2').artwork_path.locked, true)
})
