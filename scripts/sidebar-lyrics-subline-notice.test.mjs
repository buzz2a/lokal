import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sublineStatusNotice } from '../src/lyrics/sublineNotice.mjs'

test('sidebar lyrics suppress non-actionable translation and romanization status overlays', () => {
  const statuses = [
    { wantTranslation: true, translationState: 'same-language' },
    { wantTranslation: true, translationState: 'unavailable' },
    { subline: 'romanization', romanizationState: 'unavailable' },
    { wantTranslation: true, translationState: 'same-language', subline: 'romanization', romanizationState: 'unavailable' },
  ]
  for (const state of statuses) {
    assert.equal(sublineStatusNotice({ fullscreen: false, ...state }), '')
    assert.equal(sublineStatusNotice(state), '')
  }
})

test('fullscreen lyrics still show translation and romanization status feedback', () => {
  assert.equal(
    sublineStatusNotice({ fullscreen: true, wantTranslation: true, translationState: 'same-language' }),
    'Already in your language',
  )
  assert.equal(
    sublineStatusNotice({ fullscreen: true, wantTranslation: true, translationState: 'unavailable' }),
    'Translation unavailable right now',
  )
  assert.equal(
    sublineStatusNotice({ fullscreen: true, subline: 'romanization', romanizationState: 'unavailable' }),
    'Romanization unavailable right now',
  )
})

test('only active subline failures produce feedback', () => {
  assert.equal(sublineStatusNotice({ fullscreen: true, translationState: 'unavailable' }), '')
  assert.equal(sublineStatusNotice({ fullscreen: true, romanizationState: 'unavailable' }), '')
  assert.equal(sublineStatusNotice({ fullscreen: true, wantTranslation: true, translationState: 'ready' }), '')
  assert.equal(
    sublineStatusNotice({ fullscreen: true, translationState: 'same-language', subline: 'romanization', romanizationState: 'unavailable' }),
    'Romanization unavailable right now',
    'an inactive translation must not override the active romanization status',
  )
})
