// AutoMix's analyses for the window (electron/automix): a song's, by its
// library file or its online stream, analysed once and kept; the whole
// library's in the background (Analyse Library); and Magic Sort, which
// orders a playlist from them (electron/mixing).

/**
 * Analyze each revision of a local recording independently. An ID-only key
 * reuses the previous waveform after a user overwrites/retags the same path.
 * Include the actual file stamp and CUE offsets so stale results cannot
 * silently drive transition timing or library tempo.
 */
function automixFileCacheKey(track, stat) {
  if (!track?.id || !stat || !Number.isFinite(stat.size) ||
      !Number.isFinite(stat.mtimeMs)) return null
  return [
    'file-v2', String(track.id), Math.round(stat.size),
    Math.round(stat.mtimeMs),
    Number(track.start_offset_ms ?? track.startOffsetMs ?? 0),
    Number(track.end_offset_ms ?? track.endOffsetMs ?? 0),
  ].join(':')
}

function registerAutomixHandlers(ipcMain) {
  const fs = require('fs')
  const { getDB } = require('./db')
  const { analysisFor } = require('../automix')
  const library = require('../automix/library')
  const { readAdvancedReport, mergeAdvancedAnalysis } = require('../automix/advanced-report')
  const { loadPreparedStemClip } = require('../automix/stem-clip')
  const { makeAutoPrepare } = require('../automix/auto-prepare')
  const autoPrepare = makeAutoPrepare({})
  const log = message => { try { require('electron-log').info(message) } catch {} }
  const ffmpeg = () => require('./tools').findFfmpeg()

  ipcMain.handle('automix:analyzeLibrary', () => {
    try { return library.startLibraryAnalysis(getDB(), { ffmpeg, log }) } catch (e) { return { error: e.message } }
  })
  ipcMain.handle('automix:libraryStatus', () => library.libraryAnalysisStatus(getDB()))
  ipcMain.handle('automix:cancelLibrary', () => library.cancelLibraryAnalysis(getDB()))

  ipcMain.handle('mixing:magicSort', async (event, playlistId) => {
    const onProgress = progress => { try { event.sender.send('mixing:progress', { playlistId, ...progress }) } catch {} }
    try { return await require('../mixing/playlist').magicSortPlaylist(getDB(), playlistId, { ffmpeg, log, onProgress }) } catch (e) { return { error: e.message } }
  })

  ipcMain.handle('automix:analyze', async (_, track) => {
    if (!track?.id) return null
    const db = getDB()
    const sources = require('../online/sources')
    const ref = sources.streamRef(track)
    if (ref) {
      return analysisFor({
        db, key: `${ref.provider}:${ref.id}`, log,
        ffmpeg: () => require('./tools').findFfmpeg(),
        source: async () => {
          const stream = await sources.resolveStream(ref.provider, ref.id, require('./online').streamOptions())
          return stream?.file ? { file: stream.file } : stream?.url ? { url: stream.url, headers: stream.headers } : null
        },
      })
    }
    const file = String(track.file_path || '')
    if (!file || file.startsWith('ghost://')) return null
    let stat
    try { stat = fs.statSync(file) } catch { return null }
    if (!stat.isFile()) return null
    const key = automixFileCacheKey(track, stat)
    if (!key) return null
    const base = await analysisFor({
      db, key, trackId: String(track.id), log,
      ffmpeg: () => require('./tools').findFfmpeg(),
      source: async () => {
        // Source may be replaced between cache lookup and ffmpeg decode.
        // Discard this attempt rather than cache the new bytes under an old
        // revision key.
        try {
          const current = fs.statSync(file)
          return current.isFile() && automixFileCacheKey(track, current) === key
            ? { file } : null
        } catch { return null }
      },
    })
    if (!base) return null
    // Read a sidecar only when its current source stamp still agrees with
    // the exact file revision used for the baseline waveform cache.
    // Changes to the report do not force PCM decoding.
    try {
      const current = fs.statSync(file)
      if (automixFileCacheKey(track, current) !== key) return null
      return mergeAdvancedAnalysis(base, readAdvancedReport(file, current))
    } catch { return base }
  })

  // Used only for a local pair with an explicitly prepared and verified
  // offline stem clip. Streaming, CUE slices and missing clips return null.
  // This endpoint NEVER runs the Python engine or decodes an audio source.
  ipcMain.handle('automix:stemClip', async (_, outgoing, incoming) => {
    return loadPreparedStemClip(outgoing, incoming)
  })

  // Optional MP3-only model preparation. The process is launched asynchronously
  // and serialized; the normal playback thread never waits for Python.
  ipcMain.handle('automix:preparePair', async (_, outgoing, incoming, engineDir) => {
    const sources = require('../online/sources')
    if (sources.streamRef(outgoing) || sources.streamRef(incoming)) return null
    return autoPrepare.prepare(outgoing, incoming, engineDir)
  })
}

module.exports = { registerAutomixHandlers, automixFileCacheKey }
