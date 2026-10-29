// Load the exact Steam Workshop source scene from the user's own installation.
// Never ship somebody else's Workshop textures or scene.pkg in Lokal.
const fs = require('fs')
const path = require('path')
const os = require('os')
const { app, dialog } = require('electron')

const WORKSHOP_ID = '2873513347' // pupsi: Vinyl Record Player (for MusicBee)
const APP_ID = '431960' // Wallpaper Engine
const MAX_SCENE_BYTES = 100 * 1024 * 1024

function validPackage(file) {
  if (!file || path.basename(file).toLowerCase() !== 'scene.pkg') return false
  try {
    const stat = fs.statSync(file)
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_SCENE_BYTES
  } catch { return false }
}
function steamRoots() {
  const home = os.homedir()
  const roots = [
    process.env.STEAM_DIR,
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Steam'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Steam'),
    path.join(home, '.steam/steam'),
    path.join(home, '.local/share/Steam'),
    path.join(home, 'Library/Application Support/Steam'),
  ].filter(Boolean)
  const visited = new Set()
  for (let i = 0; i < roots.length && i < 40; i++) {
    const root = path.resolve(roots[i])
    if (visited.has(root)) continue
    visited.add(root)
    try {
      // Steam stores additional drive libraries in the root libraryfolders.vdf.
      // Matches both the old and current VDF formats, not arbitrary user paths.
      const vdf = fs.readFileSync(path.join(root, 'steamapps/libraryfolders.vdf'), 'utf8')
      const rx = /"path"\s+"([^"]+)"/g
      for (const match of vdf.matchAll(rx)) {
        const library = match[1].replace(/\\\\/g, '\\')
        if (path.isAbsolute(library) && !visited.has(library)) roots.push(library)
      }
    } catch {}
  }
  return [...visited]
}
function workshopCandidates() {
  const files = []
  for (const steam of steamRoots()) {
    const project = path.join(steam, 'steamapps', 'workshop', 'content', APP_ID, WORKSHOP_ID)
    files.push(path.join(project, 'scene.pkg'), path.join(project, 'scenes', 'scene.pkg'))
  }
  return files
}
// Accept this specific Workshop source, not an arbitrary package that could run
// SceneScript inside Lokal's renderer. A copied scene needs its project.json.
function verifiedWorkshopPackage(file) {
  if (!validPackage(file)) return false
  const normal = path.resolve(file).replace(/\\/g, '/')
  if (normal.split('/').some((part, i, parts) =>
    part === APP_ID && parts[i + 1] === WORKSHOP_ID)) return true
  const directory = path.basename(path.dirname(file)) === 'scenes'
    ? path.dirname(path.dirname(file)) : path.dirname(file)
  try {
    const metadata = fs.readFileSync(path.join(directory, 'project.json'))
    if (metadata.length > 1024 * 1024) return false
    return String(JSON.parse(metadata.toString('utf8')).workshopid || '') === WORKSHOP_ID
  } catch { return false }
}
function settingsFile() {
  return path.join(app.getPath('userData'), 'original-turntable-source.json')
}
function preferredPackage() {
  try {
    const stored = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
    if (verifiedWorkshopPackage(stored?.path)) return stored.path
  } catch {}
  return workshopCandidates().find(verifiedWorkshopPackage) || ''
}
async function packageData(file) {
  if (!verifiedWorkshopPackage(file)) return { error: 'The original Wallpaper Engine scene.pkg is unavailable.' }
  // Loading a large scene synchronously would block Electron's main thread
  // and make playback or window controls appear frozen.
  const pkg = await fs.promises.readFile(file)
  let project = null
  try {
    const p = path.join(path.dirname(file), path.basename(path.dirname(file)) === 'scenes' ? '..' : '.', 'project.json')
    if (fs.existsSync(p)) {
      const b = fs.readFileSync(p)
      if (b.length <= 1024 * 1024) project = JSON.parse(b.toString('utf8'))
    }
  } catch {}
  return { bytes: new Uint8Array(pkg), project, key: `workshop:${WORKSHOP_ID}:${pkg.length}:${fs.statSync(file).mtimeMs}` }
}
function registerWorkshopWallpaperHandlers(ipcMain) {
  // Same centralized SSRF/size/content-type checks used by playlist artwork.
  // Convert provider artwork to a data URL so WebWallGL's GL texture upload
  // does not depend on third-party image CORS response headers.
  ipcMain.handle('wallpaper:coverData', async (_, { trackId, url } = {}) => {
    if (trackId) {
      // The same DB-validated full-cover lookup used by lokal-stream://cover.
      // IPC returns a data URL because fetch(file://) is not reliable in
      // Chromium and WebWallGL expects a browser-fetchable image.
      const picture = await require('../artwork/fullCover').fullCoverForTrack(
        require('./db').getDB(), String(trackId))
      if (picture?.bytes?.length && picture.bytes.length <= 10 * 1024 * 1024 &&
        /^image\/(?:jpeg|png|webp)$/.test(picture.mime || '')) {
        return `data:${picture.mime};base64,${picture.bytes.toString('base64')}`
      }
    }
    // Remote results run through the existing HTTPS-only image validator.
    return require('../playlists/remoteCover').fetchCoverData(url)
  })
  ipcMain.handle('wallpaper:workshopStatus', () => ({
    installed: !!preferredPackage(), workshopId: WORKSHOP_ID,
  }))
  ipcMain.handle('wallpaper:workshopGet', () => packageData(preferredPackage()))
  ipcMain.handle('wallpaper:workshopChoose', async (event) => {
    const parent = require('electron').BrowserWindow.fromWebContents(event.sender)
    const dialogOptions = {
      title: 'Select the original Vinyl Record Player scene.pkg',
      properties: ['openFile'],
      filters: [{ name: 'Wallpaper Engine scene', extensions: ['pkg'] }],
    }
    const selected = await dialog.showOpenDialog(parent, dialogOptions)
    if (selected.canceled || !selected.filePaths[0]) return { cancelled: true }
    const file = selected.filePaths[0]
    if (!verifiedWorkshopPackage(file)) return { error: 'Select the original Workshop 2873513347 scene.pkg, inside its Workshop folder or beside a project.json with the matching workshopid (100 MB maximum).' }
    fs.writeFileSync(settingsFile(), JSON.stringify({ path: file }))
    return { installed: true }
  })
}
module.exports = { registerWorkshopWallpaperHandlers, workshopCandidates, validPackage, verifiedWorkshopPackage }
