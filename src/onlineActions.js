// Playing and downloading the songs of the online album and artist pages
// (see onlineBrowse.js), with progress in a toast.

import { api } from './api.js'
import { libraryDownloadMessage, saveTracksToLibrary } from './onlineTracks.js'
import { playRecommendationPool } from './recommendationPlayback.js'
import { playableRecommendation, playbackFallbackMessage, playbackSources, resolveRecommendationTracks, songKey } from './recommendations.js'
import { showLoadingToast, showToast } from './components/Toaster.jsx'

// Songs already found in the playback sources this session, by song: playing
// another song of the same list again reuses them instead of searching every
// remaining song again.
const FOUND_TTL_MS = 30 * 60 * 1000
const FOUND_LIMIT = 2000
const found = new Map()

function foundRow(track) {
  const hit = found.get(songKey(track))
  if (hit && hit.at > Date.now() - FOUND_TTL_MS && playableRecommendation(hit.row)) return hit.row
  return null
}

function rememberFound(track, row) {
  const key = songKey(track)
  found.delete(key)
  found.set(key, { row, at: Date.now() })
  if (found.size > FOUND_LIMIT) found.delete(found.keys().next().value)
}

/** Find each song on its own (so each answer is remembered), from what was found before when it can. */
async function resolveRemembered(rows, options, sources) {
  const out = await Promise.all(rows.map(async track => {
    const known = foundRow(track)
    if (known) return known
    const [row] = await resolveRecommendationTracks([track], undefined, { ...options, sources }).catch(() => [])
    if (row) rememberFound(track, row)
    return row || null
  }))
  return out.filter(Boolean)
}

/** Play `tracks` from `selected` (or the first), finding each in the playback sources. */
export async function playOnline(tracks, { selected, name, path, isCurrent = () => true } = {}) {
  const first = selected || tracks[0]
  if (!first) return false
  const toast = showLoadingToast(`Finding “${first.title}”…`)
  let detail = ''
  try {
    const sources = await playbackSources()
    const started = await playRecommendationPool(tracks, {
      selected, firstPlayable: true, isCurrent,
      resolve: (rows, options) => resolveRemembered(rows, options, sources),
      context: { type: 'discovery', name, path },
      onProgress: message => { if (isCurrent()) toast.update(message) },
      onProviderFailure: failure => { if (isCurrent()) { if (failure.detail) detail = failure.detail; toast.update(playbackFallbackMessage(failure)) } },
    })
    toast.close(isCurrent() && started === false ? detail ? `Could not play “${first.title}”. ${detail}` : `No playable source was found for “${first.title}”.` : '')
    return started
  } catch {
    toast.close(isCurrent() ? `Could not load “${first.title}”.` : '')
    return false
  }
}

/** Find `tracks` in the playback sources (without preparing streams). */
export async function resolveOnline(tracks, { label, isCurrent = () => true } = {}) {
  const toast = showLoadingToast(`Finding ${label || (tracks.length === 1 ? `“${tracks[0].title}”` : `${tracks.length} songs`)}…`)
  try {
    const rows = await resolveRecommendationTracks(tracks.map(track => foundRow(track) || track), api, { isCurrent, prepareStreams: false, onProgress: message => { if (isCurrent()) toast.update(message) } })
    toast.close(!rows.length && isCurrent() ? `No playable source was found for ${label || 'these songs'}.` : '')
    return isCurrent() ? rows : []
  } catch {
    toast.close(isCurrent() ? `Could not load ${label || 'these songs'}.` : '')
    return []
  }
}

/** Download `tracks` to the library, from the best playback source for each. */
export async function downloadOnline(tracks, { label, isCurrent = () => true } = {}) {
  const rows = await resolveOnline(tracks, { label, isCurrent })
  if (!rows.length) return
  const result = await saveTracksToLibrary(rows, { isCurrent })
  result.failed += tracks.length - rows.length
  showToast(libraryDownloadMessage(result))
}
