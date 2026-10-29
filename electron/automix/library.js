// Analyse Library: AutoMix's analysis (index.js) of every library song that
// hasn't had one, in the background, so tempo, key and loudness are known
// before a song is ever played: smart playlist rules on them, and Magic Sort
// (electron/mixing). Shared by the desktop app (electron/ipc/automix.js) and
// the web server (server/routes/tracks.js).

const fs = require('fs')
const { analysisFor, ensureTable } = require('./index')
const { VERSION } = require('./analysis')
const { automixFileCacheKey } = require('../ipc/automix')

const PARALLEL = 2 // songs decoded at once (ffmpeg); the analysis itself is one worker

// A library file's analysis is kept under automixFileCacheKey's key
// ("file-v2:<id>:<size>:<mtime>:<offsets>"), the one AutoMix reads when the
// song plays. Any revision of the song's file counts as analysed here (its
// tempo and key are on the song already); AutoMix redoes a changed file's
// own when it plays it. The prefix comes from the function itself, so a new
// key version upstream still lines up.
const KEY_PREFIX = automixFileCacheKey({ id: '\0' }, { size: 0, mtimeMs: 0 }).split('\0')[0]

/** SQL: track_analysis `a` rows for the song whose id is `column` (a range on the key, so the index is used). */
const analysisOf = column => `a.key >= '${KEY_PREFIX}' || ${column} || ':' AND a.key < '${KEY_PREFIX}' || ${column} || ';'`

const PENDING = `t.file_path NOT LIKE 'ghost://%'
  AND NOT EXISTS (SELECT 1 FROM track_analysis a WHERE ${analysisOf('t.id')} AND a.version = @version)`

/** Library songs with a file and no analysis yet: all of them, or those of `ids`. */
function unanalysed(db, ids = null) {
  ensureTable(db)
  const rows = db.prepare(`SELECT t.* FROM tracks t WHERE ${PENDING}`).all({ version: VERSION })
  if (!ids) return rows
  const wanted = new Set(ids.map(String))
  return rows.filter(row => wanted.has(String(row.id)))
}

/**
 * Analyse `songs` ({ id, file_path }), PARALLEL at a time. `onSong(song,
 * result)` after each (result null when it couldn't be: no file, unreadable,
 * over AutoMix's length limit); no new song starts once `stopped()` says so.
 */
async function analyseSongs(db, songs, { ffmpeg, log = () => {}, onSong = () => {}, stopped = () => false }) {
  let next = 0
  const lane = async () => {
    while (next < songs.length && !stopped()) {
      const song = songs[next++]
      const file = String(song.file_path || '')
      let key = null
      try {
        const stat = fs.statSync(file)
        if (stat.isFile()) key = automixFileCacheKey(song, stat)
      } catch {}
      // As AutoMix does: a file replaced between here and the decode isn't
      // kept under the old revision's key.
      const current = () => { try { return automixFileCacheKey(song, fs.statSync(file)) === key } catch { return false } }
      const result = key ? await analysisFor({
        db, key, trackId: String(song.id), log, ffmpeg,
        source: async () => (current() ? { file } : null),
      }).catch(() => null) : null
      onSong(song, result)
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, lane))
}

/** `rows` (tracks) each with its `analysis` (parsed), or null when it has none. */
function withAnalyses(db, rows) {
  ensureTable(db)
  const read = db.prepare(`SELECT data FROM track_analysis a WHERE ${analysisOf('@id')} AND a.version = @version ORDER BY a.analyzed_at DESC LIMIT 1`)
  return rows.map(row => {
    let analysis = null
    try { analysis = JSON.parse(read.get({ id: String(row.id), version: VERSION })?.data || 'null') } catch {}
    return { ...row, analysis: analysis && !analysis.tooLong && !analysis.tooShort ? analysis : null }
  })
}

let job = null

/** Start analysing the library (unless it already is); its status. */
function startLibraryAnalysis(db, { ffmpeg, log = () => {} }) {
  if (job?.running) return libraryAnalysisStatus(db)
  if (!ffmpeg()) return { error: 'Analysing needs ffmpeg (Settings → Integrations → External Tools).' }
  const songs = unanalysed(db)
  const current = job = { running: true, total: songs.length, done: 0, analysed: 0, skipped: 0, cancelled: false, title: null }
  ;(async () => {
    try {
      await analyseSongs(db, songs, {
        ffmpeg, log, stopped: () => current.cancelled,
        onSong: (song, result) => {
          current.done += 1
          if (result) current.analysed += 1
          else current.skipped += 1
          current.title = song.title || null
        },
      })
    } finally {
      current.running = false
      current.title = null
      current.finishedAt = Date.now()
    }
  })()
  return libraryAnalysisStatus(db)
}

function cancelLibraryAnalysis(db) {
  if (job?.running) job.cancelled = true
  return libraryAnalysisStatus(db)
}

/**
 * { running, total, done, analysed, skipped (no file, unreadable or too
 * long), cancelled, title (the song last done), finishedAt, remaining (songs
 * still without an analysis, while it isn't running) }
 */
function libraryAnalysisStatus(db) {
  const status = job ? { ...job } : { running: false, total: 0, done: 0, analysed: 0, skipped: 0, cancelled: false }
  if (!status.running && db) {
    try {
      ensureTable(db)
      status.remaining = db.prepare(`SELECT COUNT(*) AS n FROM tracks t WHERE ${PENDING}`).get({ version: VERSION }).n
    } catch {}
  }
  return status
}

module.exports = { unanalysed, analyseSongs, withAnalyses, analysisOf, startLibraryAnalysis, cancelLibraryAnalysis, libraryAnalysisStatus }
