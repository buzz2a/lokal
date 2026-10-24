import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

const require = createRequire(import.meta.url)
const appleMusic = require('../electron/online/appleMusic.js')
appleMusic.developerToken = async () => 'dev-token'
const shazam = require('../electron/shazam.js')

function db(token = '') {
  const d = new DatabaseSync(':memory:')
  d.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  if (token) d.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('apple_music_user_token', token)
  return d
}

const song = (name, extra = {}) => ({
  id: name,
  attributes: {
    name, artistName: 'Artist', albumName: 'Album', durationInMillis: 181500, genreNames: ['House', 'Music'],
    artwork: { url: 'https://img/{w}x{h}bb.jpg' }, isrc: 'QZ1', releaseDate: '2026-03-30',
    playParams: { id: '42', kind: 'song' }, url: 'https://music.apple.com/song/42', ...extra,
  },
})

/** Answer each URL from `routes` (first matching prefix); record the requests. */
function stubFetch(routes) {
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers || {} })
    const hit = Object.entries(routes).find(([prefix]) => String(url).includes(prefix))
    const [status, body] = hit ? (typeof hit[1] === 'function' ? hit[1](String(url)) : hit[1]) : [404, {}]
    return new Response(JSON.stringify(body), { status })
  }
  return calls
}

test('trackOf maps an Apple Music song to an online song', () => {
  const track = shazam.trackOf(song('BAD TIMES'))
  assert.equal(track.title, 'BAD TIMES')
  assert.equal(track.duration, 182)
  assert.equal(track.genre, 'House')
  assert.equal(track.artwork_url, 'https://img/500x500bb.jpg')
  assert.equal(track.apple_music_id, '42')
  assert.equal(shazam.trackOf({ attributes: {} }), null)
  assert.equal(shazam.trackOf(song('Library', { playParams: { id: 'i.abc', kind: 'song' } })).apple_music_id, '')
})

test('locations lists worldwide first, then countries with their charts and cities', async () => {
  stubFetch({
    '/services/charts/locations': [200, {
      global: { top: { listid: 'pl.top' }, viral: { listid: 'pl.viral' }, genres: [{ name: 'Pop', listid: 'pl.pop' }] },
      countries: [
        { id: 'US', name: 'United States', listid: 'pl.us', momentum_listid: 'pl.us-rising', cities: [{ name: 'Seattle', listid: 'pl.sea' }, { name: 'Atlanta', listid: 'pl.atl' }], genres: [] },
        { id: 'FR', name: 'France', listid: 'pl.fr', viral: { listid: 'pl.fr-viral' }, cities: [], genres: [{ name: 'Pop', listid: 'pl.fr-pop' }] },
      ],
    }],
  })
  const { regions } = await shazam.locations()
  assert.deepEqual(regions.map(region => region.name), ['Worldwide', 'France', 'United States'])
  assert.deepEqual(regions[0].lists.map(list => list.kind), ['top', 'viral', 'genre'])
  assert.deepEqual(regions[1].lists.map(list => list.id), ['pl.fr', 'pl.fr-viral', 'pl.fr-pop'])
  assert.deepEqual(regions[2].lists.map(list => list.name), ['Top 200', 'Rising'])
  assert.deepEqual(regions[2].cities.map(city => city.name), ['Atlanta', 'Seattle'])
})

test('chart reads every page of songs from the country storefront', async () => {
  const calls = stubFetch({
    '/playlists/pl.fr/tracks?limit=100&offset=0': [200, { data: [song('One'), song('Two')], next: '/next' }],
    '/playlists/pl.fr/tracks?limit=100&offset=2': [200, { data: [song('Three')] }],
    '/playlists/pl.fr': [200, { data: [{ id: 'pl.fr', attributes: { name: 'Shazam France', lastModifiedDate: '2026-10-16', artwork: { url: 'https://c/{w}x{h}.jpg' } } }] }],
  })
  const chart = await shazam.chart(db(), 'pl.fr', 'FR')
  assert.equal(chart.name, 'Shazam France')
  assert.deepEqual(chart.tracks.map(track => track.title), ['One', 'Two', 'Three'])
  assert.ok(calls.every(call => call.url.includes('/v1/catalog/fr/')))
  assert.equal(calls[0].headers.Authorization, 'Bearer dev-token')
})

test('library keeps only the Shazam playlists of Apple Music, My Shazam Tracks first', async () => {
  assert.deepEqual(await shazam.library(db()), [])
  const calls = stubFetch({
    '/v1/me/library/playlists': [200, { data: [
      { id: 'p.1', attributes: { name: 'Road trip' } },
      { id: 'p.2', attributes: { name: 'Shazam Top 50' } },
      { id: 'p.3', attributes: { name: 'My Shazam Tracks' } },
    ] }],
  })
  const found = await shazam.library(db('user-token'))
  assert.deepEqual(found.map(entry => entry.id), ['p.3', 'p.2'])
  assert.equal(calls[0].headers['media-user-token'], 'user-token')
})

