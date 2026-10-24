// Shazam (shazam.com): its charts (Top 200, viral and rising, per country,
// city and genre), its own playlists, and the user's Shazams. Shared by the
// desktop app (IPC) and the web server, so neither needs Electron.
//
// Shazam's charts and playlists are Apple Music playlists: shazam.com lists
// them (/services/charts/locations, no sign-in) and Apple Music's catalog
// holds their songs, read with the developer token of Apple's web player
// (online/appleMusic.js). The Shazam website no longer shows "My Shazam", so
// the user's Shazams come from (shazamLibrary.js) the data export of
// shazam.com/privacy, the Shazam app for Mac, or, with an Apple Music
// subscription, the "My Shazam Tracks" playlist the app syncs to the library
// (read with the media-user-token: apple_music_user_token, a secret setting
// shared with Followed artists).
//
// Songs come back in the shape of the online album pages ({ title, artist,
// album, duration, artwork_url }), so they play, queue and download from the
// playback sources like any other online song.

const appleMusic = require('./online/appleMusic')
const local = require('./shazamLibrary')

const SHAZAM = 'https://www.shazam.com'
const ORIGIN = 'https://music.apple.com'
const API = 'https://amp-api.music.apple.com'
const TOKEN_KEY = 'apple_music_user_token'
const CURATOR_ID = '1497216797' // "Shazam" on Apple Music
const LOCATIONS_TTL_MS = 6 * 60 * 60 * 1000
const CHART_TRACK_LIMIT = 200
const LIBRARY_TRACK_LIMIT = 5000
const CURATOR_PAGE = 10 // Apple's largest page for a curator's playlists
const SHAZAM_NAME = /shazam/i
const IMPORTED_ID = 'imported'
const MAC_ID = 'mac'
const ARTWORK_LIMIT = 150 // songs of an imported list matched to the catalog for their cover

// ---------------------------------------------------------------- settings

function getSetting(db, key) {
  try { return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '' } catch { return '' }
}

function setSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value ?? ''))
}

const userToken = db => appleMusic.userTokenValue(getSetting(db, TOKEN_KEY))

// ---------------------------------------------------------------- http

/** Why a service couldn't be reached, in words. */
function unreachable(error, name) {
  if (error?.name === 'AbortError') return `${name} did not answer in time.`
  return `Couldn't reach ${name} (${error?.cause?.code || error?.message || 'network error'}).`
}

/** One request; resolves to { status, ok, json } (status 0 when unreachable). */
async function request(url, { headers = {}, name = 'Shazam', timeoutMs = 15000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: controller.signal })
    const text = await res.text().catch(() => '')
    let json = {}
    try { json = text ? JSON.parse(text) : {} } catch { json = { text } }
    return { status: res.status, ok: res.ok, json }
  } catch (error) {
    return { status: 0, ok: false, json: {}, error: unreachable(error, name) }
  } finally {
    clearTimeout(timer)
  }
}

const signedOut = message => Object.assign(new Error(message), { code: 'signed_out' })

/**
 * GET an Apple Music API path: the catalog, or the library with `library`
 * (the user's media-user-token). One retry with a fresh developer token on 401.
 */
async function apple(db, path, { library = false } = {}) {
  const user = library ? userToken(db) : ''
  if (library && !user) throw signedOut('Link your Apple Music account first, to see your Shazams.')
  const call = async refresh => {
    const token = await appleMusic.developerToken({ refresh })
    return request(`${API}${path}`, { name: 'Apple Music', headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN, ...(user ? { 'media-user-token': user } : {}) } })
  }
  let r = await call(false)
  if (r.status === 401) r = await call(true)
  const detail = r.json?.errors?.[0]?.detail || ''
  // An Apple ID without an Apple Music subscription has no cloud library (and Shazam can't sync to it).
  if (library && /privilege|subscription/i.test(detail)) {
    throw Object.assign(new Error('This Apple ID has no Apple Music subscription, so Apple does not share its library. Import your Shazam data instead.'), { code: 'no_subscription' })
  }
  if (library && (r.status === 401 || r.status === 403)) throw signedOut('Apple Music did not accept the media-user-token. Copy a fresh one from music.apple.com.')
  if (r.error) throw new Error(r.error)
  if (r.status === 404) throw Object.assign(new Error('This list is not on Apple Music any more.'), { code: 'not_found' })
  if (!r.ok) throw new Error(detail || `Apple Music answered ${r.status}.`)
  return r.json
}

