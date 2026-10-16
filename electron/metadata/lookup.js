// Fix Metadata's lookups: one song, or a whole album, asked of every online
// source at once (Beatport only when signed in). Results are scored against
// the song (match.js) and come back best first, with each source's error
// when it had one. Nothing is written here; see apply.js.

const store = require('./store')
const { scoreTrack, matchTracks, scoreRelease } = require('./match')

const PROVIDERS = {
  beatport: require('./providers/beatport'),
  musicbrainz: require('./providers/musicbrainz'),
  deezer: require('./providers/deezer'),
  itunes: require('./providers/itunes'),
}
const ORDER = ['beatport', 'musicbrainz', 'deezer', 'itunes']
const PER_PROVIDER = 6
const CACHE_MS = 15 * 60 * 1000
const CACHE_MAX = 200
const cache = new Map()

/** [{ id, label, available }] */
function listProviders(db) {
  return ORDER.map(id => ({ id, label: PROVIDERS[id].label, available: !!PROVIDERS[id].available(db) }))
}

function chosenProviders(db, wanted) {
  const ids = Array.isArray(wanted) && wanted.length ? ORDER.filter(id => wanted.includes(id)) : ORDER
  return ids.filter(id => PROVIDERS[id].available(db))
}

const text = value => (typeof value === 'string' ? value.trim() : '')

/** One source's answer, cached a while (the panel asks again when it reopens). */
async function ask(provider, kind, query, ctx) {
  const key = `${provider.id}\0${kind}\0${JSON.stringify(query)}`
  const hit = cache.get(key)
  if (hit && hit.at > Date.now() - CACHE_MS && !ctx.fetchImpl) return hit.value
  const value = await provider[kind](query, ctx)
  if (!ctx.fetchImpl) {
    cache.set(key, { at: Date.now(), value })
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  }
  return value
}

async function askAll(db, ids, kind, query, options) {
  const ctx = { db, fetchImpl: options.fetchImpl, gapMs: options.gapMs }
  const errors = []
  const answers = await Promise.all(ids.map(async id => {
    try { return { id, items: (await ask(PROVIDERS[id], kind, query, ctx)) || [] } } catch (error) {
      errors.push({ provider: id, error: `${PROVIDERS[id].label} ${error.message}` })
      return { id, items: [] }
    }
  }))
  return { answers, errors }
}

/**
 * Results for one song: { track, provenance, query, candidates: [{ provider,
 * ref, url, score, fields }], errors, providers }. `query` ({ title, artist,
 * album }) searches for something else than the song's own details; its ISRC
 * is used unless the search was changed.
 */
async function lookupTrack(db, trackId, options = {}) {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(String(trackId || ''))
  if (!track) return { error: 'Track not found' }
  const custom = options.query || {}
  const changed = ['title', 'artist', 'album'].some(field => text(custom[field]) && text(custom[field]) !== text(track[field]))
  const query = {
    title: text(custom.title) || track.title || '',
    artist: text(custom.artist) || track.artist || '',
    album: text(custom.album) || track.album || '',
    duration: Number(track.duration) || null,
    isrc: changed ? null : (track.isrc || null),
  }
  const ids = chosenProviders(db, options.providers)
  const { answers, errors } = await askAll(db, ids, 'lookupTrack', query, options)
  const candidates = answers.flatMap(({ items }) => items
    .filter(item => item?.fields)
    .map(item => ({ ...item, score: scoreTrack(query, item.fields) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, PER_PROVIDER))
    .sort((a, b) => b.score - a.score)
  return { track, provenance: store.provenance(db, track.id), query, candidates, errors, providers: ids }
}

const mostCommon = values => {
  const counts = new Map()
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''
}

/**
 * Releases for the album of `trackIds`: { tracks (local, in album order),
 * query, releases: [{ provider, ref, url, score, fields, tracks, mapping:
 * [{ index, score }] (one per local track) }], errors, providers }.
 */
async function lookupAlbum(db, trackIds = [], options = {}) {
  const ids = [...new Set((Array.isArray(trackIds) ? trackIds : []).map(String))]
  const tracks = ids.map(id => db.prepare('SELECT * FROM tracks WHERE id = ?').get(id)).filter(Boolean)
    .sort((a, b) => (Number(a.track_num) || 999) - (Number(b.track_num) || 999) || String(a.title).localeCompare(String(b.title)))
  if (!tracks.length) return { error: 'No songs to look up' }
  const custom = options.query || {}
  const query = {
    album: text(custom.album) || mostCommon(tracks.map(track => track.album)),
    artist: text(custom.artist) || mostCommon(tracks.map(track => track.album_artist || track.artist)),
  }
  const providerIds = chosenProviders(db, options.providers)
  const { answers, errors } = await askAll(db, providerIds, 'lookupAlbum', query, options)
  const releases = answers.flatMap(({ items }) => items.filter(item => item?.fields).map(release => {
    const mapping = matchTracks(tracks, release.tracks || [])
    return { ...release, mapping, score: scoreRelease(query, release, mapping) }
  })).sort((a, b) => b.score - a.score)
  return {
    tracks,
    provenance: Object.fromEntries(tracks.map(track => [track.id, store.provenance(db, track.id)])),
    query, releases, errors, providers: providerIds,
  }
}

/**
 * The cover and genre of a song that has none, for a download or the edit
 * dialog's "find artwork": the best iTunes result by that artist, else
 * MusicBrainz's. { artworkUrl, genre, source } or null.
 */
async function findArtworkAndGenre(db, { title, artist, duration = null }, options = {}) {
  const query = { title: text(title), artist: text(artist), duration }
  if (!query.title) return null
  for (const id of ['itunes', 'musicbrainz']) {
    try {
      const items = await ask(PROVIDERS[id], 'lookupTrack', query, { db, fetchImpl: options.fetchImpl, gapMs: options.gapMs })
      const best = (items || []).map(item => ({ ...item, score: scoreTrack(query, item.fields) }))
        .filter(item => item.score >= 70).sort((a, b) => b.score - a.score)[0]
      if (best && (best.fields.artwork_url || best.fields.genre)) return { artworkUrl: best.fields.artwork_url || null, genre: best.fields.genre || null, source: id }
    } catch {}
  }
  return null
}

module.exports = { PROVIDERS, listProviders, lookupTrack, lookupAlbum, findArtworkAndGenre, _clearCache: () => cache.clear() }
