// Web mode: the same Shazam integration as the desktop app.
const router = require('express').Router()
const { getDB } = require('../../electron/ipc/db')
const shazam = require('../../electron/shazam')

router.get('/status', (req, res) => res.json(shazam.status(getDB())))
router.post('/connect', async (req, res) => res.json(await shazam.connect(getDB(), req.body?.token).catch(e => ({ ok: false, error: e.message }))))
router.post('/disconnect', (req, res) => res.json(shazam.disconnect(getDB(), req.body?.source)))
router.post('/import', (req, res) => { try { res.json(shazam.importExport(getDB(), { name: req.body?.name, data: req.body?.data })) } catch (e) { res.json({ ok: false, error: e.message }) } })
router.get('/locations', async (req, res) => res.json(await shazam.locations()))
router.get('/charts/:id', async (req, res) => res.json(await shazam.chart(getDB(), req.params.id, req.query.country)))
router.get('/playlists', async (req, res) => res.json(await shazam.playlists(getDB(), { page: Number(req.query.page) || 1 })))
router.get('/playlists/:id', async (req, res) => res.json(await shazam.playlist(getDB(), req.params.id)))
router.get('/library', async (req, res) => res.json(await shazam.library(getDB())))
router.get('/library/:id', async (req, res) => res.json(await shazam.libraryPlaylist(getDB(), req.params.id)))

module.exports = router
