// MusicBrainz (no account): titles, artists, release, year, track number,
// ISRC and tags for songs; whole releases with their tracklist and label.
// Covers from the Cover Art Archive. One request a second, as it asks.

const { getJson } = require('../queue')
const { version } = require('../../../package.json')

const API = 'https://musicbrainz.org/ws/2'
const GAP_MS = 1100
const HEADERS = { 'User-Agent': `Lokal/${version} ( https://github.com/sipbuu/lokal )` }

const get = (url, ctx) => getJson('musicbrainz', ctx.gapMs ?? GAP_MS, url, { fetchImpl: ctx.fetchImpl, headers: HEADERS })
const quoted = value => `"${String(value || '').replace(/["\\]/g, '\\$&')}"`

const credit = list => (Array.isArray(list) ? list.map(part => `${part.name || part.artist?.name || ''}${part.joinphrase || ''}`).join('').trim() : '')
const yearOf = date => (/^\d{4}/.test(String(date || '')) ? Number(String(date).slice(0, 4)) : null)
const titleCase = text => String(text || '').replace(/\b\w/g, letter => letter.toUpperCase())
const cover = releaseId => (releaseId ? `https://coverartarchive.org/release/${releaseId}/front-500` : null)

function topGenre(item) {
  const list = [...(item?.genres || []), ...(item?.tags || [])].filter(tag => tag?.name)
  list.sort((a, b) => (b.count || 0) - (a.count || 0))
  return list.length ? titleCase(list[0].name) : null
}

/** The release to show a recording on: the song's own album if it's there, else an official album, earliest first. */
function pickRelease(releases = [], album = '') {
  const want = String(album || '').trim().toLowerCase()
  const score = release => (want && String(release.title || '').trim().toLowerCase() === want ? 4 : 0)
    + (release.status === 'Official' ? 2 : release.status === 'Bootleg' ? -2 : 0)
    + (release['release-group']?.['primary-type'] === 'Album' ? 1 : 0)
  return [...releases].sort((a, b) => score(b) - score(a) || String(a.date || '9999').localeCompare(String(b.date || '9999')))[0] || null
}

function recordingCandidate(recording, isrc = null, album = '') {
  const release = pickRelease(recording.releases, album)
  const track = release?.media?.[0]?.track?.[0]
  return {
    provider: 'musicbrainz',
    ref: `musicbrainz:recording:${recording.id}`,
    url: `https://musicbrainz.org/recording/${recording.id}`,
    fields: {
      title: recording.title || null,
      artist: credit(recording['artist-credit']) || null,
      album: release?.title || null,
      album_artist: credit(release?.['artist-credit']) || null,
      year: yearOf(recording['first-release-date']) || yearOf(release?.date),
      track_num: track?.number && /^\d+$/.test(track.number) ? Number(track.number) : null,
      genre: topGenre(recording),
      isrc: recording.isrcs?.[0] || isrc || null,
      duration: recording.length ? Math.round(recording.length / 1000) : null,
      artwork_url: cover(release?.id),
    },
  }
}

async function lookupTrack(query, ctx) {
  if (query.isrc) {
    const found = await get(`${API}/isrc/${encodeURIComponent(query.isrc)}?inc=artist-credits+releases&fmt=json`, ctx)
    const recordings = found?.recordings || []
    if (recordings.length) return recordings.slice(0, 5).map(recording => recordingCandidate(recording, query.isrc, query.album))
  }
  if (!query.title) return []
  const terms = [`recording:${quoted(query.title)}`, query.artist && `artist:${quoted(query.artist)}`].filter(Boolean).join(' AND ')
  const data = await get(`${API}/recording/?${new URLSearchParams({ query: terms, fmt: 'json', limit: '8' })}`, ctx)
  return (data?.recordings || []).map(recording => recordingCandidate(recording, null, query.album))
}

function releaseCandidate(release) {
  const media = release.media || []
  return {
    provider: 'musicbrainz',
    ref: `musicbrainz:release:${release.id}`,
    url: `https://musicbrainz.org/release/${release.id}`,
    fields: {
      album: release.title || null,
      album_artist: credit(release['artist-credit']) || null,
      year: yearOf(release.date),
      record_label: release['label-info']?.find(info => info?.label?.name)?.label.name || null,
      genre: topGenre(release),
      artwork_url: release['cover-art-archive']?.front === false ? null : cover(release.id),
    },
    tracks: media.flatMap(medium => (medium.tracks || []).map(track => ({
      disc: medium.position || null,
      fields: {
        title: track.title || track.recording?.title || null,
        artist: credit(track['artist-credit'] || track.recording?.['artist-credit']) || null,
        track_num: Number(track.position) || null,
        isrc: track.recording?.isrcs?.[0] || null,
        duration: (track.length || track.recording?.length) ? Math.round((track.length || track.recording.length) / 1000) : null,
      },
    }))),
  }
}

async function lookupAlbum(query, ctx) {
  if (!query.album) return []
  const terms = [`release:${quoted(query.album)}`, query.artist && `artist:${quoted(query.artist)}`].filter(Boolean).join(' AND ')
  const data = await get(`${API}/release/?${new URLSearchParams({ query: terms, fmt: 'json', limit: '5' })}`, ctx)
  const releases = []
  for (const found of (data?.releases || []).slice(0, 3)) {
    const release = await get(`${API}/release/${encodeURIComponent(found.id)}?inc=recordings+artist-credits+labels+isrcs+genres+tags&fmt=json`, ctx)
    if (release) releases.push(releaseCandidate(release))
  }
  return releases
}

module.exports = { id: 'musicbrainz', label: 'MusicBrainz', available: () => true, lookupTrack, lookupAlbum, recordingCandidate, releaseCandidate }
