// A song's details (title, artist, genre, tempo...) and where each one came
// from: its file, the user, an import, the analysis, or an online source.
// Every change to them goes through applyFields, so:
//   - what the user sets is locked: rescans, imports and online lookups
//     leave it alone (until the lock is lifted)
//   - a rescan doesn't wipe what another source filled in where the file
//     has nothing
//   - edits and applied lookups can be undone (track_meta_history)
// Details stay in the database; files are never written.
//
// Tables:
//   track_field_meta   (track_id, field) -> source, ref, confidence, locked.
//                      No row: the value came from the file (or isn't known).
//   track_meta_history one row per changed field, grouped by batch_id.
//
// Shared by the desktop app (IPC) and the web server; nothing here needs Electron.

const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const { relinkTrackArtists, dropOrphanArtists } = require('./artists')

const FIELD_TYPES = {
  title: 'text', artist: 'text', album: 'text', album_artist: 'text',
  track_num: 'int', year: 'int', genre: 'text', genres: 'genres',
  record_label: 'text', isrc: 'isrc', explicit: 'flag', instrumental: 'flag?',
  danceability: 'real', energy: 'real', track_key: 'int', loudness: 'real', mode: 'int',
  speechiness: 'real', acousticness: 'real', instrumentalness: 'real', liveness: 'real',
  valence: 'real', tempo: 'real', time_signature: 'int', artwork_path: 'text',
}
const FIELDS = Object.keys(FIELD_TYPES)
// Values that only make sense together: locked, sourced and undone as one.
const GROUPS = [['genre', 'genres'], ['track_key', 'mode']]
const NOT_NULL = new Set(['title', 'artist'])
const SOURCES = new Set(['file', 'user', 'import', 'analysis', 'download', 'merge', 'itunes', 'musicbrainz', 'deezer', 'beatport'])

const groupOf = field => GROUPS.find(group => group.includes(field)) || [field]

const ensured = new WeakSet()