// ---------------------------------------------------------------- shapes

/** An Apple Music artwork at `size` px square. */
function imageOf(artwork, size = 500) {
  return artwork?.url ? artwork.url.replace('{w}', size).replace('{h}', size).replace('{f}', 'jpg') : ''
}

// Apple adds the store's word for "Music" to every song's genres.
const GENERIC_GENRE = /^(music|musique|musik|música|musica|muziek|musikk|музыка|音楽|音乐)$/i

/** An Apple Music song (catalog or library) as an online song (see onlineBrowse.js). */
function trackOf(raw) {
  const a = raw?.attributes
  const title = String(a?.name || '').trim()
  if (!title) return null
  const artist = String(a.artistName || '').trim()
  const catalogId = a.playParams?.catalogId || (a.playParams?.kind === 'song' && !String(a.playParams?.id || '').startsWith('i.') ? a.playParams.id : '')
  return {
    title,
    artist,
    artists: artist ? [artist] : [],
    album: a.albumName || '',
    duration: Math.round((Number(a.durationInMillis) || 0) / 1000),
    artwork_url: imageOf(a.artwork),
    genre: (a.genreNames || []).find(name => !GENERIC_GENRE.test(name)) || '',
    released: a.releaseDate || '',
    isrc: a.isrc || '',
    apple_music_id: catalogId || '',
    apple_music_url: a.url || '',
  }
}

/** A playlist (catalog or library) as a cover-grid item. */
function playlistOf(raw) {
  const a = raw?.attributes || {}
  return {
    id: raw.id,
    name: a.name || '',
    description: a.description?.short || a.description?.standard || '',
    image: imageOf(a.artwork),
    curator: a.curatorName || '',
    updated: a.lastModifiedDate || a.dateAdded || '',
    url: a.url || '',
  }
}

/** Every page of a playlist's songs, up to `limit`. */
async function allTracks(db, path, { limit, library = false }) {
  const tracks = []
  for (let offset = 0; tracks.length < limit;) {
    const json = await apple(db, `${path}?limit=100&offset=${offset}`, { library })
    const page = json.data || []
    tracks.push(...page.map(trackOf).filter(Boolean))
    if (!json.next || !page.length) break
    offset += page.length
  }
  return tracks.slice(0, limit)
}

/** Apple storefront of a chart: its country's, or the US store for worldwide lists. */
const storefrontOf = country => (/^[a-z]{2}$/i.test(String(country || '')) ? String(country).toLowerCase() : 'us')

async function catalogPlaylist(db, id, country) {
  const store = storefrontOf(country)
  const path = `/v1/catalog/${store}/playlists/${encodeURIComponent(id)}`
  const [info, tracks] = await Promise.all([apple(db, path), allTracks(db, `${path}/tracks`, { limit: CHART_TRACK_LIMIT })])
  return { ...playlistOf(info.data?.[0] || { id }), tracks }
}

// ---------------------------------------------------------------- charts

let locationsCache = null

const listOf = (entry, name, kind) => (entry?.listid ? { id: entry.listid, name, kind } : null)
const genresOf = list => (list || []).filter(genre => genre.listid).map(genre => ({ id: genre.listid, name: genre.name, kind: 'genre' }))

/**
 * Every Shazam chart, by place: { regions: [{ id, name, lists, cities }] },
 * worldwide first. Each list is { id (an Apple Music playlist), name, kind:
 * top | viral | rising | genre | city }.
 */
