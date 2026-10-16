// Beatport (beatport.com): the user's playlists, the Top 100 and DJ charts,
// per genre. Shared by the desktop app (IPC) and the web server, so neither
// needs Electron.
//
// Beatport has no public developer sign-up for API v4. Like other open clients
// (beets-beatport4, beatportdl), Lokal signs in with the client ID of
// Beatport's own API docs page (api.beatport.com/v4/docs): log in, authorize,
// trade the code for a token. Only the token is kept (beatport_token, a
// secret setting), never the password. A token copied from the docs page
// (the JSON of its /auth/o/token/ request) works too, for when that flow
// changes.
//
// Songs come back in the shape of the online album pages ({ title, artist,
// album, duration, artwork_url }), so they play, queue and download from the
// playback sources like any other online song.

const ORIGIN = 'https://api.beatport.com'
const API = `${ORIGIN}/v4`
const REDIRECT_URI = `${API}/auth/o/post-message/`
const TOKEN_KEY = 'beatport_token'
const CLIENT_ID_KEY = 'beatport_client_id'
const REFRESH_MARGIN_MS = 60 * 1000
const GENRES_TTL_MS = 6 * 60 * 60 * 1000
const PLAYLIST_TRACK_LIMIT = 1000

// ---------------------------------------------------------------- settings

function getSetting(db, key) {
  try { return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '' } catch { return '' }
}

function setSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value ?? ''))
}

/** The stored token: { access_token, refresh_token, expires_at, username }, or null. */
function tokenOf(db) {
  try {
    const token = JSON.parse(getSetting(db, TOKEN_KEY) || 'null')
    return token?.access_token ? token : null
  } catch { return null }
}

function saveToken(db, json, username) {
  const previous = tokenOf(db)
  const token = {
    access_token: json.access_token,
    refresh_token: json.refresh_token || previous?.refresh_token || '',
    expires_at: Date.now() + (Number(json.expires_in) || 600) * 1000,
    username: username ?? previous?.username ?? '',
  }
  setSetting(db, TOKEN_KEY, JSON.stringify(token))
  return token
}

// ---------------------------------------------------------------- http

/** Why Beatport couldn't be reached, in words (a hosts-file block, say). */
function unreachable(error) {
  const cause = error?.cause || {}
  if (error?.name === 'AbortError') return 'Beatport did not answer in time.'
  if (cause.code === 'ECONNREFUSED' && /^127\.|^::1$/.test(cause.address || '')) {
    return 'api.beatport.com points to this computer (127.0.0.1). Remove its entry from the hosts file or blocker, then try again.'
  }
  return `Couldn't reach Beatport (${cause.code || error?.message || 'network error'}).`
}

