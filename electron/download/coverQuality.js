// Downloaded addon artwork must be evaluated from the image bytes, not the
// size advertised by a CDN URL (some missing sizes return a tiny 200 image).
// Never search another release/artist: only request alternate sizes of the
// same provider image, then fall back to the supplied original URL.
const COVER_MAX_BYTES = 5 * 1024 * 1024
const COVER_TIMEOUT_MS = 10000
const MIN_ACCEPTED_SIDE = 32
const PREFERRED_SIDE = 1000
const MAX_INPUT_PIXELS = 16 * 1024 * 1024

async function readBoundedBody(response, limit) {
  const reader = response.body?.getReader?.()
  if (!reader) return null
  let total = 0
  const chunks = []
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, total)
  } finally {
    try { reader.releaseLock() } catch {}
  }
}

async function fetchBestCover(url, { fetchImpl = globalThis.fetch, timeoutMs = COVER_TIMEOUT_MS } = {}) {
  if (typeof url !== 'string' || !/^https:\/\/[^\s]{1,1000}$/i.test(url)) return null
  const sharp = require('sharp')
  const { artworkCandidates } = await import('../../src/artworkQuality.mjs')
  const candidates = artworkCandidates(url).filter(candidate => candidate.startsWith('https://'))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let best = null
  try {
    for (const candidate of candidates) {
      if (controller.signal.aborted) break
      try {
        const response = await fetchImpl(candidate, { signal: controller.signal, redirect: 'follow' })
        if (!response.ok) continue
        const declaredType = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase()
        if (!/^image\/(?:jpeg|png|webp)$/.test(declaredType)) continue
        const declaredLength = Number(response.headers.get('content-length'))
        if (declaredLength > COVER_MAX_BYTES) continue
        const bytes = await readBoundedBody(response, COVER_MAX_BYTES)
        if (!bytes?.length) continue
        const meta = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
        if (!['jpeg', 'png', 'webp'].includes(meta.format)) continue
        const width = Number(meta.width) || 0
        const height = Number(meta.height) || 0
        const side = Math.min(width, height)
        if (side < MIN_ACCEPTED_SIDE) continue
        const area = width * height
        if (!best || side > best.side || (side === best.side && area > best.area)) {
          best = { bytes, mime: meta.format === 'jpeg' ? 'image/jpeg' : 'image/' + meta.format, width, height, side, area }
        }
        // Once we have a sufficiently large rendition of this exact image,
        // avoid needless fallback requests and CDN traffic.
        if (side >= PREFERRED_SIDE) break
      } catch {
        // Size variants can return 404, timeout or invalid bytes. Keep the
        // best valid earlier candidate and try the original while time allows.
      }
    }
  } finally { clearTimeout(timer) }
  return best
}

module.exports = { fetchBestCover, readBoundedBody }
