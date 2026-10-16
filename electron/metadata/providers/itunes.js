// iTunes Search (no account): songs and albums with genre, year, track
// number and a large cover. It answers about 20 searches a minute.

const { getJson } = require('../queue')

const API = 'https://itunes.apple.com'
const GAP_MS = 600

const get = (url, ctx) => getJson('itunes', ctx.gapMs ?? GAP_MS, url, { fetchImpl: ctx.fetchImpl })
const yearOf = date => (/^\d{4}/.test(String(date || '')) ? Number(String(date).slice(0, 4)) : null)
// "Music" is a placeholder, not a genre.
const genreOf = name => (name && String(name).trim().toLowerCase() !== 'music' ? String(name).trim() : null)
const bigCover = url => (url ? String(url).replace(/\/\d+x\d+bb\./, '/600x600bb.') : null)

function songCandidate(song) {
  return {
    provider: 'itunes',
    ref: `itunes:track:${song.trackId}`,
    url: song.trackViewUrl || null,
    fields: {
      title: song.trackName || null,
      artist: song.artistName || null,
      album: song.collectionName || null,
      album_artist: song.collectionArtistName || null,
      year: yearOf(song.releaseDate),
      track_num: Number(song.trackNumber) || null,
      genre: genreOf(song.primaryGenreName),
      explicit: song.trackExplicitness ? (song.trackExplicitness === 'explicit' ? 1 : 0) : null,
      duration: song.trackTimeMillis ? Math.round(song.trackTimeMillis / 1000) : null,
      artwork_url: bigCover(song.artworkUrl100),
    },
  }
}

async function lookupTrack(query, ctx) {
  if (!query.title) return []
  const term = [query.artist, query.title].filter(Boolean).join(' ').slice(0, 200)
  const data = await get(`${API}/search?${new URLSearchParams({ term, entity: 'song', limit: '10' })}`, ctx)
  return (data?.results || []).filter(result => result.wrapperType === 'track' || result.kind === 'song').map(songCandidate)
}

function albumCandidate(collection, songs = []) {
  return {
    provider: 'itunes',
    ref: `itunes:album:${collection.collectionId}`,
    url: collection.collectionViewUrl || null,
    fields: {
      album: collection.collectionName || null,
      album_artist: collection.artistName || null,
      year: yearOf(collection.releaseDate),
      genre: genreOf(collection.primaryGenreName),
      artwork_url: bigCover(collection.artworkUrl100),
    },
    tracks: songs.map(song => ({
      disc: Number(song.discNumber) || null,
      fields: {
        title: song.trackName || null,
        artist: song.artistName || null,
        track_num: Number(song.trackNumber) || null,
        duration: song.trackTimeMillis ? Math.round(song.trackTimeMillis / 1000) : null,
      },
    })),
  }
}

async function lookupAlbum(query, ctx) {
  if (!query.album) return []
  const term = [query.artist, query.album].filter(Boolean).join(' ').slice(0, 200)
  const data = await get(`${API}/search?${new URLSearchParams({ term, entity: 'album', limit: '5' })}`, ctx)
  const releases = []
  for (const collection of (data?.results || []).slice(0, 3)) {
    const found = await get(`${API}/lookup?${new URLSearchParams({ id: String(collection.collectionId), entity: 'song' })}`, ctx)
    const songs = (found?.results || []).filter(result => result.wrapperType === 'track')
    releases.push(albumCandidate(collection, songs))
  }
  return releases
}

module.exports = { id: 'itunes', label: 'iTunes', available: () => true, lookupTrack, lookupAlbum, songCandidate, albumCandidate }