function ensureTables(db) {
  if (ensured.has(db)) return
  db.exec(`CREATE TABLE IF NOT EXISTS track_field_meta (
    track_id TEXT NOT NULL, field TEXT NOT NULL, source TEXT NOT NULL, ref TEXT,
    confidence REAL, locked INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
    PRIMARY KEY (track_id, field))`)
  db.exec(`CREATE TABLE IF NOT EXISTS track_meta_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, track_id TEXT NOT NULL,
    field TEXT NOT NULL, old_value TEXT, new_value TEXT, old_source TEXT, old_locked INTEGER,
    source TEXT NOT NULL, at INTEGER NOT NULL)`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_track_meta_history_batch ON track_meta_history(batch_id)')
  ensured.add(db)
}

function inTransaction(db, work) {
  if (typeof db.transaction === 'function') return db.transaction(work)()
  if (db.isTransaction) return work()
  db.exec('BEGIN')
  try { const result = work(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
}

// ---------------------------------------------------------------- values

function normalizeGenres(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',')
  return [...new Set(list.map(part => String(part ?? '').trim()).filter(Boolean))].join(', ') || null
}
const firstGenre = value => normalizeGenres(value)?.split(',')[0].trim() || null

function normalizeValue(field, value) {
  const type = FIELD_TYPES[field]
  const blank = value === null || value === undefined || value === ''
  if (type === 'flag') return value ? 1 : 0
  if (type === 'flag?') return blank ? null : (value ? 1 : 0)
  if (blank) return null
  if (type === 'int' || type === 'real') {
    const number = Number(value)
    if (!Number.isFinite(number)) return null
    return type === 'int' ? Math.round(number) : number
  }
  if (type === 'genres') return normalizeGenres(value)
  if (type === 'isrc') {
    const isrc = String(value).replace(/[\s-]/g, '').toUpperCase()
    return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc) ? isrc : null
  }
  return String(value).trim().slice(0, 1000) || null
}

const empty = value => value === null || value === undefined || value === ''
const same = (left, right) => (empty(left) && empty(right)) || String(left) === String(right)

/**
 * The normalized values `input` sets on `track`. Genre and genres move
 * together: genres is the list, genre its first (or the chosen) one.
 */
function resolveValues(track, input = {}) {
  const values = {}
  for (const field of FIELDS) {
    if (field === 'genre' || field === 'genres') continue
    if (input[field] !== undefined) values[field] = normalizeValue(field, input[field])
  }
  if (input.genre !== undefined || input.genres !== undefined) {
    const genres = input.genres !== undefined
      ? normalizeGenres(input.genres)
      : normalizeGenres(track.genres || input.genre || track.genre)
    values.genres = genres
    values.genre = input.genre !== undefined ? (normalizeValue('genre', input.genre) || firstGenre(genres)) : firstGenre(genres)
  }
  return values
}

// ---------------------------------------------------------------- provenance

function metaRows(db, trackId) {
  const rows = db.prepare('SELECT * FROM track_field_meta WHERE track_id = ?').all(trackId)
  return Object.fromEntries(rows.map(row => [row.field, row]))
}

/** { field: { source, ref, confidence, locked, updated_at } } for the fields with a known source. */
function provenance(db, trackId) {
  ensureTables(db)
  const result = {}
  for (const [field, row] of Object.entries(metaRows(db, String(trackId)))) {
    result[field] = { source: row.source, ref: row.ref, confidence: row.confidence, locked: !!row.locked, updated_at: row.updated_at }
  }
  return result
}

const isLocked = (meta, field) => groupOf(field).some(member => meta[member]?.locked)

/** Lock or unlock fields (with the values that go with them). */
function setLock(db, trackId, fields, locked = true) {
  ensureTables(db)
  const id = String(trackId)
  const wanted = new Set((Array.isArray(fields) ? fields : [fields]).flatMap(groupOf).filter(field => FIELD_TYPES[field]))
  inTransaction(db, () => {
    for (const field of wanted) {
      const row = db.prepare('SELECT 1 FROM track_field_meta WHERE track_id = ? AND field = ?').get(id, field)
      if (row) db.prepare('UPDATE track_field_meta SET locked = ? WHERE track_id = ? AND field = ?').run(locked ? 1 : 0, id, field)
      else if (locked) db.prepare('INSERT INTO track_field_meta (track_id, field, source, locked, updated_at) VALUES (?, ?, ?, 1, ?)').run(id, field, 'file', Date.now())
    }
  })
  return provenance(db, id)
}

function writeMeta(db, trackId, field, { source, ref = null, confidence = null, locked = 0 }) {
  db.prepare(`INSERT OR REPLACE INTO track_field_meta (track_id, field, source, ref, confidence, locked, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(trackId, field, source, ref == null ? null : String(ref), confidence == null ? null : Number(confidence), locked ? 1 : 0, Date.now())
}

// ---------------------------------------------------------------- writing

function sideEffects(db, track, changed, { cleanup = true } = {}) {
  if (Object.prototype.hasOwnProperty.call(changed, 'artist')) relinkTrackArtists(db, track.id, changed.artist, { cleanup })
  if (changed.instrumental === 1) {
    // Instrumental songs skip lyrics lookups: what was found before goes.
    for (const table of ['lyrics_cache', 'lyrics_translations']) {
      try { db.prepare(`DELETE FROM ${table} WHERE track_id = ?`).run(track.id) } catch {}
    }
    try { if (track.file_path) db.prepare('DELETE FROM lyrics_cache WHERE file_path = ?').run(track.file_path) } catch {}
  }
}

/**
 * Sets `input` ({ field: value }) on a track, from `source`.
 *   source      'user' (locks what it sets), 'file', 'import', 'analysis', a provider id...
 *   overwrite   false: only fills fields that are empty
 *   lock        lock what's set (default: when the user sets it)
 *   batchId     groups the change with others for undo (history is kept for
 *               the user's changes and for batches)
 * Locked fields are only changed by the user. A file never clears a value
 * another source filled in.
 * Returns { changed: [fields], skipped: [fields], track }.
 */
function applyFields(db, trackId, input = {}, options = {}) {
  ensureTables(db)
  const { source = 'user', ref = null, confidence = null, overwrite = true, cleanup = true } = options
  const lock = options.lock ?? source === 'user'
  const history = options.history ?? (source === 'user' || !!options.batchId)
  const batchId = options.batchId || (history ? randomUUID() : null)
  if (!SOURCES.has(source)) throw new Error(`Unknown metadata source: ${source}`)
  const id = String(trackId)
  return inTransaction(db, () => {
    const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id)
    if (!track) return { changed: [], skipped: [], track: null }
    const meta = metaRows(db, id)
    const values = resolveValues(track, input)
    const changed = {}
    const skipped = []
    for (const [field, value] of Object.entries(values)) {
      if (!(field in track)) continue
      const blocked = (NOT_NULL.has(field) && value === null)
        || (source !== 'user' && isLocked(meta, field))
        || (!overwrite && !empty(track[field]))
        || (source === 'file' && value === null && meta[field] && meta[field].source !== 'file')
      if (blocked) { skipped.push(field); continue }
      if (same(track[field], value)) {
        // Confirming the value the song already has still says where it's from.
        if (source !== 'file' && meta[field]?.source !== source && (lock || !meta[field]?.locked)) {
          writeMeta(db, id, field, { source, ref, confidence, locked: lock || meta[field]?.locked })
        }
        continue
      }
      changed[field] = value
    }
    const fields = Object.keys(changed)
    if (fields.length) {
      db.prepare(`UPDATE tracks SET ${fields.map(field => `${field} = ?`).join(', ')} WHERE id = ?`).run(...fields.map(field => changed[field]), id)
      const now = Date.now()
      for (const field of fields) {
        const before = meta[field]
        if (history) {
          db.prepare(`INSERT INTO track_meta_history (batch_id, track_id, field, old_value, new_value, old_source, old_locked, source, at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(batchId, id, field, JSON.stringify(track[field] ?? null), JSON.stringify(changed[field]), before?.source ?? null, before ? before.locked : null, source, now)
        }
        if (source === 'file') db.prepare('DELETE FROM track_field_meta WHERE track_id = ? AND field = ?').run(id, field)
        else writeMeta(db, id, field, { source, ref, confidence, locked: lock || before?.locked })
      }
      sideEffects(db, track, changed, { cleanup })
    }
    return { changed: fields, skipped, track: db.prepare('SELECT * FROM tracks WHERE id = ?').get(id), batchId: fields.length && history ? batchId : null }
  })
}

