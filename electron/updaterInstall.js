'use strict'

// Electron-updater closes windows and quits the app as part of quitAndInstall.
// The normal window-close handler must not race that shutdown sequence.
function shouldQuitOnWindowClosed(platform, isUpdating) {
  return platform !== 'darwin' && !isUpdating
}

function createUpdateInstaller(autoUpdater, { onStart, onError } = {}) {
  let downloaded = false
  let installing = false

  return {
    markDownloaded() { downloaded = true },
    markFailed() { downloaded = false },
    install() {
      if (installing) return { installing: true }
      if (!downloaded) return { error: 'Update download has not completed' }

      installing = true
      try {
        onStart?.()
        // Let electron-updater close the windows and start its installer.
        // The second argument forces NSIS to launch Lokal again afterward.
        autoUpdater.quitAndInstall(false, true)
        return { installing: true }
      } catch (error) {
        installing = false
        onError?.(error)
        return { error: error?.message || String(error) }
      }
    },
  }
}

module.exports = { createUpdateInstaller, shouldQuitOnWindowClosed }
