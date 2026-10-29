// Global artist IDs belong to a *metadata catalogue*, not Lokal's library.
// Keeping both the catalogue and opaque artist ID in the URL distinguishes
// namesakes (and remains correct across Back/Forward or page remounts).
import { artistIdFromName } from './artistId.js'

const CATALOGUES = new Set(['apple', 'spotify'])
const safe = value => String(value ?? '').trim()

export function globalArtistDestination(artist) {
  const name = safe(typeof artist === 'string' ? artist : artist?.name || artist?.title)
  if (!name) return null
  const catalogue = safe(artist?.catalogue).toLowerCase()
  const catalogueId = safe(artist?.catalogue_id || artist?.id)
  const selected = CATALOGUES.has(catalogue) && !!catalogueId
    ? { catalogue, artistId: catalogueId, name } : null
  const pathname = `/artist/${artistIdFromName(name)}`
  if (!selected) return { pathname, state: { name } }
  const params = new URLSearchParams({
    catalogue: selected.catalogue, catalogueArtistId: selected.artistId, name,
  })
  return { pathname, search: `?${params}`, state: { name, catalogueArtist: selected } }
}

export function selectedGlobalArtist(location, routeId) {
  const params = new URLSearchParams(location?.search || '')
  const catalogue = safe(params.get('catalogue')).toLowerCase()
  const artistId = safe(params.get('catalogueArtistId'))
  const name = safe(params.get('name') || location?.state?.name)
  // Only valid catalogue navigation with a matching artist URL can force
  // the online page. An arbitrary state.name never overrides local lookup.
  if (!CATALOGUES.has(catalogue) || !artistId || !name ||
      artistIdFromName(name) !== routeId) return null
  return { catalogue, artistId, name }
}

export function createGlobalArtistOpener(navigate, onLocalArtistClick) {
  return (origin, artist) => {
    if (origin === 'library') return onLocalArtistClick?.(artist)
    const target = globalArtistDestination(artist)
    if (!target) return
    const { state, ...route } = target
    navigate(route, { state })
  }
}
