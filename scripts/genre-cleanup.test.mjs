import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { genreKey as uiGenreKey, splitGenres as splitUiGenres } from '../src/genres.js'

const require = createRequire(import.meta.url)
const {
  normalizeGenreName,
  trackGenres,
  registerGenreFunctions,
  genreSummary,
} = require('../electron/genreList.js')

function fakeDb(rows) {
  let hasGenre
  return {
    function(name, options, fn) {
      assert.equal(name, 'lokal_has_genre')
      hasGenre = fn
    },
    prepare(sql) {
      assert.match(sql, /SELECT id, genre, genres, artwork_path FROM tracks/)
      return { all: () => rows }
    },
    get hasGenre() { return hasGenre },
  }
}

test('genre synonyms and subgenres fold into broad canonical categories', () => {
  assert.equal(normalizeGenreName('VGM'), 'Video Game Music')
  assert.equal(normalizeGenreName('video game'), 'Video Game Music')
  assert.equal(normalizeGenreName('Video Game Soundtrack'), 'Video Game Music')
  assert.equal(normalizeGenreName('Original Soundtrack'), 'Soundtrack')
  assert.equal(normalizeGenreName('EDM'), 'Electronic')
  assert.equal(normalizeGenreName('Techno'), 'Electronic')
  assert.equal(normalizeGenreName('Indie Rock'), 'Rock')
  assert.equal(normalizeGenreName('Hip-Hop'), 'Hip-Hop')
  assert.equal(normalizeGenreName('R&B'), 'R&B / Soul')
  assert.equal(normalizeGenreName('City Pop'), 'Pop')
  assert.equal(normalizeGenreName('Afro House'), 'Electronic')
  assert.equal(normalizeGenreName('UK Garage'), 'Electronic')
  assert.equal(normalizeGenreName('Amapiano'), 'Electronic')
  assert.equal(normalizeGenreName('Shoegaze'), 'Rock')
  assert.equal(normalizeGenreName('Raï'), 'World')
  assert.equal(normalizeGenreName('Unlisted niche genre'), 'Other')
})

test('genre editor treats synonyms as one choice while preserving the first raw label', () => {
  assert.equal(uiGenreKey('VGM'), uiGenreKey('Video Game Music'))
  assert.equal(uiGenreKey('Video Game'), uiGenreKey('Video Game Music'))
  assert.deepEqual(splitUiGenres('VGM, Video Game, Video Game Music'), ['VGM'])
})

test('invalid and non-genre metadata values are ignored', () => {
  assert.equal(normalizeGenreName('Karaoke_Plain'), null)
  assert.equal(normalizeGenreName('Instrumental'), null)
  assert.equal(normalizeGenreName('Unknown'), null)
  assert.equal(normalizeGenreName('255'), null)
  assert.deepEqual(trackGenres({ genre: 'Karaoke_Plain', genres: 'Unknown, 255, Instrumental' }), [])
})

test('Genres summary consolidates all known styles and repeated unknowns into broad families', () => {
  const rows = [
    { id: '1', genre: 'VGM', genres: '', artwork_path: '/covers/1.jpg' },
    { id: '2', genre: 'video game', genres: '', artwork_path: '/covers/2.jpg' },
    { id: '3', genre: 'Rock', genres: 'EDM', artwork_path: '/covers/3.jpg' },
    { id: '4', genre: 'Classic Rock', genres: '', artwork_path: '/covers/4.jpg' },
    { id: '5', genre: 'Indie Rock', genres: 'Techno', artwork_path: '/covers/5.jpg' },
    { id: '6', genre: 'House', genres: '', artwork_path: '/covers/6.jpg' },
    { id: '7', genre: 'Random Tag One', genres: '', artwork_path: '/covers/7.jpg' },
    { id: '8', genre: 'Random Tag Two', genres: '', artwork_path: '/covers/8.jpg' },
    { id: '9', genre: 'Baroque', genres: '', artwork_path: '/covers/9.jpg' },
    { id: '10', genre: 'Karaoke_Plain', genres: 'Unknown, 128', artwork_path: null },
    { id: '11', genre: 'Unknown', genres: '', artwork_path: null },
    { id: '12', genre: 'Future Jazz', genres: '', artwork_path: '/covers/12.jpg' },
    { id: '13', genre: 'future-jazz', genres: '', artwork_path: '/covers/13.jpg' },
  ]
  const db = fakeDb(rows)
  registerGenreFunctions(db)
  const summary = genreSummary(db)
  const byName = Object.fromEntries(summary.genres.map(item => [item.name, item]))
  assert.equal(byName['Video Game Music'].count, 2)
  assert.equal(byName.Rock.count, 3)
  assert.equal(byName.Electronic.count, 3)
  assert.equal(byName.Other.count, 2, 'only genuinely one-off unknown tags remain in Other')
  assert.equal(byName.Classical.count, 1, 'known genres remain visible for a single song')
  assert.equal(byName.Jazz.count, 2, 'future jazz variants belong in Jazz, not custom cards')
  assert.equal(byName['Future Jazz'], undefined)
  assert.equal(summary.none, 2)
  assert.equal(summary.genres.filter(item => item.count === 1).map(item => item.name).join(','), 'Classical')
  assert.equal(db.hasGenre('VGM', '', 'Video Game Music'), 1)
  assert.equal(db.hasGenre('video game', '', 'Video Game Music'), 1)
  assert.equal(db.hasGenre('Baroque', '', 'Other'), 0)
  assert.equal(db.hasGenre('Baroque', '', 'Classical'), 1)
  assert.equal(db.hasGenre('future-jazz', '', 'Jazz'), 1)
  assert.equal(db.hasGenre('Future Jazz', '', 'Other'), 0)
  assert.equal(db.hasGenre('Karaoke_Plain', 'Unknown, 128', ''), 1)
})

