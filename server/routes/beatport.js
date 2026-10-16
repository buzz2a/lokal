// Web mode: the same Beatport integration as the desktop app.
const router = require('express').Router()
const { getDB } = require('../../electron/ipc/db')
const beatport = require('../../electron/beatport')

router.get('/status', (req, res) => res.json(beatport.status(getDB())))
router.post('/login', async (req, res) => res.json(await beatport.login(getDB(), req.body?.username, req.body?.password).catch(e => ({ ok: false, error: e.message }))))
router.post('/token', async (req, res) => res.json(await beatport.connectToken(getDB(), req.body?.token).catch(e => ({ ok: false, error: e.message }))))
router.post('/disconnect', (req, res) => res.json(beatport.disconnect(getDB())))
router.get('/genres', async (req, res) => res.json(await beatport.genres(getDB())))
router.get('/top', async (req, res) => res.json(await beatport.top(getDB(), req.query.genre)))
router.get('/charts', async (req, res) => res.json(await beatport.charts(getDB(), { genreId: req.query.genre, page: Number(req.query.page) || 1 })))
router.get('/charts/:id', async (req, res) => res.json(await beatport.chart(getDB(), req.params.id)))
router.get('/playlists', async (req, res) => res.json(await beatport.playlists(getDB(), { page: Number(req.query.page) || 1 })))
router.get('/playlists/:id', async (req, res) => res.json(await beatport.playlist(getDB(), req.params.id)))

module.exports = router
