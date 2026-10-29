'use strict'

// Dedicated native Monochrome provider. Protocol based on the Monochrome
// Tracks API (https://github.com/monochrome-music/monochrome, Apache-2.0).
// The official instance exposes playable FLAC at /track/{trackId}.
const BASE = 'https://tracks.monochrome.st'
const TRACK_ID = /^\d{15,20}$/

function trackUrl(id) {
  if (!TRACK_ID.test(String(id))) throw new Error('Invalid Monochrome track ID')
  return `${BASE}/track/${id}`
}

function idFromUrl(value) {
  try {
    const url = new URL(value)
    const match = url.pathname.match(/^\/track\/(\d{15,20})\/?$/)
    return url.protocol === 'https:' && url.hostname === 'tracks.monochrome.st' &&
      !url.username && !url.password && match ? match[1] : null
  } catch { return null }
}

function normalizeTrack(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.trackId ?? raw.id ?? '')
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!TRACK_ID.test(id) || !title || raw.playable === false) return null
  const artists = Array.isArray(raw.artistNames)
    ? raw.artistNames.filter(name => typeof name === 'string' && name.trim()).slice(0, 8)
    : Array.isArray(raw.artists)
      ? raw.artists.map(a => a?.name).filter(name => typeof name === 'string' && name.trim()).slice(0, 8)
      : []
  const artwork = raw.artwork || raw.cover || ''
  let thumbnail = null
  try {
    const url = new URL(artwork)
    if (url.protocol === 'https:' && !url.username && !url.password) thumbnail = url.href
  } catch {}
  const duration = Number(raw.duration)
  return {
    provider: 'mono',
    id, title: title.slice(0, 500),
    artist: artists.join(', ') || 'Unknown Artist',
    artists,
    album: String(raw.albumTitle || raw.releaseTitle || '').slice(0, 500) || null,
    albumId: String(raw.releaseId || '') || null,
    duration: Number.isFinite(duration) && duration > 0
      ? (duration > 1000 ? Math.round(duration / 1000) : Math.round(duration)) : null,
    thumbnail,
    url: trackUrl(id),
    kind: 'song',
    isrc: typeof raw.isrc === 'string' ? raw.isrc : null,
    // This provider serves FLAC; bit depth and sample rate remain unknown
    // until the stream is measured by the playback/audio-quality pipeline.
    format: 'FLAC',
    quality: 'LOSSLESS',
  }
}

async function searchTracks(query, { limit = 20, fetchImpl = fetch, signal } = {}) {
  const q = String(query || '').trim()
  if (!q) return []
  if (q.length > 200) throw new Error('Search is limited to 200 characters.')
  const count = Math.max(1, Math.min(50, Number.isFinite(limit) ? Math.floor(limit) : 20))
  const url = new URL('/search/tracks', BASE)
  url.searchParams.set('q', q)
  url.searchParams.set('limit', String(count))
  // Bound a stalled public instance and never send YouTube cookies or add-on
  // credentials to Monochrome.
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(() => controller.abort(), 12000)
  try {
    // The public instance occasionally answers 5xx. One short retry matches
    // LunarTune's reliability approach without blocking another source for long.
    let response
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetchImpl(url.href, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
          redirect: 'error',
        })
        if (response.ok || attempt === 1 ||
            (response.status !== 429 && response.status < 500)) break
      } catch (error) {
        if (controller.signal.aborted || attempt === 1) throw error
      }
      if (controller.signal.aborted) throw new Error('Monochrome search was cancelled')
      await new Promise(resolve => setTimeout(resolve, 350))
    }
    if (!response?.ok) throw new Error(`Monochrome search returned HTTP ${response?.status || 503}`)
    const payload = await response.json()
    if (!Array.isArray(payload?.tracks)) throw new Error('Monochrome returned an unsupported catalogue response')
    const seen = new Set()
    return payload.tracks.slice(0, count).map(normalizeTrack)
      .filter(track => track && !seen.has(track.id) && seen.add(track.id))
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

function resolveStream(id) {
  return Promise.resolve({
    url: trackUrl(id),
    mime: 'audio/flac',
    preview: false,
  })
}

module.exports = { BASE, TRACK_ID, trackUrl, idFromUrl, normalizeTrack, searchTracks, resolveStream }
