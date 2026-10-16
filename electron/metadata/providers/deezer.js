// Deezer's public catalogue (no account): songs by ISRC or search, with
// tempo, release date, track number and cover; the album gives genre and label.

const { getJson } = require('../queue')

const API = 'https://api.deezer.com'
const GAP_MS = 120 // Deezer allows 50 requests every 5 seconds

const get = (url, ctx) => getJson('deezer', ctx.gapMs ?? GAP_MS, url, { fetchImpl: ctx.fetchImpl }).then(json => (json?.error ? null : json))
const yearOf = date => (/^\d{4}/.test(String(date || '')) && !String(date).startsWith('0000') ? Number(String(date).slice(0, 4)) : null)
const genresOf = album => (album?.genres?.data || []).map(genre => genre?.name).filter(Boolean)

function trackCandidate(track, album = null) {
  const genres = genresOf(album)
  const artists = (track.contributors || []).map(artist => artist?.name).filter(Boolean)
  return {
    provider: 'deezer',
    ref: `deezer:track:${track.id}`,
    url: track.link || `https://www.deezer.com/track/${track.id}`,
    fields: {
      title: track.title || null,
      artist: (artists.length ? artists.join(', ') : track.artist?.name) || null,
      album: track.album?.title || album?.title || null,
      album_artist: album?.artist?.name || null,
      year: yearOf(track.release_date || album?.release_date),
      track_num: Number(track.track_position) || null,
      genre: genres[0] || null,
      genres: genres.length ? genres.join(', ') : null,
      record_label: album?.label || null,
      isrc: track.isrc || null,
      tempo: Number(track.bpm) > 0 ? Number(track.bpm) : null,
      explicit: typeof track.explicit_lyrics === 'boolean' ? (track.explicit_lyrics ? 1 : 0) : null,
      duration: Number(track.duration) || null,
      artwork_url: track.album?.cover_xl || album?.cover_xl || null,
    },
  }
}

/** A song with its album's details (genre, label), from its full record. */
async function fullCandidate(id, ctx) {
  // "isrc:XXXX" as it is: Deezer doesn't read an encoded colon.
  const track = await get(`${API}/track/${String(id).replace(/[^\w:]/g, '')}`, ctx)
  if (!track?.id) return null
  const album = track.album?.id ? await get(`${API}/album/${encodeURIComponent(track.album.id)}`, ctx) : null
  return trackCandidate(track, album)
}

async function lookupTrack(query, ctx) {
  if (query.isrc) {
    const candidate = await fullCandidate(`isrc:${query.isrc}`, ctx)
    if (candidate) return [candidate]
  }
  if (!query.title) return []
  const q = [query.artist && `artist:"${query.artist}"`, `track:"${query.title}"`].filter(Boolean).join(' ')
  const found = await get(`${API}/search/track?${new URLSearchParams({ q, limit: '8' })}`, ctx)
  const results = []
  for (const track of (found?.data || []).slice(0, 4)) {
    const candidate = await fullCandidate(track.id, ctx).catch(() => null)
    results.push(candidate || trackCandidate(track))
  }
  return results
}

function albumCandidate(album) {
  const genres = genresOf(album)
  return {
    provider: 'deezer',
    ref: `deezer:album:${album.id}`,
    url: album.link || `https://www.deezer.com/album/${album.id}`,
    fields: {
      album: album.title || null,
      album_artist: album.artist?.name || null,
      year: yearOf(album.release_date),
      record_label: album.label || null,
      genre: genres[0] || null,
      genres: genres.length ? genres.join(', ') : null,
      artwork_url: album.cover_xl || null,
    },
    tracks: (album.tracks?.data || []).map((track, index) => ({
      disc: Number(track.disk_number) || null,
      fields: {
        title: track.title || null,
        artist: track.artist?.name || null,
        track_num: Number(track.track_position) || index + 1,
        isrc: track.isrc || null,
        duration: Number(track.duration) || null,
      },
    })),
  }
}

async function lookupAlbum(query, ctx) {
  if (!query.album) return []
  const q = [query.artist && `artist:"${query.artist}"`, `album:"${query.album}"`].filter(Boolean).join(' ')
  const found = await get(`${API}/search/album?${new URLSearchParams({ q, limit: '5' })}`, ctx)
  const releases = []
  for (const album of (found?.data || []).slice(0, 3)) {
    const full = await get(`${API}/album/${encodeURIComponent(album.id)}`, ctx)
    if (full?.id) releases.push(albumCandidate(full))
  }
  return releases
}

module.exports = { id: 'deezer', label: 'Deezer', available: () => true, lookupTrack, lookupAlbum, trackCandidate, albumCandidate }
