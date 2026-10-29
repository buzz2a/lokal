import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sharp = require('sharp')
const { fetchBestCover, readBoundedBody } = require('../electron/download/coverQuality')
const { shouldUpgradeEmbeddedCover } = require('../electron/download/tagger')
const { knownTagsOf } = require('../electron/download/postprocess')

const cover = async (size) => sharp({
  create: { width: size, height: size, channels: 3, background: '#456789' },
}).jpeg().toBuffer()

function response(bytes, status = 200) {
  return {
    ok: status === 200,
    headers: new Headers({ 'content-type': 'image/jpeg', 'content-length': String(bytes.length) }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  }
}

test('download chooses measured full-resolution CDN cover, not URL size alone', async () => {
  const small = await cover(120)
  const full = await cover(1200)
  const urls = []
  const result = await fetchBestCover('https://lh3.googleusercontent.com/record=w120-h120', {
    fetchImpl: async url => {
      urls.push(url)
      return response(url.includes('w1200-h1200') ? full : small)
    },
  })
  assert.equal(result.width, 1200)
  assert.equal(result.height, 1200)
  assert.equal(result.mime, 'image/jpeg')
  assert.equal(urls.length, 1)
})

test('download does not accept a CDN 200-response placeholder as high resolution', async () => {
  const tiny = await cover(120)
  const original = await cover(640)
  const result = await fetchBestCover('https://lh3.googleusercontent.com/record=w120-h120', {
    fetchImpl: async url => response(url.includes('w1200-h1200') ? tiny : original),
  })
  assert.equal(result.width, 640)
})

test('download falls back to valid original when high-res URL returns 404', async () => {
  const original = await cover(640)
  const result = await fetchBestCover('https://lh3.googleusercontent.com/record=w120-h120', {
    fetchImpl: async url => response(original, url.includes('w1200-h1200') ? 404 : 200),
  })
  assert.equal(result.width, 640)
})

test('existing embedded covers are upgraded only for substantial pixel improvement', async () => {
  const small = await cover(120)
  const medium = await cover(450)
  const decent = await cover(800)
  const big = await cover(1200)
  assert.equal(await shouldUpgradeEmbeddedCover(small, big), true)
  assert.equal(await shouldUpgradeEmbeddedCover(medium, big), true)
  assert.equal(await shouldUpgradeEmbeddedCover(decent, big), false)
  assert.equal(await shouldUpgradeEmbeddedCover(small, medium), true)
  assert.equal(await shouldUpgradeEmbeddedCover(big, small), false)
  assert.equal(await shouldUpgradeEmbeddedCover(small, Buffer.from('invalid')), false)
})

test('unknown/signed artwork URL is never rewritten', async () => {
  const full = await cover(900)
  const signed = 'https://covers.example/track.jpg?token=signed'
  const requests = []
  const result = await fetchBestCover(signed, {
    fetchImpl: async url => { requests.push(url); return response(full) },
  })
  assert.equal(result.width, 900)
  assert.deepEqual(requests, [signed])
})

test('streamed artwork refuses oversized response without buffering it', async () => {
  let cancelled = false
  const response = {
    body: new ReadableStream({
      pull(controller) { controller.enqueue(Buffer.alloc(1024)) },
      cancel() { cancelled = true },
    }),
  }
  const result = await readBoundedBody(response, 512)
  assert.equal(result, null)
  assert.equal(cancelled, true)
})

test('known addon metadata validator remains available at module load', () => {
  const tags = knownTagsOf({ title: 'A', artist: 'B',
    cover: 'https://cdn.example/cover.jpg',
    isrc: 'USABC1234567' })
  assert.equal(tags.cover, 'https://cdn.example/cover.jpg')
  assert.equal(tags.isrc, 'USABC1234567')
  assert.equal(knownTagsOf({ cover: 'https://cdn.example/only.jpg' }), undefined)
})
