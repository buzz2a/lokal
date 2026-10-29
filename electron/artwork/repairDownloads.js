// Opt-in repair for existing addon downloads. Only job history containing the
// *original artwork URL* is an authority: never guess a cover by song title.
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const { fetchBestCover } = require('../download/coverQuality')
const { writeEmbeddedArtwork } = require('../fileArtwork')
const { writeCover } = require('./thumb')

const LOW_SIDE = 640
let state = { running: false, total: 0, done: 0, updated: 0, skipped: 0, failed: 0, cancelled: false }
let cancelling = false

function artworkRepairStatus() { return { ...state } }
function cancelArtworkRepair() { if (state.running) cancelling = true; return artworkRepairStatus() }

function candidatesFromHistory(db) {
  let jobs = []
  try { jobs = db.prepare("SELECT data FROM download_jobs WHERE status = 'done' ORDER BY updated_at DESC").all() } catch {}
  const candidates = new Map()
  for (const job of jobs) {
    let data
    try { data = JSON.parse(job.data || '{}') } catch { continue }
    const cover = data?.opts?.tags?.cover
    const addon = data?.opts?.addonSource?.provider
    if (!addon || typeof cover !== 'string' || !/^https:\/\/[^\s]{1,1000}$/.test(cover)) continue
    for (const indexed of data.indexedTracks || []) {
      if (!indexed || typeof indexed.id !== 'string') continue
      if (!candidates.has(indexed.id)) candidates.set(indexed.id, { url: cover, source: addon })
    }
  }
  return candidates
}

async function pixelSide(bytes) {
  if (!bytes?.length) return 0
  try {
    const meta = await sharp(Buffer.from(bytes), { limitInputPixels: 16 * 1024 * 1024 }).metadata()
    return Math.min(meta.width || 0, meta.height || 0)
  } catch { return null }
}

/** Returns a summary even when some files are busy, deleted or unsupported. */
async function repairLowQualityDownloads({ db, artworkDir, onProgress = () => {} }) {
  if (state.running) return { ...state, error: 'Artwork repair is already running' }
  cancelling = false
  state = { running: true, total: 0, done: 0, updated: 0, skipped: 0, failed: 0, cancelled: false }
  const progress = () => { try { onProgress({ ...state }) } catch {} }
  try {
    const history = candidatesFromHistory(db)
    const rows = db.prepare("SELECT id, file_path, artwork_path, download_source FROM tracks WHERE file_path NOT LIKE 'ghost://%'").all()
    const tracks = rows.filter(row => history.has(row.id) &&
      row.download_source === history.get(row.id).source)
    state.total = tracks.length
    progress()
    for (const track of tracks) {
      if (cancelling) { state.cancelled = true; break }
      try {
        const file = String(track.file_path || '')
        if (!path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          state.skipped++; continue
        }
        // Artwork outside Lokal's generated cache is explicitly supplied by
        // another app/folder or the user; never replace those pointers.
        if (track.artwork_path && path.dirname(path.resolve(track.artwork_path)) !== path.resolve(artworkDir)) {
          state.skipped++; continue
        }
        const metadata = await require('../musicMetadata').parseFile(file, { duration: false, skipCovers: false })
        const currentBytes = metadata?.common?.picture?.[0]?.data
        const side = await pixelSide(currentBytes)
        if (side === null || side >= LOW_SIDE) { state.skipped++; continue }
        const best = await fetchBestCover(history.get(track.id).url)
        if (!best || best.side < Math.max(640, side * 1.5)) { state.skipped++; continue }
        // Files may be edited while the network request is in flight. Never
        // overwrite a newly-upgraded (or user-edited) cover without checking.
        const latest = await require('../musicMetadata').parseFile(file, { duration: false, skipCovers: false })
        if (await pixelSide(latest?.common?.picture?.[0]?.data) !== side) {
          state.skipped++; continue
        }
        const normalized = await sharp(best.bytes).rotate()
          .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 90 }).toBuffer()
        writeEmbeddedArtwork(file, normalized)
        const thumbnail = await writeCover(artworkDir, String(track.id), normalized, { overwrite: true })
        db.prepare('UPDATE tracks SET artwork_path = ?, last_modified = ? WHERE id = ?')
          .run(thumbnail, fs.statSync(file).mtimeMs, track.id)
        state.updated++
      } catch {
        // A locked/read-only file is reported, not left half-written via DB.
        state.failed++
      } finally {
        state.done++
        progress()
      }
    }
  } catch (e) {
    state.error = e?.message || 'Could not inspect downloaded files'
  } finally {
    state.running = false
    cancelling = false
    progress()
  }
  return { ...state }
}

module.exports = { repairLowQualityDownloads, artworkRepairStatus, cancelArtworkRepair, candidatesFromHistory, pixelSide }