async function locations() {
  if (locationsCache && locationsCache.at > Date.now() - LOCATIONS_TTL_MS) return locationsCache.data
  const r = await request(`${SHAZAM}/services/charts/locations`)
  if (!r.ok) throw new Error(r.error || `Shazam answered ${r.status}.`)
  const global = r.json.global || {}
  const worldwide = {
    id: '',
    name: 'Worldwide',
    lists: [listOf(global.top, 'Top 200', 'top'), listOf(global.viral, 'Viral', 'viral'), ...genresOf(global.genres)].filter(Boolean),
    cities: [],
  }
  const countries = (r.json.countries || []).map(country => ({
    id: country.id,
    name: country.name || country.id,
    lists: [
      listOf(country, 'Top 200', 'top'),
      listOf(country.viral, 'Viral', 'viral'),
      country.momentum_listid ? { id: country.momentum_listid, name: 'Rising', kind: 'rising' } : null,
      ...genresOf(country.genres),
    ].filter(Boolean),
    cities: (country.cities || []).filter(city => city.listid).map(city => ({ id: city.listid, name: city.name, kind: 'city' })).sort((a, b) => a.name.localeCompare(b.name)),
  })).filter(country => country.lists.length).sort((a, b) => a.name.localeCompare(b.name))
  const data = { regions: [worldwide, ...countries] }
  locationsCache = { at: Date.now(), data }
  return data
}

/** A chart's songs, in chart order. `country` picks the Apple storefront. */
async function chart(db, id, country) {
  return catalogPlaylist(db, id, country)
}

// ---------------------------------------------------------------- playlists

/** Shazam's own playlists on Apple Music (Risers, Predictions, yearly Top 100s…). */
async function playlists(db, { page = 1, perPage = 20 } = {}) {
  const items = []
  let offset = (page - 1) * perPage
  let next = true
  while (items.length < perPage && next) {
    const json = await apple(db, `/v1/catalog/us/apple-curators/${CURATOR_ID}/playlists?limit=${CURATOR_PAGE}&offset=${offset}`)
    const found = json.data || []
    items.push(...found.map(playlistOf))
    offset += found.length
    next = !!json.next && found.length > 0
  }
  return { items, next }
}

async function playlist(db, id) {
  return catalogPlaylist(db, id, 'us')
}

// ---------------------------------------------------------------- my shazams

/** The Shazam playlists of the user's Apple Music library ("My Shazam Tracks" first). */
async function appleLibrary(db) {
  const found = []
  for (let offset = 0; offset < 1000;) {
    const json = await apple(db, `/v1/me/library/playlists?limit=100&offset=${offset}`, { library: true })
    const page = json.data || []
    found.push(...page.filter(entry => SHAZAM_NAME.test(entry.attributes?.name || '')).map(playlistOf))
    if (!json.next || !page.length) break
    offset += page.length
  }
  const mine = entry => (/^my shazam/i.test(entry.name) ? 0 : 1)
  return found.sort((a, b) => mine(a) - mine(b) || a.name.localeCompare(b.name))
}

/**
 * Every source of the user's Shazams: the imported Shazam data, the Shazam
 * app for Mac, and the Apple Music library. One that fails is left out
 * while another answers.
 */
async function library(db) {
  const items = []
  // The cover of a local list: its newest Shazam's, from the catalog.
  const cover = async tags => (await withArtwork(db, local.songsOf(tags).slice(0, 1)))[0]?.artwork_url || ''
  const imported = local.importedCount(db)
  if (imported) items.push({ id: IMPORTED_ID, name: 'My Shazams', description: `${imported} imported from your Shazam data`, image: await cover(local.importedTags(db)), track_count: imported })
  if (local.macDatabase()) {
    const tags = await Promise.resolve().then(() => local.macTags()).catch(() => [])
    items.push({ id: MAC_ID, name: 'My Shazams on this Mac', description: 'From the Shazam app for Mac', image: await cover(tags), track_count: tags.length })
  }
  if (userToken(db)) {
    try { items.push(...await appleLibrary(db)) } catch (error) { if (!items.length) throw error }
  }
  return items
}

