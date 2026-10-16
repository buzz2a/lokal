// A song's artist text read as its artists ("A feat. B" is A and B), and the
// links that put the song on each artist's page. Shared by the scanner, the
// metadata store and the web server; nothing here needs Electron.

const KEEP_COMMA_DEFAULTS = [
  'tyler, the creator', 'earth, wind & fire', 'crosby, stills & nash',
  'crosby, stills, nash & young', 'simon & garfunkel', 'emerson, lake & palmer',
  'syd barrett', 'pete & bas', 'pe & ne',
]

function slugify(str) {
  return (str || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown'
}

/** Names whose comma is part of the name (the defaults plus Settings' list), lower case. */
function keepCommaArtists(db) {
  const keepComma = new Set(KEEP_COMMA_DEFAULTS)
  try {
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'keep_comma_artists'").get()
    if (setting?.value) {
      for (const artist of JSON.parse(setting.value)) keepComma.add(String(artist || '').toLowerCase().trim())
    }
  } catch {}
  return keepComma
}

function splitArtists(raw, keepComma = new Set(KEEP_COMMA_DEFAULTS)) {
  if (!raw) return []
  const lower = raw.toLowerCase().trim()
  for (const known of keepComma) {
    if (lower === known || lower.startsWith(known + ' ') || lower.endsWith(' ' + known)) return [raw.trim()]
  }
  const commaLowerPattern = /,\s+[a-z]/
  if (commaLowerPattern.test(raw)) return [raw.trim()]
  let artists = [raw]
  artists = artists.flatMap(a => a.split(/\s+(?:feat\.|ft\.|featuring)\s+/i))
  artists = artists.flatMap(a => a.split(/,\s+(?=[A-Z])/))
  artists = artists.flatMap(a => {
    const parts = a.split(/\s+(?:&|x|vs\.?)\s+/i)
    // A split that leaves one-letter pieces isn't a collaboration but one
    // stylised name ("h x m x d" was becoming the artists h, m and d).
    return parts.some(part => part.trim().length < 2) ? [a] : parts
  })
  return [...new Set(artists.map(a => a.trim()).filter(Boolean))]
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
    for (const name of splitArtists(artist, keepCommaArtists(db))) {
      const artistId = 'a-' + slugify(name)
      db.prepare('INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)').run(artistId, name)
      db.prepare('UPDATE artists SET name = ? WHERE id = ?').run(name, artistId)
      db.prepare('INSERT OR IGNORE INTO artist_track_links (artist_id, track_id) VALUES (?, ?)').run(artistId, trackId)
    }
  }
  if (cleanup) dropOrphanArtists(db)
}

function dropOrphanArtists(db) {
  db.prepare('DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM artist_track_links)').run()
}

module.exports = { slugify, keepCommaArtists, splitArtists, relinkTrackArtists, dropOrphanArtists }
