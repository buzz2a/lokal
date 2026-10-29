import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { parseAny } = require('../electron/lyrics/detect')
const { finish } = require('../electron/lyrics/postprocess')
const local = require('../electron/lyrics/providers/local')
const service = require('../electron/lyrics/service')

// Representative of FLAC Vorbis LYRICS/UNSYNCEDLYRICS from lrc.red via Mornye:
// the v1/v2 labels annotate vocal parts; they are not sung words.
const LRC = [
  '[ti:Call On Me]',
  '[ar:RAYE]',
  '[by:Mornye (source: lrc.red)]',
  '',
  '[00:02.916]v1:(You can call on me)',
  "[00:14.486]v1:And I'll share blame",
  '[00:16.939]v1:If lies are true',
].join('\n')
const processed = raw => {
  const parsed = parseAny(raw)
  assert.ok(parsed, 'lyrics parser should recognize the input')
  return finish(parsed.lines, { source: 'local', doc: parsed.doc })
}
const sung = result => result.lines.filter(l => l.text)

// Build only the FLAC metadata blocks, without shipping a copyrighted recording.
function taggedFlac(fields, directory) {
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
  const vendor = Buffer.from('Mornye')
  const items = fields.map(x => Buffer.from(x))
  const comment = Buffer.concat([
    u32(vendor.length), vendor, u32(items.length),
    ...items.flatMap(item => [u32(item.length), item]),
  ])
  const block = (kind, isLast, data) => {
    const h = Buffer.alloc(4)
    h[0] = (isLast ? 0x80 : 0) | kind
    h.writeUIntBE(data.length, 1, 3)
    return Buffer.concat([h, data])
  }
  const streamInfo = Buffer.alloc(34)
  streamInfo.writeUInt16BE(4096, 0)
  streamInfo.writeUInt16BE(4096, 2)
  streamInfo[10] = 0x0a; streamInfo[11] = 0xc4; streamInfo[12] = 0x42; streamInfo[13] = 0xf0
  const file = path.join(directory, 'song.flac')
  fs.writeFileSync(file, Buffer.concat([Buffer.from('fLaC'), block(0, false, streamInfo), block(4, true, comment)]))
  return file
}

test('Mornye line LRC removes only voice annotations, keeps timing and classifies line sync accurately', () => {
  const result = processed(LRC)
  assert.equal(result.type, 'synced')
  assert.equal(result.sync, 'line')
  assert.deepEqual(sung(result).map(l => [l.time, l.text, l.agent]), [
    [2.916, '(You can call on me)', 'v1'],
    [14.486, "And I'll share blame", 'v1'],
    [16.939, 'If lies are true', 'v1'],
  ])
  assert.ok(sung(result).every(l => !l.words.length), 'do not fabricate word timestamps')
})

test('two annotated voices preserve the duet layout; ordinary mentions of v1 are untouched', () => {
  const duet = processed('[00:01.00]v1:First voice\n[00:02.00]v2:Second voice\n[00:03.00]This is v1: in a sentence')
  assert.equal(duet.duet, true)
  assert.deepEqual(sung(duet).map(l => [l.text, l.agent, l.side]), [
    ['First voice', 'v1', 'start'],
    ['Second voice', 'v2', 'end'],
    ['This is v1: in a sentence', undefined, 'start'],
  ])
})

test('enhanced LRC removes unsung marker units but preserves real word timestamps', () => {
  const result = processed('[00:01.00]<00:01.00>v2: <00:01.40>Hello <00:02.00>world<00:02.80>')
  assert.equal(result.sync, 'syllable')
  const line = sung(result)[0]
  assert.equal(line.agent, 'v2')
  assert.equal(line.text, 'Hello world')
  assert.deepEqual(line.words.map(w => [w.word, w.time]), [['Hello', 1.4], ['world', 2]])
})

test('plain and karaoke LRC also normalize voice labels without losing real timing', () => {
  const plain = processed('v1:One line\nv2:Another line')
  assert.equal(plain.sync, 'none')
  assert.deepEqual(sung(plain).map(l => l.text), ['One line', 'Another line'])
  const karaoke = processed('[1000,2400](1000,100,0)v2:(1100,800,0)Hello (1900,1200,0)world')
  assert.equal(karaoke.sync, 'syllable')
  assert.equal(sung(karaoke)[0].text, 'Hello world')
  assert.equal(sung(karaoke)[0].agent, 'v2')
})

test('FLAC with duplicate embedded lyrics tags preserves synced text and strips markers', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-mornye-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = taggedFlac([`UNSYNCEDLYRICS=${LRC}`, `LYRICS=${LRC}`], dir)
  const found = await local.fetch({ filePath: file })
  assert.ok(found?.raw)
  const result = processed(found.raw)
  assert.equal(result.sync, 'line')
  assert.equal(sung(result)[1].text, "And I'll share blame")
})

test('legacy cached local and pinned lyrics are repaired on read without changing timing', async () => {
  const Database = require('better-sqlite3')
  const db = new Database(':memory:')
  try {
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE tracks (id TEXT PRIMARY KEY, file_path TEXT); CREATE TABLE lyrics_cache (track_id TEXT PRIMARY KEY, lyrics_type TEXT, content TEXT, source TEXT, cached_at INTEGER, fetched_at INTEGER, file_path TEXT, meta TEXT)')
    db.prepare('INSERT INTO tracks (id,file_path) VALUES (?, ?)').run('track1', 'ghost://track1')
    const raw = [
      { time: 2.916, end: null, text: 'v1:Call my name', words: [] },
      { time: 6.811, end: null, text: 'v2:When you are alone', words: [] },
    ]
    db.prepare('INSERT INTO lyrics_cache (track_id,lyrics_type,content,source,fetched_at,meta) VALUES (?,?,?,?,?,?)')
      .run('track1', 'synced', JSON.stringify(raw), 'local', Date.now(), JSON.stringify({ v: 2, sync: 'line', duet: false, pinned: true }))
    const result = await service.getLyrics(db, { trackId: 'track1', title: 'Song', artist: 'Artist', duration: 12 })
    assert.equal(result.duet, true)
    assert.equal(result.pinned, true)
    assert.deepEqual(sung(result).map(l => l.text), ['Call my name', 'When you are alone'])
    assert.deepEqual(sung(result).map(l => l.time), [2.916, 6.811])
    assert.ok(!db.prepare('SELECT content FROM lyrics_cache WHERE track_id = ?').get('track1').content.includes('v1:'))
    const again = await service.getLyrics(db, { trackId: 'track1', title: 'Song', artist: 'Artist', duration: 12 })
    assert.deepEqual(sung(again).map(l => l.text), sung(result).map(l => l.text))
  } finally { db.close() }
})