/** One request; resolves to { status, ok, json, headers } (status 0 when unreachable). */
async function request(url, { method = 'GET', headers = {}, body, redirect = 'follow', timeoutMs = 15000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method, headers: { Accept: 'application/json', ...headers }, body, redirect, signal: controller.signal })
    const text = await res.text().catch(() => '')
    let json = {}
    try { json = text ? JSON.parse(text) : {} } catch { json = { text } }
    return { status: res.status, ok: res.ok, json, headers: res.headers }
  } catch (error) {
    return { status: 0, ok: false, json: {}, error: unreachable(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** Beatport's error text for a failed response. */
function errorText(r, fallback) {
  if (r.error) return r.error
  const json = r.json || {}
  const detail = json.detail || json.error_description || json.error || json.non_field_errors?.[0]
  return detail ? String(detail) : `${fallback} (Beatport answered ${r.status}).`
}

/** "name=value" pairs of a response's Set-Cookie headers, for the next request. */
function cookiesOf(headers) {
  const raw = typeof headers?.getSetCookie === 'function' ? headers.getSetCookie() : [headers?.get?.('set-cookie')].filter(Boolean)
  return raw.map(cookie => String(cookie).split(';')[0].trim()).filter(Boolean).join('; ')
}

// ---------------------------------------------------------------- auth

/** The docs page's public client ID (scraped once, then kept in the settings). */
async function clientId(db, { refresh = false } = {}) {
  const saved = getSetting(db, CLIENT_ID_KEY).trim()
  if (saved && !refresh) return saved
  const page = await request(`${API}/docs/`, { headers: { Accept: 'text/html' } })
  if (!page.ok) throw new Error(errorText(page, 'Could not open the Beatport API docs'))
  const html = page.json.text || ''
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(match => new URL(match[1], `${API}/docs/`).href)
  for (const src of [null, ...scripts]) {
    const text = src ? (await request(src, { headers: { Accept: '*/*' } })).json.text || '' : html
    const found = text.match(/API_CLIENT_ID\s*[:=]\s*['"]([^'"]+)['"]/)
    if (found) {
      setSetting(db, CLIENT_ID_KEY, found[1])
      return found[1]
    }
  }
  throw new Error('Could not find the Beatport client ID. Paste a token from the API docs page instead.')
}

/** Trade an authorization code (or a refresh token) for a token. */
async function tokenRequest(db, params) {
  const id = await clientId(db)
  const body = new URLSearchParams({ client_id: id, ...params })
  return request(`${API}/auth/o/token/`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })
}

/** The signed-in account's username (for the status line). */
async function accountName(accessToken) {
  const r = await request(`${API}/my/account/`, { headers: { Authorization: `Bearer ${accessToken}` } })
  return r.ok ? String(r.json.username || r.json.email || '') : ''
}

/** Sign in with a Beatport username and password; keeps only the token. */
async function login(db, username, password) {
  const user = String(username || '').trim()
  if (!user || !password) return { ok: false, error: 'Enter your Beatport username and password.' }
  let id
  try { id = await clientId(db) } catch (error) { return { ok: false, error: error.message } }

  const session = await request(`${API}/auth/login/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password }) })
  if (!session.ok) return { ok: false, error: session.status === 400 || session.status === 401 ? 'Beatport did not accept this username and password.' : errorText(session, 'Beatport sign-in failed') }
  const cookie = cookiesOf(session.headers)

  const query = new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: REDIRECT_URI })
  const authorize = await request(`${API}/auth/o/authorize/?${query}`, { headers: { Cookie: cookie }, redirect: 'manual' })
  const location = authorize.headers?.get?.('location') || ''
  const code = location ? new URL(location, ORIGIN).searchParams.get('code') : ''
  if (!code) return { ok: false, error: errorText(authorize, 'Beatport did not authorize Lokal') }

  const token = await tokenRequest(db, { code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI })
  if (!token.ok || !token.json.access_token) return { ok: false, error: errorText(token, 'Beatport did not issue a token') }
  const name = await accountName(token.json.access_token) || session.json.username || user
  saveToken(db, token.json, name)
  return { ok: true, username: name }
}

/**
 * Connect with a token copied from api.beatport.com/v4/docs: the JSON of its
 * /auth/o/token/ response, or the access token alone.
 */
async function connectToken(db, pasted) {
  const text = String(pasted || '').trim()
  if (!text) return { ok: false, error: 'Paste the token first.' }
  let json
  try { json = JSON.parse(text) } catch { json = { access_token: text.replace(/^Bearer\s+/i, '') } }
  if (!json?.access_token) return { ok: false, error: 'This is not a Beatport token: it has no access_token.' }
  const name = await accountName(json.access_token)
  if (!name) return { ok: false, error: 'Beatport did not accept this token (it may have expired).' }
  saveToken(db, json, name)
  return { ok: true, username: name }
}

function disconnect(db) {
  setSetting(db, TOKEN_KEY, '')
  return status(db)
}

function status(db) {
  const token = tokenOf(db)
  return { connected: !!token, username: token?.username || '' }
}

let refreshing = null

/** A valid access token, refreshed first when it has (nearly) expired. */
async function accessToken(db, { force = false } = {}) {
  const token = tokenOf(db)
  if (!token) throw Object.assign(new Error('Sign in to Beatport first (Settings › Integrations).'), { code: 'signed_out' })
  if (!force && token.expires_at - REFRESH_MARGIN_MS > Date.now()) return token.access_token
  if (!token.refresh_token) {
    if (!force) return token.access_token
    throw Object.assign(new Error('Your Beatport session has expired. Sign in again.'), { code: 'signed_out' })
  }
  refreshing ||= (async () => {
    try {
      const r = await tokenRequest(db, { grant_type: 'refresh_token', refresh_token: token.refresh_token })
      if (r.ok && r.json.access_token) return saveToken(db, r.json).access_token
      if (r.status === 0) throw new Error(r.error)
      throw Object.assign(new Error('Your Beatport session has expired. Sign in again.'), { code: 'signed_out' })
    } finally { refreshing = null }
  })()
  return refreshing
}

/** GET an API path as the signed-in user (one retry with a fresh token on 401). */
async function get(db, path, query = {}) {
  const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value != null && value !== ''))
  const url = `${API}${path}${params.size ? `?${params}` : ''}`
  let r = await request(url, { headers: { Authorization: `Bearer ${await accessToken(db)}` } })
  if (r.status === 401) r = await request(url, { headers: { Authorization: `Bearer ${await accessToken(db, { force: true })}` } })
  if (!r.ok) throw new Error(errorText(r, 'Beatport request failed'))
  return r.json
}

// ---------------------------------------------------------------- shapes

/** A Beatport image at `size` px square (its dynamic URI when it has one). */
function imageOf(image, size = 500) {
  if (!image) return ''
  if (image.dynamic_uri) return image.dynamic_uri.replace('{w}', size).replace('{h}', size)
  return image.uri || ''
}

/** A Beatport track as an online song (see onlineBrowse.js), with its DJ details. */
function trackOf(raw) {
  if (raw?.tombstoned) return null
  const track = raw?.track || raw
  const name = String(track?.name || '').trim()
  if (!name) return null
  // Some names already carry their mix ("III (Tribalista)", mix "Tribalista").
  const mix = String(track.mix_name || '').trim()
  const withMix = mix && !/^original mix$/i.test(mix) && !name.toLowerCase().includes(mix.toLowerCase())
  const artists = (track.artists || []).map(artist => artist.name).filter(Boolean)
  const key = track.key
  const camelot = key?.camelot_number && key?.camelot_letter ? `${key.camelot_number}${key.camelot_letter}` : ''
  return {
    title: withMix ? `${name} (${mix})` : name,
    artist: artists.join(', '),
    artists,
    album: track.release?.name || '',
    duration: Math.round((Number(track.length_ms) || 0) / 1000),
    artwork_url: imageOf(track.release?.image) || imageOf(track.image),
    bpm: Number(track.bpm) || null,
    key: key?.name || '',
    camelot,
    genre: track.genre?.name || '',
    label: track.release?.label?.name || track.label?.name || '',
    released: track.publish_date || track.new_release_date || '',
    isrc: track.isrc || '',
    beatport_id: track.id,
    beatport_url: track.slug ? `https://www.beatport.com/track/${track.slug}/${track.id}` : '',
  }
}

function chartOf(chart) {
  return {
    id: chart.id,
    name: chart.name || '',
    curator: chart.person?.owner_name || chart.artist?.name || chart.curator?.name || '',
    image: imageOf(chart.image),
    track_count: Number(chart.track_count) || 0,
    genres: (chart.genres || []).map(genre => genre.name).filter(Boolean),
    published: chart.publish_date || chart.change_date || '',
    url: `https://www.beatport.com/chart/${chart.slug || 'chart'}/${chart.id}`,
  }
}

function playlistOf(playlist) {
  return {
    id: playlist.id,
    name: playlist.name || '',
    image: imageOf(playlist.image) || imageOf(playlist.release_images?.[0]) || '',
    track_count: Number(playlist.track_count) || 0,
    updated: playlist.updated_date || playlist.created_date || '',
  }
}

const pageOf = (json, map) => ({
  items: (json.results || []).map(map).filter(Boolean),
  count: Number(json.count) || 0,
  next: !!json.next,
})

/** Every page of a track list, up to `limit` songs. */
async function allTracks(db, path, limit = PLAYLIST_TRACK_LIMIT) {
  const tracks = []
  for (let page = 1; tracks.length < limit; page++) {
    const json = await get(db, path, { page, per_page: 100 })
    tracks.push(...(json.results || []).map(trackOf).filter(Boolean))
    if (!json.next) break
  }
  return tracks.slice(0, limit)
}

// ---------------------------------------------------------------- catalog

let genresCache = null

/** Beatport's genres, A to Z: [{ id, name, slug }]. */
async function genres(db) {
  if (genresCache && genresCache.at > Date.now() - GENRES_TTL_MS) return genresCache.items
  // Sorted here: the genres endpoint rejects order_by=name.
  const json = await get(db, '/catalog/genres/', { per_page: 100 })
  const items = (json.results || []).filter(genre => genre.enabled !== false).map(genre => ({ id: genre.id, name: genre.name, slug: genre.slug || '' }))
    .sort((a, b) => a.name.localeCompare(b.name))
  genresCache = { at: Date.now(), items }
  return items
}

/** The Top 100 songs: of a genre, or of all Beatport. */
async function top(db, genreId) {
  const path = genreId ? `/catalog/genres/${encodeURIComponent(genreId)}/top/100/` : '/catalog/tracks/top/100/'
  const json = await get(db, path, { per_page: 100 })
  return (json.results || []).map(trackOf).filter(Boolean)
}

/** DJ charts, newest first, of a genre or all. */
async function charts(db, { genreId, page = 1, perPage = 24 } = {}) {
  const json = await get(db, '/catalog/charts/', { genre_id: genreId, page, per_page: perPage, order_by: '-publish_date' })
  return pageOf(json, chartOf)
}

async function chart(db, id) {
  const [info, tracks] = await Promise.all([get(db, `/catalog/charts/${encodeURIComponent(id)}/`), allTracks(db, `/catalog/charts/${encodeURIComponent(id)}/tracks/`)])
  return { ...chartOf(info), tracks }
}

/** The signed-in user's own playlists. */
async function playlists(db, { page = 1, perPage = 50 } = {}) {
  const json = await get(db, '/my/playlists/', { page, per_page: perPage })
  return pageOf(json, playlistOf)
}

async function playlist(db, id) {
  const [info, tracks] = await Promise.all([get(db, `/my/playlists/${encodeURIComponent(id)}/`), allTracks(db, `/my/playlists/${encodeURIComponent(id)}/tracks/`)])
  return { ...playlistOf(info), tracks }
}

/** Run a catalog call, answering { error, signedOut } instead of throwing. */
async function safe(work) {
  try { return await work() } catch (error) { return { error: error.message, signedOut: error.code === 'signed_out' } }
}

module.exports = {
  status, login, connectToken, disconnect,
  genres: db => safe(() => genres(db)),
  top: (db, genreId) => safe(() => top(db, genreId)),
  charts: (db, options) => safe(() => charts(db, options)),
  chart: (db, id) => safe(() => chart(db, id)),
  playlists: (db, options) => safe(() => playlists(db, options)),
  playlist: (db, id) => safe(() => playlist(db, id)),
  trackOf,
}
