// A song's artist text read as its artists ("A feat. B" is A and B), and the
// links that put the song on each artist's page. Shared by the scanner, the
// metadata store and the web server; nothing here needs Electron. Artist ids
// come from electron/artistId.js.

const { resolveArtistId } = require('../artistId')

const artistSplit = require('../artistSplit')

/** Names whose comma is part of the name (the defaults plus Settings' list), lower case. */
function keepCommaArtists(db) {
  let userList = []
  try {
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'keep_comma_artists'").get()
    if (setting?.value) userList = JSON.parse(setting.value)
  } catch {}
  return artistSplit.keepCommaSet(userList)
}

/** The artists of a credit, split with electron/artistSplit.js and the user's separator words. */
function splitArtists(raw, keepComma = artistSplit.keepCommaSet(), db = null) {
  if (!raw) return []
  if (db) artistSplit.applySplitWordsFrom(db)
  return artistSplit.splitArtists(raw, artistSplit.keepCommaSet([...keepComma]))
}

/**
 * Links the track to the artists of `artist` (replacing its old links) and
 * lifts a hand-made link lock: editing the artist re-parses the links.
 * Streamed (ghost://) tracks are never linked. `cleanup` drops artists left
 * without tracks.
 */
function relinkTrackArtists(db, trackId, artist, { cleanup = true } = {}) {
  db.prepare('DELETE FROM artist_track_links WHERE track_id = ?').run(trackId)
  try { db.prepare('DELETE FROM artist_link_locks WHERE track_id = ?').run(trackId) } catch {}
  const row = db.prepare('SELECT file_path FROM tracks WHERE id = ?').get(trackId)
  if (row && !String(row.file_path || '').startsWith('ghost://')) {
    for (const name of splitArtists(artist, keepCommaArtists(db), db)) {
      db.prepare('INSERT OR IGNORE INTO artist_track_links (artist_id, track_id) VALUES (?, ?)').run(resolveArtistId(db, name), trackId)
    }
  }
  if (cleanup) dropOrphanArtists(db)
}

function dropOrphanArtists(db) {
  db.prepare('DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM artist_track_links)').run()
}

module.exports = { keepCommaArtists, splitArtists, relinkTrackArtists, dropOrphanArtists }
