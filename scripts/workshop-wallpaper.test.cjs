const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const Module = require('node:module')

// Test the actual Electron IPC helper under Node without launching the app.
// Only electron's imports are replaced; all path and filesystem checks remain real.
const load = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir() }, dialog: {} }
  return load.call(this, request, parent, isMain)
}
let wallpaper
try {
  wallpaper = require('../electron/ipc/workshopWallpaper')
} finally {
  Module._load = load
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-wallpaper-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('only the intended Workshop item is automatically accepted', (t) => {
  const root = fixture(t)
  const good = path.join(root, 'steamapps/workshop/content/431960/2873513347/scene.pkg')
  const wrong = path.join(root, 'steamapps/workshop/content/431960/2872351452/scene.pkg')
  for (const name of [good, wrong]) {
    fs.mkdirSync(path.dirname(name), { recursive: true })
    fs.writeFileSync(name, 'PKGV0001')
  }
  assert.equal(wallpaper.validPackage(good), true)
  assert.equal(wallpaper.verifiedWorkshopPackage(good), true)
  assert.equal(wallpaper.verifiedWorkshopPackage(wrong), false)
})

test('copied source requires matching project.json workshopid', (t) => {
  const root = fixture(t)
  const file = path.join(root, 'scene.pkg')
  fs.writeFileSync(file, 'PKGV0001')
  assert.equal(wallpaper.verifiedWorkshopPackage(file), false)
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ workshopid: '2873513347', type: 'scene' }))
  assert.equal(wallpaper.verifiedWorkshopPackage(file), true)
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ workshopid: '2872351452', type: 'scene' }))
  assert.equal(wallpaper.verifiedWorkshopPackage(file), false)
})

test('empty or incorrectly named files cannot be selected', (t) => {
  const root = fixture(t)
  const file = path.join(root, 'scene.pkg')
  fs.writeFileSync(file, '')
  assert.equal(wallpaper.validPackage(file), false)
  assert.equal(wallpaper.validPackage(path.join(root, 'missing.pkg')), false)
  const renamed = path.join(root, 'scene.json')
  fs.writeFileSync(renamed, 'PKGV0001')
  assert.equal(wallpaper.validPackage(renamed), false)
})
