// Songs that can't be played: their file is gone, or the last attempt to play
// them failed (a file the player couldn't decode even after conversion, a
// stream no source could play). Library → "Songs with errors" lists them.

function ensure(db) {
  db.exec('CREATE TABLE IF NOT EXISTS track_errors (track_id TEXT PRIMARY KEY, message TEXT NOT NULL, at INTEGER NOT NULL)')
}

function recordTrackError(db, trackId, message) {
  if (!trackId) return false
  ensure(db)
  db.prepare('INSERT OR REPLACE INTO track_errors (track_id, message, at) VALUES (?, ?, ?)').run(String(trackId), String(message || "Couldn't play this song").slice(0, 300), Date.now())
  return true
}

function clearTrackError(db, trackId) {
  ensure(db)
  return db.prepare('DELETE FROM track_errors WHERE track_id = ?').run(String(trackId)).changes > 0
}

function trackErrors(db) {
  ensure(db)
  return new Map(db.prepare('SELECT track_id, message FROM track_errors').all().map(row => [row.track_id, row.message]))
}

/**
 * The tracks query for the library list. With `problems`, only songs that
 * can't be played, each with why (missing / playback_error); ordering and
 * paging then happen after the file check.
 */
// Sorts the library asks for; anything else falls back to the default
// rather than reaching ORDER BY (the web route passes the query string).
const SORT = /^(id|added_at|title|artist|album|album_artist|play_count|duration|year|last_modified|bitrate|track_num|tempo|camelot)(\s+(ASC|DESC))?$/i
// Tempo and key: songs without one last, whichever the direction. The key
// goes round the Camelot wheel (1A, 1B, 2A... 12B), from track_key/mode
// (see electron/mixing/camelot.js).
const { MAJOR, MINOR } = require('./mixing/camelot')
const CAMELOT_ORDER = `(CASE WHEN mode = 1 THEN (CASE track_key ${MAJOR.map((num, root) => `WHEN ${root} THEN ${num * 2 + 1}`).join(' ')} END) WHEN mode = 0 THEN (CASE track_key ${MINOR.map((num, root) => `WHEN ${root} THEN ${num * 2}`).join(' ')} END) END)`
const SORT_SQL = {
  tempo: direction => `COALESCE(tempo, 0) <= 0, tempo ${direction}`,
  camelot: direction => `${CAMELOT_ORDER} IS NULL, ${CAMELOT_ORDER} ${direction}`,
}
function safeSort(value) {
  const match = SORT.exec(String(value || '').trim())
  if (!match) return 'added_at DESC'
  const column = match[1].toLowerCase()
  const direction = (match[3] || 'ASC').toUpperCase()
  return SORT_SQL[column] ? SORT_SQL[column](direction) : `${column} ${direction}`
}
const truthy = value => value === true || value === 'true' || value === '1' || value === 1

function listTracks(db, opts, { where, params, exists }) {
  const { missingTrackFile } = require('./libraryTracks')
  // "Add songs" asks for up to 5,000 at once.
  const limit = Math.max(1, Math.min(5000, parseInt(opts.limit, 10) || 500))
  const offset = Math.max(0, parseInt(opts.offset, 10) || 0)
  const errors = trackErrors(db)
  const decorate = track => ({ ...track, missing: missingTrackFile(track, exists), ...(errors.has(String(track.id)) ? { playback_error: errors.get(String(track.id)) } : {}) })
  const problems = truthy(opts.problems)
  const clauses = [...where]
  // Hide phone uploads only if this desktop already has the same recording.
  // Filter in SQL, before LIMIT/OFFSET, to keep pagination consistent.
  const { shouldPreferDesktop, desktopPreferredLibraryClause } = require('./libraryDevicePreference')
  if (shouldPreferDesktop(opts) && !opts.hasRestrictiveFilters) clauses.push(desktopPreferredLibraryClause())
  if (problems) clauses.push("(file_path NOT LIKE 'ghost://%' OR id IN (SELECT track_id FROM track_errors))")
  let sql = 'SELECT * FROM tracks'
  if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ')
  sql += ` ORDER BY ${safeSort(opts.sort)}`
  if (!problems) return db.prepare(`${sql} LIMIT ${limit} OFFSET ${offset}`).all(...params).map(decorate)
  return db.prepare(sql).all(...params).map(decorate).filter(track => track.missing || track.playback_error).slice(offset, offset + limit)
}

module.exports = { recordTrackError, clearTrackError, trackErrors, listTracks, truthy, safeSort }
