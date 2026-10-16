// Desktop side of Fix Metadata (electron/metadata): lookups, apply, undo,
// where each detail came from, and locks. The web server has the same in
// server/routes/metadata.js.
const { getDB, getStorageDir } = require('./db')
const store = require('../metadata/store')
const lookup = require('../metadata/lookup')
const { applyChanges } = require('../metadata/apply')

// Only what the page may choose: never a fetch implementation or pacing.
const lookupOptions = options => ({ query: options?.query || {}, providers: Array.isArray(options?.providers) ? options.providers : null })
const failed = error => ({ error: error.message })

function registerMetadataHandlers(ipcMain) {
  ipcMain.handle('metadata:providers', () => lookup.listProviders(getDB()))
  ipcMain.handle('metadata:lookupTrack', (_, trackId, options) => lookup.lookupTrack(getDB(), trackId, lookupOptions(options)).catch(failed))
  ipcMain.handle('metadata:lookupAlbum', (_, trackIds, options) => lookup.lookupAlbum(getDB(), trackIds, lookupOptions(options)).catch(failed))
  ipcMain.handle('metadata:apply', (_, changes) => applyChanges(getDB(), changes, { storageDir: getStorageDir() }).catch(failed))
  ipcMain.handle('metadata:undo', (_, batchId) => { try { return store.undo(getDB(), batchId) } catch (error) { return failed(error) } })
  ipcMain.handle('metadata:provenance', (_, trackId) => store.provenance(getDB(), trackId))
  ipcMain.handle('metadata:setLock', (_, trackId, fields, locked) => store.setLock(getDB(), trackId, fields, !!locked))
}

module.exports = { registerMetadataHandlers, lookupOptions }
