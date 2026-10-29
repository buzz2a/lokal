import React, { useEffect, useRef, useState } from 'react'
import { Clock, Disc3, Download, ExternalLink, Heart, ListEnd, Music, Play, Plus, Radio, User } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { playRecommendationPool } from '../recommendationPlayback'
import { resolveOnline, downloadOnline } from '../onlineActions'
import { addToPlaylistMany, addToQueueMany, playNextMany } from '../trackActions'
import { openRadio } from '../radioActions'
import { createGlobalArtistOpener } from '../globalArtistNavigation.mjs'
import { useAppStore, usePlayerStore } from '../store/player'
import ContextMenu, { useContextMenu } from './ContextMenu'
import { showToast, showLoadingToast } from './Toaster'
import { onlineAlbumPath } from '../onlineBrowse'
import QualityImage from './QualityImage'
import SearchArtistPortrait from './SearchArtistPortrait'
import { includesResultCategory, mergeSearchArtists, mergeSearchAlbums } from '../searchResultCategory.mjs'
import { plural } from '../plural'

const EMPTY = { tracks: [], albums: [], artists: [] }
const PAGE_SIZE = 25

/** Global metadata never chooses a streaming provider. A clicked title is
 * matched through Playback > Source Priority by the existing resolver. */
export default function GlobalCatalogueResults({
  query, category = 'all', enableOnline = true,
  localArtists = [], localAlbums = [], onLocalArtistClick, onLocalAlbumClick,
}) {
  const nav = useNavigate()
  const menu = useContextMenu()
  const q = String(query || '').trim()
  const [results, setResults] = useState(EMPTY)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [retry, setRetry] = useState(0)
  const seq = useRef(0)
  const locale = (typeof navigator !== 'undefined' ? navigator.language : 'en-US').split('-')[1] || 'US'
  useEffect(() => {
    const version = ++seq.current
    setResults(EMPTY); setError(''); setNotice(''); setHasMore(false); setExpanded(false); setLoadingMore(false)
    if (!enableOnline || q.length < 2) { setBusy(false); return }
    setBusy(true)
    const timer = setTimeout(async () => {
      try {
        const found = await api.globalCatalogueSearch(q, { country: locale, limit: PAGE_SIZE })
        if (version !== seq.current) return
        if (found?.error) throw new Error(found.error)
        const clean = {
          tracks: Array.isArray(found?.tracks) ? found.tracks : [],
          albums: Array.isArray(found?.albums) ? found.albums : [],
          artists: Array.isArray(found?.artists) ? found.artists : [],
        }
        setResults(clean); setHasMore(clean.tracks.length === PAGE_SIZE)
        setNotice(found.fallback ? found.notice || 'Spotify unavailable; showing Apple Music.' : found.partial ? 'Spotify currently supplies only song results through this session.' : '')
      } catch (e) {
        if (version === seq.current) setError(e?.message || 'Global catalogue unavailable.')
      } finally {
        if (version === seq.current) setBusy(false)
      }
    }, 350)
    return () => { clearTimeout(timer); seq.current++ }
  }, [q, locale, retry, enableOnline])
  useEffect(() => {
    const changed = () => setRetry(value => value + 1)
    window.addEventListener('lokal:settings-saved', changed)
    return () => window.removeEventListener('lokal:settings-saved', changed)
  }, [])

  const more = async () => {
    if (loadingMore) return
    const version = seq.current
    setLoadingMore(true)
    try {
      const found = await api.globalCatalogueSearch(q, { country: locale, limit: PAGE_SIZE, offset: results.tracks.length })
      if (version !== seq.current) return
      if (found?.error) throw new Error(found.error)
      const rows = Array.isArray(found?.tracks) ? found.tracks : []
      const known = new Set(results.tracks.map(t => t.id))
      setResults(state => ({ ...state, tracks: [...state.tracks, ...rows.filter(t => !known.has(t.id))] }))
      setHasMore(rows.length === PAGE_SIZE)
    } catch (e) {
      if (version === seq.current) setError(e?.message || 'Could not load more songs.')
    } finally { if (version === seq.current) setLoadingMore(false) }
  }

  const play = async song => {
    if (playing) return
    setPlaying(song.id)
    const toast = showLoadingToast('Finding “' + song.title + '” through your source priority…')
    try {
      // Only metadata goes to the resolver; do NOT send Apple's catalogue ID
      // as an exact provider/stream ID.
      const candidates = results.tracks.map(({ id, title, artist, album, duration, artwork_url }) => (
        { id, title, artist, album, duration, artwork_url }
      ))
      const selected = candidates.find(row => row.id === song.id)
      const ok = await playRecommendationPool(candidates, {
        selected, context: { type: 'global', id: q, name: 'Global: ' + q },
        returnAfterStart: true,
      })
      toast.close()
      if (ok === false) showToast('No configured playback source could play “' + song.title + '”.')
    } catch (e) {
      toast.close()
      showToast(e?.message || 'Could not resolve this song.')
    } finally { setPlaying('') }
  }


  // Global catalogue IDs identify metadata, not playable streams. Use the
  // source-priority resolver for actions that need a real library/ghost track.
  const withResolvedSong = async (song, action) => {
    const [track] = await resolveOnline([song])
    if (track) await action(track)
  }
  const toggleSongLike = song => withResolvedSong(song, async track => {
    const userId = useAppStore.getState().user?.id
    const result = await api.toggleLike(track.id, userId, track)
    if (result?.error) { showToast(result.error); return }
    if (userId !== useAppStore.getState().user?.id) return
    const liked = typeof result === 'boolean' ? result : result?.liked ?? false
    usePlayerStore.getState().setLiked(track.id, liked)
    showToast(liked ? 'Added to Liked Songs' : 'Removed from Liked Songs')
  })
  // Both the card and its context menu share this opener. Catalogue cards
  // carry their source and artist ID, so same-named local artists cannot
  // intercept navigation to a different catalogue identity.
  const openArtist = createGlobalArtistOpener(nav, onLocalArtistClick)
  const navigateGlobalArtist = name => openArtist('online', name)
  const openSongMenu = (event, song) => menu.open(event, [
    { label: 'Play', icon: Play, onSelect: () => play(song) },
    { label: 'Play next', icon: Clock, onSelect: () => withResolvedSong(song, track => playNextMany([track])) },
    { label: 'Add to queue', icon: ListEnd, onSelect: () => withResolvedSong(song, track => addToQueueMany([track])) },
    { label: 'Add to playlist…', icon: Plus, onSelect: () => withResolvedSong(song, track => addToPlaylistMany([track])) },
    // The catalogue has no library track ID to check the current like state.
    { label: 'Like / Unlike', icon: Heart, onSelect: () => toggleSongLike(song) },
    { label: 'Download song', icon: Download, onSelect: () => downloadOnline([song]) },
    { separator: true },
    song.album && { label: 'Go to album', icon: Disc3, onSelect: () => nav(onlineAlbumPath({ artist: song.artist, album: song.album }), { state: { artwork: song.artwork_url } }) },
    song.artist && { label: 'Go to artist', icon: User, onSelect: () => navigateGlobalArtist(song.artist) },
    { label: 'Start radio', icon: Radio, onSelect: () => openRadio(nav, song, useAppStore.getState().user?.id) },
  ])
  const openAlbum = (origin, album) => origin === 'library'
    ? onLocalAlbumClick?.(album)
    : nav(onlineAlbumPath({ artist: album.artist, album: album.title }), { state: { artwork: album.artwork_url } })
  const openAlbumMenu = (event, origin, album) => menu.open(event, [
    { label: 'Open album', icon: ExternalLink, onSelect: () => openAlbum(origin, album) },
    (album.artist || album.album_artist) && { label: 'Go to artist', icon: User, onSelect: () => navigateGlobalArtist(album.artist || album.album_artist) },
    { label: 'Start album radio', icon: Radio, onSelect: () => openRadio(nav, { type: 'album', title: album.title, artist: album.artist || album.album_artist }, useAppStore.getState().user?.id) },
  ])
  const openArtistMenu = (event, origin, artist) => menu.open(event, [
    { label: 'Open artist', icon: ExternalLink, onSelect: () => openArtist(origin, artist) },
    { label: 'Start artist radio', icon: Radio, onSelect: () => openRadio(nav, { type: 'artist', artist: artist.name || artist.title }, useAppStore.getState().user?.id) },
  ])

  if (!q.length) return null
  const showSongs = includesResultCategory(category, 'songs')
  const showArtists = includesResultCategory(category, 'artists')
  const showAlbums = includesResultCategory(category, 'albums')
  const artists = mergeSearchArtists(localArtists, enableOnline ? results.artists : [])
  const albums = mergeSearchAlbums(localAlbums, enableOnline ? results.albums : [])
  const hasResults = (showSongs && enableOnline && results.tracks.length > 0) ||
    (showArtists && artists.length > 0) || (showAlbums && albums.length > 0)
  return <section className="space-y-3">
    {enableOnline && notice && <p className="text-xs text-amber-400" role="status">{notice}</p>}
    {enableOnline && busy && <p className="text-xs text-muted" role="status">Searching the global catalogue…</p>}
    {enableOnline && error && <p className="text-xs text-muted" role="status">{error} <button className="underline" onClick={() => setRetry(value => value + 1)}>Retry</button></p>}
    {enableOnline && !busy && !error && !hasResults &&
      <p className="text-xs text-muted">No catalogue matches found.</p>}
    {enableOnline && showSongs && results.tracks.length > 0 && <div aria-label="Online songs">
      <div className="space-y-0.5">
        {(expanded ? results.tracks : results.tracks.slice(0, 8)).map(row => <button key={row.id} disabled={!!playing} onClick={() => play(row)} onContextMenu={event => openSongMenu(event, row)}
          className="w-full flex items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.06] disabled:opacity-60">
          <span className="h-11 w-11 overflow-hidden rounded-md bg-card shrink-0">{row.artwork_url ? <QualityImage src={row.artwork_url} className="w-full h-full object-cover" /> : <span className="flex h-full items-center justify-center"><Music size={18}/></span>}</span>
          <span className="min-w-0 flex-1"><span className="block truncate text-sm text-white">{row.title}</span><span className="block truncate text-xs text-muted">{row.artist}{row.album ? ' · ' + row.album : ''}</span></span>
          <Play size={15} className="text-muted shrink-0"/>
        </button>)}
      </div>
      {!expanded && results.tracks.length > 8 && <button onClick={() => setExpanded(true)} className="mt-2 text-xs text-accent hover:underline">Show more global songs</button>}
      {expanded && hasMore && <button disabled={loadingMore} onClick={more} className="mt-2 text-xs text-accent hover:underline disabled:opacity-50">{loadingMore ? 'Loading…' : 'Load more global songs'}</button>}
      {expanded && <button onClick={() => setExpanded(false)} className="ml-4 text-xs text-muted hover:underline">Show fewer</button>}
    </div>}
    {showAlbums && albums.length > 0 && <div aria-label={enableOnline ? 'Online albums' : 'Albums'}>
      <div className="grid grid-cols-3 @sm:grid-cols-5 gap-2">
        {albums.map(({ origin, item: row, key }) => (
          <button key={origin + ':' + key} className="min-w-0 text-left"
            onContextMenu={event => openAlbumMenu(event, origin, row)}
            onClick={() => openAlbum(origin, row)}>
            <span className="block aspect-square rounded-md overflow-hidden bg-card">
              {origin === 'library'
                ? (api.albumArtURL(row) ? <img src={api.albumArtURL(row)} alt="" className="w-full h-full object-cover" /> : <span className="h-full flex items-center justify-center"><Disc3 size={20}/></span>)
                : (row.artwork_url ? <QualityImage src={row.artwork_url} className="w-full h-full object-cover"/> : <span className="h-full flex items-center justify-center"><Disc3 size={20}/></span>)}
            </span>
            <span className="block truncate text-xs mt-1">{row.title || row.name}</span>
            <span className="block truncate text-[11px] text-muted">
              {origin === 'library' ? plural(row.track_count ?? 0, 'track') : row.artist}
            </span>
          </button>
        ))}
      </div>
    </div>}
    {showArtists && artists.length > 0 && <div aria-label={enableOnline ? 'Online artists' : 'Artists'}>
      <div className="grid grid-cols-3 @sm:grid-cols-5 @md:grid-cols-6 gap-3">
        {artists.map(({ origin, item: row, key }) => (
          <button key={origin + ':' + key}
            onContextMenu={event => openArtistMenu(event, origin, row)}
            onClick={() => openArtist(origin, row)}
            className="flex flex-col items-center gap-2 group min-w-0">
            <span className="w-full aspect-square rounded-full bg-elevated border border-border overflow-hidden flex items-center justify-center text-muted group-hover:border-accent/40">
              <SearchArtistPortrait
                name={row.name || row.title}
                localPath={origin === 'library' ? row.image_path : null}
                imageUrl={row.artwork_url}
              />
            </span>
            <span className="text-xs text-center text-muted group-hover:text-white truncate w-full">{row.name || row.title}</span>
          </button>
        ))}
      </div>
    </div>}
    <ContextMenu menu={menu} />
  </section>
}
