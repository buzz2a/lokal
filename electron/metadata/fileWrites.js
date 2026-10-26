// What Edit Track saves also goes into the audio file itself (upstream's
// electron/fileComment.js and electron/fileArtwork.js), so other players see
// it: its tags, and a new cover. The library side still goes through the
// store (provenance, locks, undo). Fix Metadata's applies stay database-only.
// Shared by the desktop app and the web server.

const fs = require('fs')
const path = require('path')
const store = require('./store')

/** The track's audio file, when it has one on disk (not a streamed song). */
function localFile(track) {
  const filePath = String(track?.file_path || '')
  return path.isAbsolute(filePath) && !filePath.startsWith('ghost://') ? filePath : ''
}

/** Edit Track's save: the tags into the file (when it's there), then the store. { success, changes, track, batchId } or { error }. */
function saveTrackEdit(db, trackId, data = {}) {
  const current = db.prepare('SELECT * FROM tracks WHERE id = ?').get(String(trackId || ''))
  if (!current) return { error: 'Track not found' }
  if (!store.FIELDS.some(field => data?.[field] !== undefined)) return { error: 'No fields to update' }
  // A genre alone goes into the file in front of the song's other genres.
  const tagData = { ...data }
  if (tagData.genre !== undefined && tagData.genres === undefined) {
    const existing = String(current.genres || current.genre || '').split(',').map(value => value.trim()).filter(Boolean)
    tagData.genres = [...new Set([String(tagData.genre || '').trim(), ...existing].filter(Boolean))]
  }
  const fileComment = require('../fileComment')
  const edits = fileComment.fileTagEdits(tagData)
  const file = localFile(current)
  let wrote = false
  if (Object.keys(edits).length && file && fs.existsSync(file)) {
    try { fileComment.writeFileTags(file, edits); wrote = true } catch (error) { return { error: `Couldn't save the tags into the file: ${error.message}` } }
  }
  const result = store.editTrack(db, trackId, data)
  if (wrote) require('../fileStamp').noteFileWritten(db, file)
  return result
}

/** Puts a cover into the song's audio file. Throws when the file should be there and isn't. */
async function embedCover(db, track, imageBytes) {
  const file = localFile(track)
  if (!file) return false
  if (!fs.existsSync(file)) throw new Error('The audio file is missing; artwork was not changed.')
  require('../fileArtwork').writeEmbeddedArtwork(file, imageBytes)
  require('../fileStamp').noteFileWritten(db, file)
  return true
}

/** A cover the user picked (image data): into the file and the artwork folder. The track, or { error }. */
async function setTrackCover(db, trackId, imageData, { storageDir } = {}) {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(String(trackId || ''))
  if (!track) return { error: 'Track not found' }
  try {
    const cover = await require('../fileArtwork').normalizeArtwork(imageData)
    await embedCover(db, track, cover)
    const artPath = await require('../artwork/thumb').writeCover(path.join(storageDir, 'artwork'), String(track.id), cover, { overwrite: true })
    return store.applyFields(db, track.id, { artwork_path: artPath }, { source: 'user' }).track || null
  } catch (error) {
    console.error('[setTrackCover] Could not replace artwork:', error)
    return { error: error?.message || 'Could not replace artwork' }
  }
}

module.exports = { localFile, saveTrackEdit, embedCover, setTrackCover }
