// Non-actionable translation/romanization status messages belong only to the
// full-screen lyrics experience. Sidebar lyrics must not leave a persistent
// overlay on top of the song when a subline cannot be provided.
export function sublineStatusNotice({
  fullscreen = false,
  wantTranslation = false,
  translationState = 'idle',
  subline = 'none',
  romanizationState = 'idle',
} = {}) {
  if (!fullscreen) return ''
  if (wantTranslation && translationState === 'same-language') return 'Already in your language'
  if (wantTranslation && translationState === 'unavailable') return 'Translation unavailable right now'
  if (subline === 'romanization' && romanizationState === 'unavailable') return 'Romanization unavailable right now'
  return ''
}
