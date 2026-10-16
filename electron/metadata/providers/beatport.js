// Beatport (the signed-in account, Settings › Integrations): the DJ details
// of electronic music: tempo, key, genre and sub-genre, label, mix name.

const beatport = require('../../beatport')
const { paced } = require('../queue')
const { parseKey } = require('../keys')

const GAP_MS = 250
const yearOf = date => (/^\d{4}/.test(String(date || '')) ? Number(String(date).slice(0, 4)) : null)

function genresOf(raw) {
  const list = [raw?.genre?.name, raw?.sub_genre?.name].filter(Boolean)
  return list.length ? list.join(', ') : null
}

function trackCandidate(raw) {
  const track = beatport.trackOf(raw)
  if (!track) return null
  const key = parseKey(raw.key)
  return {
    provider: 'beatport',
    ref: `beatport:track:${track.beatport_id}`,
    url: track.beatport_url || null,
    fields: {
      title: track.title || null,
      artist: track.artist || null,
      album: track.album || null,
      year: yearOf(track.released),
      track_num: Number(raw.number) || null,
      genre: track.genre || null,
      genres: genresOf(raw),
      record_label: track.label || null,
      isrc: track.isrc || null,
      tempo: track.bpm || null,
      track_key: key ? key.track_key : null,
      mode: key ? key.mode : null,
      duration: track.duration || null,
      artwork_url: track.artwork_url || null,
    },
  }
}

async function lookupTrack(query, ctx) {
  const text = [query.artist, query.title].filter(Boolean).join(' ')
  const found = await paced('beatport', ctx.gapMs ?? GAP_MS, () => beatport.findTracks(ctx.db, { isrc: query.isrc || '', query: text }))
  return found.map(trackCandidate).filter(Boolean)
}

function releaseCandidate(release, tracks = []) {
  const artists = (release.artists || []).map(artist => artist?.name).filter(Boolean)
  const first = tracks[0]
  return {
    provider: 'beatport',
    ref: `beatport:release:${release.id}`,
    url: release.slug ? `https://www.beatport.com/release/${release.slug}/${release.id}` : null,
    fields: {
      album: release.name || null,
      album_artist: artists.join(', ') || null,
      year: yearOf(release.new_release_date || release.publish_date),
      record_label: release.label?.name || null,
      genre: first?.genre?.name || null,
      artwork_url: beatport.imageOf(release.image) || null,
    },
    tracks: tracks.map(raw => {
      const candidate = trackCandidate(raw)
      return candidate ? { disc: null, fields: candidate.fields } : null
    }).filter(Boolean),
  }
}

async function lookupAlbum(query, ctx) {
  const text = [query.artist, query.album].filter(Boolean).join(' ')
  if (!query.album) return []
  const releases = await paced('beatport', ctx.gapMs ?? GAP_MS, () => beatport.findReleases(ctx.db, text))
  const result = []
  for (const found of releases.slice(0, 3)) {
    const { release, tracks } = await paced('beatport', ctx.gapMs ?? GAP_MS, () => beatport.releaseWithTracks(ctx.db, found.id))
    if (release?.id) result.push(releaseCandidate(release, tracks))
  }
  return result
}

module.exports = {
  id: 'beatport',
  label: 'Beatport',
  available: db => { try { return beatport.status(db).connected } catch { return false } },
  lookupTrack, lookupAlbum, trackCandidate, releaseCandidate,
}
