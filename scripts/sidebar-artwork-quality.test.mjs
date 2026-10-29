import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { artworkCandidates } from '../src/artworkQuality.mjs'

const sidebar = readFileSync(new URL('../src/components/RightSidebar.jsx', import.meta.url), 'utf8')
const artwork = sidebar.split('function SidebarStillArtwork({ track }) {')[1]
  ?.split('export default function RightSidebar()')[0]

test('right sidebar renders full-size artwork without enlarging only the generated thumbnail', () => {
  assert.ok(artwork, 'dedicated sidebar artwork renderer exists')
  assert.match(artwork, /trackFullArtURL\(track\) \|\| thumbnail/,
    'prefer the full original for locally indexed artwork')
  assert.match(artwork, /artworkCandidates\(full\)/,
    'promote known CDN thumbnail variants to higher resolution')
  assert.match(sidebar, /<SidebarStillArtwork track=\{track\} \/>/,
    'transition layers use the full-resolution renderer')
  assert.doesNotMatch(sidebar, /<img src=\{trackArtURL\(track\)\}/,
    'do not directly stretch the small thumbnail into the sidebar hero')
})

test('side panel keeps the existing cover while high resolution loads or fails', () => {
  assert.match(artwork, /thumbnail && <img src=\{thumbnail\}/)
  assert.match(artwork, /upgraded && upgraded !== thumbnail/)
  assert.match(artwork, /resolved\.key === sourceKey/,
    'an asynchronous load must never display the previous song cover')
  assert.match(artwork, /return \(\) => \{ active = false \}/,
    'discard pending results when the track artwork changes')
  assert.match(artwork, /Math\.min\(image\.naturalWidth, image\.naturalHeight\)/,
    'skip tiny HTTP-200 placeholder art when a larger variant is available')
})

test('provider-specific full-size candidates preserve the original as fallback', () => {
  const thumbnail = 'https://i.ytimg.com/vi/123456789ab/hqdefault.jpg'
  const candidates = artworkCandidates(thumbnail)
  assert.equal(candidates[0], 'https://i.ytimg.com/vi/123456789ab/maxresdefault.jpg')
  assert.equal(candidates[candidates.length - 1], thumbnail)
})