// Catalog matches of Shazams that come without artwork (imported, Mac app), by song.
const matches = new Map()
const normal = text => String(text || '').toLowerCase().replace(/\(.*?\)|\[.*?\]|feat\..*$/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** Fill the artwork, album and length of the first `limit` songs from Apple Music's catalog (no subscription needed). */
async function withArtwork(db, tracks, limit = ARTWORK_LIMIT) {
  const todo = tracks.slice(0, limit).filter(track => !track.artwork_url)
  let next = 0
  const worker = async () => {
    while (next < todo.length) {
      const track = todo[next++]
      const key = `${normal(track.title)}|${normal(track.artist)}`
      if (!matches.has(key)) {
        const term = [track.artist, track.title].filter(Boolean).join(' ')
        const json = await apple(db, `/v1/catalog/us/search?term=${encodeURIComponent(term)}&types=songs&limit=5`).catch(() => null)
        const songs = (json?.results?.songs?.data || []).map(trackOf).filter(Boolean)
        const title = normal(track.title)
        matches.set(key, songs.find(song => normal(song.title) === title) || songs.find(song => normal(song.title).includes(title) || title.includes(normal(song.title))) || null)
      }
      const match = matches.get(key)
      if (match) Object.assign(track, { artwork_url: match.artwork_url, album: track.album || match.album, duration: track.duration || match.duration, isrc: match.isrc, apple_music_url: match.apple_music_url })
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  return tracks
}

async function libraryPlaylist(db, id) {
  if (id === IMPORTED_ID || id === MAC_ID) {
    const tags = id === IMPORTED_ID ? local.importedTags(db) : local.macTags()
    const tracks = await withArtwork(db, local.songsOf(tags))
    return {
      id,
      name: id === IMPORTED_ID ? 'My Shazams' : 'My Shazams on this Mac',
      description: id === IMPORTED_ID ? 'Imported from your Shazam data' : 'From the Shazam app for Mac',
      image: tracks.find(track => track.artwork_url)?.artwork_url || '',
      tracks,
    }
  }
  const path = `/v1/me/library/playlists/${encodeURIComponent(id)}`
  const [info, tracks] = await Promise.all([apple(db, path, { library: true }), allTracks(db, `${path}/tracks`, { limit: LIBRARY_TRACK_LIMIT, library: true })])
  return { ...playlistOf(info.data?.[0] || { id }), tracks }
}

// ---------------------------------------------------------------- account

/** Which sources of the user's Shazams are set up. */
function status(db) {
  const sources = { apple: !!userToken(db), imported: local.importedCount(db), mac: !!local.macDatabase() }
  return { connected: sources.apple || sources.imported > 0 || sources.mac, ...sources }
}

/** Link the Apple Music library with a media-user-token; checked before it is kept. */
async function connect(db, pasted) {
  const token = appleMusic.userTokenValue(pasted)
  if (!token) return { ok: false, error: 'Paste the media-user-token first.' }
  const previous = getSetting(db, TOKEN_KEY)
  setSetting(db, TOKEN_KEY, token)
  try {
    const found = await appleLibrary(db)
    return { ok: true, connected: true, playlists: found.length }
  } catch (error) {
    setSetting(db, TOKEN_KEY, previous)
    return { ok: false, error: error.message, noSubscription: error.code === 'no_subscription' }
  }
}

/** Unlink Apple Music (`apple`) or forget the imported Shazams (`imported`). */
function disconnect(db, source = 'apple') {
  if (source === 'imported') local.clearImported(db)
  else setSetting(db, TOKEN_KEY, '')
  return status(db)
}

function importExport(db, file) {
  const result = local.importExport(db, file)
  return result.ok ? { ...result, ...status(db) } : result
}

/** Run a call, answering { error, signedOut } instead of throwing. */
async function safe(work) {
  try { return await work() } catch (error) { return { error: error.message, signedOut: error.code === 'signed_out' } }
}

module.exports = {
  status, connect, disconnect, importExport,
  locations: () => safe(() => locations()),
  chart: (db, id, country) => safe(() => chart(db, id, country)),
  playlists: (db, options) => safe(() => playlists(db, options)),
  playlist: (db, id) => safe(() => playlist(db, id)),
  library: db => safe(() => library(db)),
  libraryPlaylist: (db, id) => safe(() => libraryPlaylist(db, id)),
  trackOf, imageOf,
}
