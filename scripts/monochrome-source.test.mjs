import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mono = require('../electron/online/monochrome.js')
const sources = require('../electron/online/sources.js')

test('Monochrome search uses the official source and normalizes usable tracks', async () => {
  let requests = 0
  const rows = await mono.searchTracks('Daft Punk', {
    fetchImpl: async (url, options) => {
      requests++
      const request = new URL(url)
      assert.equal(request.host, 'tracks.monochrome.st')
      assert.equal(request.pathname, '/search/tracks')
      assert.equal(request.searchParams.get('q'), 'Daft Punk')
      assert.equal(options.redirect, 'error')
      return { ok: true, json: async () => ({ tracks: [
        { trackId:'155142501534011392', title:'Get Lucky', artistNames:['Daft Punk', 'Pharrell Williams'], duration:369626, artwork:'https://tracks.monochrome.st/cover.jpg', playable:true },
        { trackId:'155142501534011392', title:'Duplicate' },
        { trackId:'../../bad', title:'Invalid' },
        { trackId:'155142501534011393', title:'Unavailable', playable:false },
      ]}) }
    }
  })
  assert.equal(requests, 1)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].provider, 'mono')
  assert.equal(rows[0].duration, 370)
  assert.equal(rows[0].artist, 'Daft Punk, Pharrell Williams')
  assert.equal(rows[0].thumbnail, 'https://tracks.monochrome.st/cover.jpg')
  assert.equal(sources.validId('mono',rows[0].id),true)
  assert.deepEqual(sources.streamRef({file_path:sources.ghostPath('mono',rows[0].id)}), {provider:'mono',id:rows[0].id})
  assert.equal(sources.sourceIdentity(rows[0].url), 'mono:155142501534011392')
  const stream = await sources.resolveStream('mono',rows[0].id)
  assert.equal(stream.url,'https://tracks.monochrome.st/track/155142501534011392')
  assert.equal(stream.mime,'audio/flac')
})

test('Monochrome rejects path traversal, foreign hosts and malformed IDs', async () => {
  assert.equal(mono.idFromUrl('https://evil.example/track/155142501534011392'), null)
  assert.equal(mono.idFromUrl('http://tracks.monochrome.st/track/155142501534011392'), null)
  assert.equal(mono.idFromUrl('https://tracks.monochrome.st/track/155142501534011392'), '155142501534011392')
  assert.equal(sources.validId('mono','../fake'),false)
  await assert.rejects(sources.resolveStream('mono','../fake'), /Unknown online song/)
})

test('Monochrome search error does not fall through to YouTube', async () => {
  await assert.rejects(mono.searchTracks('artist', {
    fetchImpl: async () => ({ ok:false, status: 503 })
  }), /HTTP 503/)
})

test('Monochrome retries an intermittent provider error only once', async () => {
  let attempts = 0
  const result = await mono.searchTracks('song', {
    fetchImpl: async () => {
      attempts++
      return attempts === 1
        ? { ok:false, status:503 }
        : { ok:true, status:200, json:async () => ({ tracks: [] }) }
    }
  })
  assert.deepEqual(result, [])
  assert.equal(attempts, 2)
})

test('saving a Monochrome ghost forwards catalogue tags and cover to the downloader', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/onlineTracks.js', import.meta.url), 'utf8')
    .replace("import { api } from './api.js'", "const api = globalThis.__testMonochromeApi")
    .replace("import { downloadBatchCurrent } from './downloadCancellation.js'", 'const downloadBatchCurrent = value => value || (() => true)')
  const calls = []
  globalThis.__testMonochromeApi = {
    downloadYT: async (url, opts) => { calls.push([url, opts]); return { downloadId: 'mono-job' } },
  }
  try {
    const { saveToLibrary } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
    const result = await saveToLibrary({
      id: 'ghost-mono', file_path: 'ghost://monochrome/online/155142501534011392',
      title: 'Get Lucky', artist: 'Daft Punk', album: 'Random Access Memories',
      artwork_url: 'https://tracks.monochrome.st/cover.jpg',
    })
    assert.equal(result.downloadId, 'mono-job')
    assert.equal(calls[0][0], 'https://tracks.monochrome.st/track/155142501534011392')
    assert.deepEqual(calls[0][1].tags, {
      title: 'Get Lucky', artist: 'Daft Punk', album: 'Random Access Memories',
      cover: 'https://tracks.monochrome.st/cover.jpg',
      year: undefined, track: undefined, disc: undefined, isrc: undefined, genre: undefined,
    })
  } finally {
    delete globalThis.__testMonochromeApi
  }
})
