import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { createUpdateInstaller, shouldQuitOnWindowClosed } = require('../electron/updaterInstall.js')

test('install starts immediately and requests a relaunch after the NSIS installer', () => {
  const calls = []
  const handler = createUpdateInstaller(
    { quitAndInstall: (...args) => calls.push(['quitAndInstall', ...args]) },
    { onStart: () => calls.push(['start']) },
  )

  assert.deepEqual(handler.install(), { error: 'Update download has not completed' })
  assert.deepEqual(calls, [], 'install must wait for update-downloaded')

  handler.markDownloaded()
  assert.deepEqual(handler.install(), { installing: true })
  assert.deepEqual(calls, [['start'], ['quitAndInstall', false, true]])
  assert.deepEqual(handler.install(), { installing: true })
  assert.equal(calls.length, 2, 'double clicks must not start a second installation')
})

test('a failed installer launch resets updating state and can be retried', () => {
  const failed = new Error('Installer could not start')
  let startCount = 0
  let reportedError
  let quitCalls = 0
  const handler = createUpdateInstaller(
    { quitAndInstall() { if (++quitCalls === 1) throw failed } },
    { onStart: () => { startCount++ }, onError: error => { reportedError = error } },
  )
  handler.markDownloaded()
  assert.deepEqual(handler.install(), { error: failed.message })
  assert.equal(reportedError, failed)
  assert.deepEqual(handler.install(), { installing: true })
  assert.equal(startCount, 2)
  assert.equal(quitCalls, 2)
})

test('updater errors invalidate the ready state', () => {
  const handler = createUpdateInstaller({ quitAndInstall() { throw Error('should not run') } })
  handler.markDownloaded()
  handler.markFailed()
  assert.deepEqual(handler.install(), { error: 'Update download has not completed' })
})

test('windows only request normal app quit outside the updater lifecycle', () => {
  assert.equal(shouldQuitOnWindowClosed('win32', false), true)
  assert.equal(shouldQuitOnWindowClosed('linux', false), true)
  assert.equal(shouldQuitOnWindowClosed('darwin', false), false)
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.equal(shouldQuitOnWindowClosed(platform, true), false)
  }
})