test('single unknown tags still remain in Other, not a sea of one-track categories', () => {
  const rows = [
    { id: '1', genre: 'One-off Name A', genres: '' },
    { id: '2', genre: 'One-off Name B', genres: '' },
    { id: '3', genre: 'Jazz', genres: '' },
    { id: '4', genre: 'Rock', genres: '' },
  ]
  const db = fakeDb(rows)
  registerGenreFunctions(db)
  const summary = genreSummary(db)
  const byName = Object.fromEntries(summary.genres.map(item => [item.name, item]))
  assert.equal(byName.Other.count, 2)
  assert.equal(byName.Jazz.count, 1)
  assert.equal(byName.Rock.count, 1)
  assert.equal(db.hasGenre('One-off Name A', '', 'Other'), 1)
  assert.equal(db.hasGenre('Jazz', '', 'Other'), 0)
  assert.equal(db.hasGenre('Jazz', '', 'Jazz'), 1)
})

test('recognized plus unknown multi-tags never duplicate a track in Other', () => {
  const db = fakeDb([
    { id: '1', genre: 'Rock; Made-Up Microstyle', genres: '' },
    { id: '2', genre: 'Rock', genres: '' },
    { id: '3', genre: 'Other', genres: '' },
    { id: '4', genre: 'Other', genres: '' },
  ])
  registerGenreFunctions(db)
  const summary = genreSummary(db)
  const byName = Object.fromEntries(summary.genres.map(item => [item.name, item]))
  assert.equal(byName.Rock.count, 2)
  assert.equal(byName.Other.count, 2)
  assert.equal(db.hasGenre('Rock; Made-Up Microstyle', '', 'Other'), 0)
})

test('unknown but recognizable subgenre names resolve to broad families', () => {
  const examples = [
    ['Future Jazz', 'Jazz'], ['experimental jazz quartet', 'Jazz'],
    ['deep melodic techno', 'Electronic'], ['minimal psychedelic trance', 'Electronic'],
    ['underground garage', 'Electronic'], ['jazz house', 'Electronic'],
    ['cinematic ambient', 'Ambient / New Age'], ['experimental drone', 'Ambient / New Age'],
    ['experimental shoegaze', 'Rock'], ['atmospheric black metal', 'Metal'],
    ['new-school boom bap', 'Hip-Hop'], ['alternative rap', 'Hip-Hop'],
    ['retro disco funk', 'R&B / Soul'], ['Future Soul', 'R&B / Soul'],
    ['gospel praise choir', 'Gospel & Christian'], ['vintage delta blues', 'Blues'],
    ['Afrobeat percussion', 'World'], ['modern samba', 'Latin'],
    ['traditional mariachi', 'Latin'], ['modern bluegrass', 'Country'],
    ['traditional Celtic folk', 'Folk'], ['concert orchestral classical', 'Classical'],
    ['J-pop', 'Pop'], ['indie shoegaze', 'Rock'],
    ['alternative jazz', 'Jazz'], ['alternative techno', 'Electronic'],
    ['indie', 'Indie / Alternative'], ['anime theme', 'Anime'], ['videogame soundtrack', 'Video Game Music'],
  ]
  for (const [tag, genre] of examples) {
    assert.equal(normalizeGenreName(tag), genre, tag)
  }
})

test('ambiguous, unknown and misleading names never spawn custom categories', () => {
  assert.equal(normalizeGenreName('Electronic Jazz'), 'Other')
  assert.equal(normalizeGenreName('Unlisted niche genre'), 'Other')
  assert.equal(normalizeGenreName('Rockstar Anthem'), 'Other',
    'Substring rock must not produce a false Rock match')
  assert.equal(normalizeGenreName('Synthpopcorn'), 'Other')
  assert.equal(normalizeGenreName('Unknown'), null)
  assert.equal(normalizeGenreName('Jazz Rap'), 'Hip-Hop', 'An explicit hybrid beats ambiguous hints')
  const db = fakeDb([
    { id: '1', genre: 'Unlisted niche genre', genres: '' },
    { id: '2', genre: 'Unlisted niche genre', genres: '' },
    { id: '3', genre: 'Deep deep techno', genres: '' },
    { id: '4', genre: 'Jazz House', genres: '' },
  ])
  registerGenreFunctions(db)
  const genres = genreSummary(db).genres
  assert.deepEqual(genres.map(x => x.name), ['Electronic', 'Other'])
  assert.equal(db.hasGenre('Unlisted niche genre', '', 'Other'), 1)
  assert.equal(db.hasGenre('Deep deep techno', '', 'Electronic'), 1)
})