/**
 * Several tracks' changes ([{ trackId, fields, source?, ref?, confidence? }])
 * as one undoable batch. Returns { batchId, tracks (the changed ones), changed (count of fields) }.
 */
function applyMany(db, changes = [], options = {}) {
  ensureTables(db)
  const batchId = options.batchId || randomUUID()
  return inTransaction(db, () => {
    const tracks = []
    let count = 0
    for (const change of Array.isArray(changes) ? changes : []) {
      if (!change?.trackId) continue
      const result = applyFields(db, change.trackId, change.fields || {}, {
        ...options,
        ...(change.source ? { source: change.source } : {}),
        ref: change.ref ?? options.ref ?? null,
        confidence: change.confidence ?? options.confidence ?? null,
        batchId,
        cleanup: false,
      })
      if (result.changed.length) { tracks.push(result.track); count += result.changed.length }
    }
    dropOrphanArtists(db)
    return { batchId: count ? batchId : null, tracks, changed: count }
  })
}

/** Puts back what a batch changed, where nothing changed it since. Returns { tracks }. */
function undo(db, batchId) {
  ensureTables(db)
  return inTransaction(db, () => {
    const rows = db.prepare('SELECT * FROM track_meta_history WHERE batch_id = ? ORDER BY id DESC').all(String(batchId || ''))
    const touched = new Map()
    for (const row of rows) {
      const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(row.track_id)
      if (!track || !(row.field in track)) continue
      const newValue = JSON.parse(row.new_value)
      if (!same(track[row.field], newValue)) continue
      const oldValue = JSON.parse(row.old_value)
      db.prepare(`UPDATE tracks SET ${row.field} = ? WHERE id = ?`).run(oldValue, row.track_id)
      if (row.old_source == null) db.prepare('DELETE FROM track_field_meta WHERE track_id = ? AND field = ?').run(row.track_id, row.field)
      else writeMeta(db, row.track_id, row.field, { source: row.old_source, locked: row.old_locked })
      if (!touched.has(row.track_id)) touched.set(row.track_id, {})
      touched.get(row.track_id)[row.field] = oldValue
    }
    for (const [trackId, changed] of touched) {
      const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId)
      sideEffects(db, track, changed, { cleanup: false })
    }
    dropOrphanArtists(db)
    db.prepare('DELETE FROM track_meta_history WHERE batch_id = ?').run(String(batchId || ''))
    return { tracks: [...touched.keys()].map(id => db.prepare('SELECT * FROM tracks WHERE id = ?').get(id)).filter(Boolean) }
  })
}

