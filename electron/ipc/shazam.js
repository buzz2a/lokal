// Desktop side of the Shazam integration (see ../shazam.js).
const { getDB } = require('./db')
const shazam = require('../shazam')

/** Shazam IPC for the desktop app: charts, Shazam's playlists, the user's Shazams. */
function registerShazamHandlers(ipcMain) {
  ipcMain.handle('shazam:status', () => shazam.status(getDB()))
  ipcMain.handle('shazam:connect', (_, token) => shazam.connect(getDB(), token).catch(e => ({ ok: false, error: e.message })))
  ipcMain.handle('shazam:disconnect', (_, source) => shazam.disconnect(getDB(), source))
  ipcMain.handle('shazam:import', (_, file) => { try { return shazam.importExport(getDB(), file) } catch (e) { return { ok: false, error: e.message } } })
  ipcMain.handle('shazam:locations', () => shazam.locations())
  ipcMain.handle('shazam:chart', (_, id, country) => shazam.chart(getDB(), id, country))
  ipcMain.handle('shazam:playlists', (_, options) => shazam.playlists(getDB(), options))
  ipcMain.handle('shazam:playlist', (_, id) => shazam.playlist(getDB(), id))
  ipcMain.handle('shazam:library', () => shazam.library(getDB()))
  ipcMain.handle('shazam:libraryPlaylist', (_, id) => shazam.libraryPlaylist(getDB(), id))
}

module.exports = { registerShazamHandlers }
