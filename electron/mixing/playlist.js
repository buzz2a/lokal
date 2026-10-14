// Magic Sort for a playlist (magicSort.js): its songs analysed first where
// they haven't been (AutoMix's analysis: tempo, key, loudness), then put in
// order and saved. Shared by the desktop app (electron/ipc/automix.js) and
// the web server (server/routes/playlists.js).

const { magicSort } = require('./magicSort')
const { unanalysed, analyseSongs, withAnalyses } = require('../automix/library')

const songsOf = (db, playlistId) => db.prepare(`
  SELECT t.*, pt.id AS playlist_track_id FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
  WHERE pt.playlist_id = ? ORDER BY pt.position, pt.id
`).all(playlistId)

/**
 * Reorder the playlist. `onProgress({ done, total })` while songs are
 * analysed. { songs, analysed (just now), known (songs with a key or tempo),
 * before, after (transition smoothness, 0–1) } or { error }.
 */
async function magicSortPlaylist(db, playlistId, { ffmpeg = () => null, log = () => {}, onProgress = () => {} } = {}) {
  const playlist = db.prepare('SELECT smart_rules FROM playlists WHERE id = ?').get(playlistId)
  if (!playlist) return { error: 'This playlist no longer exists.' }
  if (playlist.smart_rules) return { error: "A smart playlist's order comes from its rules." }
  let rows = songsOf(db, playlistId)
  if (rows.length < 3) return { error: 'Magic Sort needs at least three songs.' }

  const missing = ffmpeg() ? unanalysed(db, rows.map(row => row.id)) : []
  if (missing.length) {
    let done = 0
    onProgress({ done, total: missing.length })
    await analyseSongs(db, missing, { ffmpeg, log, onSong: () => onProgress({ done: ++done, total: missing.length }) })
    rows = songsOf(db, playlistId) // with the tempo and key the analysis filled in
  }

  const songs = withAnalyses(db, rows)
  const { order, before, after, known } = magicSort(songs)
  const place = db.prepare('UPDATE playlist_tracks SET position = ? WHERE id = ?')
  db.transaction(() => order.forEach((index, position) => place.run(position + 1, songs[index].playlist_track_id)))()
  return { songs: songs.length, analysed: missing.length, known, before, after }
}

module.exports = { magicSortPlaylist }
