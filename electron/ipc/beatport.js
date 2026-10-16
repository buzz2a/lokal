// Desktop side of the Beatport integration (see ../beatport.js).
const { getDB } = require('./db')
const beatport = require('../beatport')

/** Beatport IPC for the desktop app: sign-in, genres, Top 100, charts, playlists. */
function registerBeatportHandlers(ipcMain) {
  ipcMain.handle('beatport:status', () => beatport.status(getDB()))
  ipcMain.handle('beatport:login', (_, username, password) => beatport.login(getDB(), username, password).catch(e => ({ ok: false, error: e.message })))
  ipcMain.handle('beatport:connectToken', (_, token) => beatport.connectToken(getDB(), token).catch(e => ({ ok: false, error: e.message })))
  ipcMain.handle('beatport:disconnect', () => beatport.disconnect(getDB()))
  ipcMain.handle('beatport:genres', () => beatport.genres(getDB()))
  ipcMain.handle('beatport:top', (_, genreId) => beatport.top(getDB(), genreId))
  ipcMain.handle('beatport:charts', (_, options) => beatport.charts(getDB(), options))
  ipcMain.handle('beatport:chart', (_, id) => beatport.chart(getDB(), id))
  ipcMain.handle('beatport:playlists', (_, options) => beatport.playlists(getDB(), options))
  ipcMain.handle('beatport:playlist', (_, id) => beatport.playlist(getDB(), id))
}

module.exports = { registerBeatportHandlers }
