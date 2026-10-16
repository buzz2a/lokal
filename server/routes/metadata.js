// Fix Metadata for web mode (see electron/ipc/metadata.js).
const router = require('express').Router()
const { getDB, getStorageDir } = require('../../electron/ipc/db')
const store = require('../../electron/metadata/store')
const lookup = require('../../electron/metadata/lookup')
const { applyChanges } = require('../../electron/metadata/apply')
const { lookupOptions } = require('../../electron/ipc/metadata')

const fail = res => error => res.json({ error: error.message })

router.get('/providers', (req, res) => res.json(lookup.listProviders(getDB())))
router.post('/lookup-track', (req, res) => {
  lookup.lookupTrack(getDB(), req.body?.trackId, lookupOptions(req.body)).then(result => res.json(result)).catch(fail(res))
})
router.post('/lookup-album', (req, res) => {
  lookup.lookupAlbum(getDB(), req.body?.trackIds, lookupOptions(req.body)).then(result => res.json(result)).catch(fail(res))
})
router.post('/apply', (req, res) => {
  applyChanges(getDB(), req.body?.changes, { storageDir: getStorageDir() }).then(result => res.json(result)).catch(fail(res))
})
router.post('/undo', (req, res) => {
  try { res.json(store.undo(getDB(), req.body?.batchId)) } catch (error) { fail(res)(error) }
})
router.get('/provenance/:id', (req, res) => res.json(store.provenance(getDB(), req.params.id)))
router.post('/lock', (req, res) => res.json(store.setLock(getDB(), req.body?.trackId, req.body?.fields, !!req.body?.locked)))

module.exports = router
