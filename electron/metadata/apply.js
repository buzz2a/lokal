// Fix Metadata's "Apply": what the user picked from the lookups, written as
// one undoable batch and locked (it's their choice now). A picked cover is
// downloaded into the artwork folder first, under a name of its own so an
// undo still finds the cover it replaced.

const fs = require('fs')
const path = require('path')
const store = require('./store')
const { findArtworkAndGenre } = require('./lookup')

const MAX_IMAGE_BYTES = 15 * 1024 * 1024

async function downloadImage(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('Not a web address')
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`The cover's server answered ${res.status}`)
  const type = String(res.headers?.get?.('content-type') || '')
  if (type && !/^image\//i.test(type)) throw new Error('Not an image')
  const bytes = Buffer.from(await res.arrayBuffer())
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('The cover is empty or too large')
  return bytes
}

function saveCover(storageDir, trackId, tag, bytes) {
  const dir = path.join(storageDir, 'artwork')
  fs.mkdirSync(dir, { recursive: true })
  const safeTag = String(tag || 'cover').replace(/[^a-z0-9]+/gi, '-').slice(0, 24)
  const file = path.join(dir, `${trackId}.${safeTag}.${Date.now().toString(36)}.jpg`)
  fs.writeFileSync(file, bytes)
  return file
}

/**
 * changes: [{ trackId, fields: { field: value, artwork_url? }, source, ref, confidence }]
 * (source: the online source a value came from, or 'user' for one typed in).
 * Returns { batchId, tracks, changed, errors }.
 */
async function applyChanges(db, changes = [], { storageDir, fetchImpl = fetch } = {}) {
  const errors = []
  const images = new Map()
  const list = (Array.isArray(changes) ? changes : []).filter(change => change?.trackId && change.fields && typeof change.fields === 'object')
  for (const change of list) {
    const url = change.fields.artwork_url
    if (!url || images.has(url) || !storageDir) continue
    images.set(url, await downloadImage(url, { fetchImpl }).catch(error => { errors.push(`Cover: ${error.message}`); return null }))
  }
  const prepared = list.map(change => {
    const fields = { ...change.fields }
    const url = fields.artwork_url
    delete fields.artwork_url
    delete fields.artwork_path
    const bytes = url ? images.get(url) : null
    if (bytes) fields.artwork_path = saveCover(storageDir, change.trackId, change.source, bytes)
    const source = store.SOURCES.has(change.source) && change.source !== 'file' ? change.source : 'user'
    return { trackId: String(change.trackId), fields, source, ref: change.ref || null, confidence: change.confidence ?? null }
  })
  const result = store.applyMany(db, prepared, { source: 'user', lock: true })
  return { ...result, errors }
}

/**
 * A cover (and a genre, when the song has none) found online for a song;
 * the cover's file, or null. Used by downloads and the edit dialog.
 */
async function fetchArtworkAndGenre(db, { title, artist, trackId, duration = null }, { storageDir, fetchImpl = fetch } = {}) {
  const found = await findArtworkAndGenre(db, { title, artist, duration }, { fetchImpl })
  if (!found) return null
  let artPath = null
  if (found.artworkUrl && storageDir) {
    try { artPath = saveCover(storageDir, trackId, found.source, await downloadImage(found.artworkUrl, { fetchImpl })) } catch {}
  }
  if (!artPath && !found.genre) return null
  return { artPath, genre: found.genre, source: found.source }
}

/** The edit dialog's "find artwork": { success, artworkPath, track } or { success: false, error }. */
async function fetchExternalArtwork(db, trackId, { title, artist } = {}, options = {}) {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(String(trackId || ''))
  if (!track) return { success: false, error: 'Track not found' }
  const found = await fetchArtworkAndGenre(db, { title: title || track.title, artist: artist || track.artist, trackId: track.id, duration: track.duration }, options)
  if (!found?.artPath) return { success: false, error: 'No artwork found' }
  // Asked for by the user: kept like their own choice.
  const applied = store.applyMany(db, [{ trackId: track.id, fields: { artwork_path: found.artPath }, source: found.source }], { lock: true })
  return { success: true, artworkPath: found.artPath, track: applied.tracks[0] || db.prepare('SELECT * FROM tracks WHERE id = ?').get(track.id), batchId: applied.batchId }
}

module.exports = { applyChanges, downloadImage, fetchArtworkAndGenre, fetchExternalArtwork }
