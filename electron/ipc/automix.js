// AutoMix's analyses for the window (electron/automix): a song's, by its
// library file or its online stream, analysed once and kept; the whole
// library's in the background (Analyse Library); and Magic Sort, which
// orders a playlist from them (electron/mixing).

function registerAutomixHandlers(ipcMain) {
  const fs = require('fs')
  const { getDB } = require('./db')
  const { analysisFor } = require('../automix')
  const library = require('../automix/library')
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
    return analysisFor({
      db, key: String(track.id), trackId: String(track.id), log,
      ffmpeg: () => require('./tools').findFfmpeg(),
      source: async () => (fs.existsSync(file) ? { file } : null),
    })
  })
}

module.exports = { registerAutomixHandlers }