test('connect keeps a token Apple accepts and restores the previous one otherwise', async () => {
  const d = db('old-token')
  stubFetch({ '/v1/me/library/playlists': [403, {}] })
  const refused = await shazam.connect(d, 'media-user-token=bad;')
  assert.equal(refused.ok, false)
  assert.equal(d.prepare("SELECT value FROM settings WHERE key = 'apple_music_user_token'").get().value, 'old-token')

  stubFetch({ '/v1/me/library/playlists': [200, { data: [{ id: 'p.3', attributes: { name: 'My Shazam Tracks' } }] }] })
  assert.deepEqual(await shazam.connect(d, 'good'), { ok: true, connected: true, playlists: 1 })
  assert.equal(shazam.status(d).connected, true)
  assert.equal(shazam.disconnect(d).connected, false)
})

const local = require('../electron/shazamLibrary.js')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const EXPORT_CSV = 'Shazam Library\r\nIndex,TagTime,Title,Artist,URL,TrackKey\r\n1,2026-10-01T10:00:00Z,"Song, With Comma",Artist A,https://www.shazam.com/track/1,1\r\n2,2026-10-05T10:00:00Z,Newer Song,"Artist ""B""",https://www.shazam.com/track/2,2\r\n'

test('parseTags reads a Shazam export after its title line, quoted fields included', () => {
  const tags = local.parseTags(EXPORT_CSV)
  assert.deepEqual(tags.map(tag => [tag.title, tag.artist, tag.track_key]), [['Song, With Comma', 'Artist A', '1'], ['Newer Song', 'Artist "B"', '2']])
  assert.deepEqual(local.parseTags('nothing,here\n1,2'), [])
})

test('importExport takes a zip or a CSV, skips Shazams it already has, and lists them newest first', async () => {
  const AdmZip = require('adm-zip')
  const zip = new AdmZip()
  zip.addFile('Shazam/README.txt', Buffer.from('hello'))
  zip.addFile('Shazam/SyncedShazams.csv', Buffer.from(EXPORT_CSV))
  const d = db()
  const first = shazam.importExport(d, { name: 'shazam.zip', data: zip.toBuffer().toString('base64') })
  assert.equal(first.ok, true)
  assert.equal(first.added, 2)
  assert.equal(first.imported, 2)
  assert.equal(first.connected, true)
  const again = shazam.importExport(d, { name: 'SyncedShazams.csv', data: Buffer.from(EXPORT_CSV).toString('base64') })
  assert.deepEqual([again.added, again.total], [0, 2])
  assert.equal(shazam.importExport(d, { name: 'x.csv', data: Buffer.from('a,b\n1,2').toString('base64') }).ok, false)

  stubFetch({ '/v1/catalog/us/search': url => [200, { results: { songs: { data: url.includes('Newer') ? [song('Newer Song')] : [] } } }] })
  const list = await shazam.libraryPlaylist(d, 'imported')
  assert.deepEqual(list.tracks.map(track => track.title), ['Newer Song', 'Song, With Comma'])
  assert.equal(list.tracks[0].artwork_url, 'https://img/500x500bb.jpg')
  assert.equal(list.tracks[1].artwork_url, '')
  assert.equal(list.image, 'https://img/500x500bb.jpg')
  assert.deepEqual((await shazam.library(d)).map(item => item.id), ['imported'])

  shazam.disconnect(d, 'imported')
  assert.equal(shazam.status(d).imported, 0)
})

test('macTags reads the Shazam for Mac library, artists joined, Core Data dates converted', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-shazam-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dir = path.join(home, 'Library/Group Containers/4GWDBCF5A4.group.com.shazam/com.shazam.mac.Shazam')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'ShazamDataModel.sqlite')
  const store = new DatabaseSync(file)
  store.exec(`CREATE TABLE ZSHTAGRESULTMO (Z_PK INTEGER PRIMARY KEY, ZTRACKNAME TEXT, ZDATE REAL, ZTRACKKEY TEXT);
    CREATE TABLE ZSHARTISTMO (Z_PK INTEGER PRIMARY KEY, ZNAME TEXT, ZTAGRESULT INTEGER);
    INSERT INTO ZSHTAGRESULTMO VALUES (1, 'Windowlicker', 0, '42'), (2, '', 10, '43');
    INSERT INTO ZSHARTISTMO VALUES (1, 'Aphex Twin', 1), (2, 'Someone', 1);`)
  store.close()
  assert.equal(local.macDatabase(home), file)
  const tags = local.macTags(file)
  assert.equal(tags.length, 1)
  assert.equal(tags[0].title, 'Windowlicker')
  assert.match(tags[0].artist, /Aphex Twin/)
  assert.equal(tags[0].tagged_at, '2001-01-01T00:00:00.000Z')
  assert.equal(tags[0].url, 'https://www.shazam.com/track/42')
  assert.equal(local.macDatabase(path.join(home, 'nowhere')), '')
})

test('connect explains an Apple ID without an Apple Music subscription', async () => {
  stubFetch({ '/v1/me/library/playlists': [403, { errors: [{ detail: "User's subscription tier does not have access to privilege: CloudLibrary" }] }] })
  const result = await shazam.connect(db(), 'token')
  assert.equal(result.ok, false)
  assert.equal(result.noSubscription, true)
  assert.match(result.error, /no Apple Music subscription/)
})