/**
 * What a rescan may write over an existing track: `values` (the file's,
 * in the tracks table's columns) with locked fields, and empty file fields
 * another source filled in, kept as they are. Fields the file does change
 * are from the file again.
 */
function keepProtectedFields(db, trackId, values) {
  ensureTables(db)
  const id = String(trackId)
  const meta = metaRows(db, id)
  if (!Object.keys(meta).length) return values
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id)
  if (!track) return values
  const result = { ...values }
  for (const field of Object.keys(values)) {
    if (!FIELD_TYPES[field] || !(field in track)) continue
    const fromElsewhere = meta[field] && meta[field].source !== 'file'
    if (isLocked(meta, field) || (fromElsewhere && empty(values[field]))) {
      for (const member of groupOf(field)) if (member in result) result[member] = track[member]
      result[field] = track[field]
    } else if (meta[field] && !same(track[field], values[field])) {
      db.prepare('DELETE FROM track_field_meta WHERE track_id = ? AND field = ?').run(id, field)
    }
  }
  return result
}

/** Says `fields` of the track came from `source` (when they were written some other way). */
function recordSource(db, trackId, fields, { source, ref = null, confidence = null, locked = false } = {}) {
  ensureTables(db)
  if (!SOURCES.has(source)) throw new Error(`Unknown metadata source: ${source}`)
  for (const field of new Set((fields || []).flatMap(groupOf))) {
    if (!FIELD_TYPES[field]) continue
    if (source === 'file') db.prepare('DELETE FROM track_field_meta WHERE track_id = ? AND field = ? AND locked = 0').run(String(trackId), field)
    else writeMeta(db, String(trackId), field, { source, ref, confidence, locked })
  }
}

/** A merge: `fields` the kept track took from the removed one take their source too; the removed one's rows go. */
function moveProvenance(db, fromId, toId, fields = []) {
  ensureTables(db)
  for (const field of fields) {
    db.prepare(`INSERT OR REPLACE INTO track_field_meta (track_id, field, source, ref, confidence, locked, updated_at)
      SELECT ?, field, source, ref, confidence, locked, updated_at FROM track_field_meta WHERE track_id = ? AND field = ?`).run(String(toId), String(fromId), field)
  }
  db.prepare('DELETE FROM track_field_meta WHERE track_id = ?').run(String(fromId))
  db.prepare('DELETE FROM track_meta_history WHERE track_id = ?').run(String(fromId))
}

