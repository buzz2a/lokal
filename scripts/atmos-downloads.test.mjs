import test from 'node:test'
import assert from 'node:assert/strict'
import { atmosDownloadRef, downloadAtmosVersion } from '../src/atmosDownloads.js'

const provider = 'a-1234567890'
const atmosItem = {
  provider,
  id: 'tidal-track-88',
  title: 'Atmos track',
  artist: 'Artist',
  audio_modes: ['STEREO', 'DOLBY_ATMOS'],
}

test('Atmos download action requires advertised edition and addon identity', () => {
  assert.deepEqual(atmosDownloadRef(atmosItem), { provider, id: atmosItem.id })
  assert.equal(atmosDownloadRef({ ...atmosItem, audio_modes: ['STEREO'] }), null)
  assert.equal(atmosDownloadRef({ ...atmosItem, provider: 'yt' }), null)
  assert.equal(atmosDownloadRef({ ...atmosItem, provider: 'mono' }), null)
})

test('explicit Atmos action pins to the exact addon and opts in only for that download', async () => {
  const calls = []
  const ghost = { file_path: 'ghost://addon/1234567890/tidal-track-88', title: 'Atmos track' }
  const response = await downloadAtmosVersion(atmosItem, {
    client: {
      onlineSave: async rows => {
        calls.push(['save', rows])
        return [ghost]
      },
    },
    save: async (row, options) => {
      calls.push(['download', row, options])
      return { downloadId: 'dl-123' }
    },
  })
  assert.deepEqual(response, { downloadId: 'dl-123' })
  assert.deepEqual(calls[0], ['save', [atmosItem]])
  assert.deepEqual(calls[1], ['download', ghost, { downloadAtmos: true }])
})

test('an Atmos result must not be downloaded through another provider', async () => {
  const response = await downloadAtmosVersion(atmosItem, {
    client: { onlineSave: async () => [{ file_path: 'ghost://youtube/online/abcdefghijk' }] },
    save: async () => { throw Error('must never reach downloader') },
  })
  assert.match(response.error, /same Atmos source/)
})

test('persisted Atmos ghost retains download action after the search result disappears', async () => {
  const persisted = {
    file_path: 'ghost://addon/1234567890/tidal-track-88',
    title: 'Atmos track', artist: 'Artist', atmos_available: 1,
  }
  assert.deepEqual(atmosDownloadRef(persisted),
    { provider: 'a-1234567890', id: 'tidal-track-88' })
  const result = await downloadAtmosVersion(persisted, {
    save: async (track, opts) => {
      assert.equal(track, persisted)
      assert.deepEqual(opts, { downloadAtmos: true })
      return { downloadId: 'atmos-queue' }
    },
  })
  assert.equal(result.downloadId, 'atmos-queue')
})
