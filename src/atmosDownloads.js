// An Atmos edition is a separate user action, not the configured stereo tier.
// Validate the advertised mode before saving; pin to the same Mornye addon.
import { api } from './api.js'
import { atmosAvailable } from './quality.js'
import { isAddonProvider, streamRef, saveToLibrary } from './onlineTracks.js'

export function atmosDownloadRef(track, source = null) {
  const ref = source || streamRef(track) ||
    (track?.provider && track?.id != null
      ? { provider: track.provider, id: String(track.id) } : null)
  return ref && isAddonProvider(ref.provider) && String(ref.id || '')
    && atmosAvailable(track) ? ref : null
}

/** A result may not yet be saved as a queue ghost; onlineSave pins its exact
 * provider/id, instead of resolving through a different playback source.
 */
export async function downloadAtmosVersion(track, { client = api, save = saveToLibrary } = {}) {
  const ref = atmosDownloadRef(track)
  if (!ref) return { error: 'This track does not advertise an Atmos edition on an addon source.' }
  let ghost = streamRef(track) ? track : null
  if (!ghost) {
    const created = await client.onlineSave([track])
    ghost = Array.isArray(created) ? created[0] : null
  }
  if (!ghost || streamRef(ghost)?.provider !== ref.provider ||
      streamRef(ghost)?.id !== String(ref.id)) {
    return { error: 'Could not resolve the same Atmos source to a download.' }
  }
  return save(ghost, { downloadAtmos: true })
}