/** The edit dialog's save: `data` set by the user. { success, changes, track, batchId } or { error }. */
function editTrack(db, trackId, data = {}) {
  if (!db.prepare('SELECT 1 FROM tracks WHERE id = ?').get(String(trackId))) return { error: 'Track not found' }
  if (!FIELDS.some(field => data?.[field] !== undefined)) return { error: 'No fields to update' }
  const result = applyFields(db, trackId, data, { source: 'user' })
  return { success: true, changes: result.changed.length ? 1 : 0, track: result.track, batchId: result.batchId }
}

// ---------------------------------------------------------------- batch edit

/** One field of the batch editor's operations ({ mode, value }) on a value. */
function applyBatchField(currentValue, operation) {
  if (!operation || operation.mode === 'ignore') return { changed: false, value: currentValue }
  if (operation.mode === 'clear') return { changed: currentValue !== null && currentValue !== '', value: null }
  const currentText = String(currentValue ?? '')
  const needle = String(operation.value ?? '')
  if (operation.mode === 'removeText') {
    if (!needle) return { changed: false, value: currentValue }
    const nextText = currentText.split(needle).join('').trim()
    return { changed: nextText !== currentText, value: nextText || null }
  }
  if (operation.mode === 'keepAfterText' || operation.mode === 'keepBeforeText') {
    if (!needle) return { changed: false, value: currentValue }
    const index = currentText.indexOf(needle)
    if (index === -1) return { changed: false, value: currentValue }
    const nextText = operation.mode === 'keepAfterText' ? currentText.slice(index + needle.length).trim() : currentText.slice(0, index).trim()
    return { changed: nextText !== currentText, value: nextText || null }
  }
  if (operation.mode === 'fillMissing') {
    return empty(currentValue) ? { changed: true, value: operation.value ?? null } : { changed: false, value: currentValue }
  }
  if (operation.mode === 'replace') {
    const nextValue = operation.value ?? null
    return { changed: currentValue !== nextValue, value: nextValue }
  }
  return { changed: false, value: currentValue }
}

const BATCH_FIELDS = ['title', 'artist', 'album', 'album_artist', 'track_num', 'year', 'genre', 'genres', 'record_label', 'explicit', 'instrumental']

/**
 * The batch editor: `operations` ({ field: { mode, value } }, artwork too)
 * on every track of `trackIds`, by the user. Returns the changed tracks.
 */
async function applyBatchOperations(db, trackIds = [], operations = {}, { storageDir } = {}) {
  if (!Array.isArray(trackIds) || !trackIds.length) return []
  const ids = [...new Set(trackIds.filter(Boolean))]
  const tracks = ids.map(id => db.prepare('SELECT * FROM tracks WHERE id = ?').get(id)).filter(Boolean)
  if (!tracks.length) return []
  const artworkOp = operations.artwork
  if (artworkOp?.mode === 'replace' && artworkOp?.value && storageDir) {
    const bytes = Buffer.from(String(artworkOp.value).split(',')[1] || '', 'base64')
    fs.mkdirSync(path.join(storageDir, 'artwork'), { recursive: true })
    for (const track of tracks) fs.writeFileSync(path.join(storageDir, 'artwork', `${track.id}.jpg`), bytes)
  }
  const changes = tracks.map(track => {
    const fields = {}
    for (const field of BATCH_FIELDS) {
      const result = applyBatchField(track[field], operations[field])
      if (result.changed) fields[field] = result.value
    }
    if (artworkOp?.mode === 'clear' && track.artwork_path) fields.artwork_path = null
    else if (artworkOp?.mode === 'replace' && artworkOp?.value && storageDir) fields.artwork_path = path.join(storageDir, 'artwork', `${track.id}.jpg`)
    return { trackId: track.id, fields }
  })
  return applyMany(db, changes, { source: 'user' }).tracks
}

module.exports = {
  FIELDS, SOURCES, ensureTables, normalizeValue, normalizeGenres, firstGenre, resolveValues,
  provenance, setLock, applyFields, applyMany, undo, keepProtectedFields, recordSource, moveProvenance, editTrack,
  applyBatchField, applyBatchOperations,
}
