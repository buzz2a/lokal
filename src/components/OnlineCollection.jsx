// Pieces shared by the chart pages (Beatport, Shazam): a cached loader, a
// cover, a song list with play, shuffle, download and save, and a grid of
// covers. Songs play, queue and download from the playback sources like any
// other online song (onlineActions.js).

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Disc3, Download, ExternalLink, ListPlus, Loader2, Play, Shuffle } from 'lucide-react'
import FadeImg from './FadeImg'
import OnlineSongList from './OnlineSongList'
import RefreshButton from './RefreshButton'
import { showToast } from './Toaster'
import { api } from '../api'
import { downloadOnline, playOnline, resolveOnline } from '../onlineActions'
import { saveAsPlaylist } from '../trackActions'
import { plural } from '../plural'

const CACHE_TTL_MS = 10 * 60 * 1000

export const pill = 'inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-white transition-colors hover:border-accent/50 disabled:opacity-40'

export const shuffled = list => {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Load `key` with `loader`, from `cache` (a Map kept for the session) when
 * fresh; `reload()` loads it again. A loader answers the data or { error, signedOut }.
 */
export function useCachedLoad(cache, key, loader, { noAnswer = 'No answer.' } = {}) {
  const [state, setState] = useState(() => ({ loading: !!key, data: null, error: '', signedOut: false, loadedAt: 0 }))
  const [reload, setReload] = useState(0)
  const request = useRef(0)
  useEffect(() => {
    if (!key) { setState({ loading: false, data: null, error: '', signedOut: false, loadedAt: 0 }); return }
    const id = ++request.current
    const cached = cache.get(key)
    if (cached && !reload && cached.at > Date.now() - CACHE_TTL_MS) { setState({ loading: false, data: cached.data, error: '', signedOut: false, loadedAt: cached.at }); return }
    setState(current => ({ ...current, loading: true, error: '' }))
    Promise.resolve(loader()).catch(error => ({ error: error.message })).then(result => {
      if (id !== request.current) return
      if (!result || result.error) { setState({ loading: false, data: null, error: result?.error || noAnswer, signedOut: !!result?.signedOut, loadedAt: 0 }); return }
      const at = Date.now()
      cache.set(key, { at, data: result })
      setState({ loading: false, data: result, error: '', signedOut: false, loadedAt: at })
    })
  }, [key, reload]) // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: () => setReload(n => n + 1) }
}

export function Cover({ src, className = '' }) {
  return (
    <div className={`overflow-hidden rounded-xl border border-border bg-elevated ${className}`}>
      {src ? <FadeImg src={src} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-muted"><Disc3 size={36} /></div>}
    </div>
  )
}

/**
 * A list of online songs with play, shuffle, download and save.
 * @param source   where the list comes from ("Beatport"): the saved playlist's description
 * @param url      the list on the web, as a button named `urlLabel` (`source` by default)
 * @param numbered number the songs (a chart)
 * @param showMeta show each song's BPM and key
 */
export function TrackCollection({ source, name, subtitle, image, tracks, path, loading, error, loadedAt, onRefresh, onBack, url, urlLabel = source, numbered = false, showMeta = false }) {
  const [busy, setBusy] = useState('')
  const label = `“${name}”`
  const run = async (key, work) => {
    if (busy) return
    setBusy(key)
    try { await work() } finally { setBusy('') }
  }
  const play = (selected, list = tracks) => playOnline(list, { selected, name, path })
  const download = () => run('download', () => downloadOnline(tracks, { label }))
  const savePlaylist = () => run('playlist', async () => {
    const rows = await resolveOnline(tracks, { label })
    if (!rows.length) return
    const playlist = await saveAsPlaylist(name, rows, { description: `From ${source}${subtitle ? ` · ${subtitle}` : ''}`, coverURL: /^https:\/\//.test(image) ? image : undefined }).catch(() => null)
    showToast(playlist ? `Saved ${label} as a playlist.` : `Could not save ${label}.`)
  })
  const duration = useMemo(() => tracks.reduce((sum, track) => sum + (Number(track.duration) || 0), 0), [tracks])

  return (
    <div>
      {onBack && <button onClick={onBack} className="mb-5 inline-flex items-center gap-2 text-xs text-muted transition-colors hover:text-white"><ArrowLeft size={14} /> Back</button>}
      <div className="mb-6 flex flex-col gap-5 @md:flex-row @md:items-end">
        {image !== undefined && <Cover src={image} className="h-36 w-36 flex-shrink-0 shadow-xl" />}
        <div className="min-w-0">
          <h2 className="truncate text-2xl font-display text-white">{name}</h2>
          {subtitle && <p className="mt-1 truncate text-sm text-muted">{subtitle}</p>}
          {!loading && tracks.length > 0 && <p className="mt-1 text-xs text-subtle">{plural(tracks.length, 'song')}{duration ? ` · ${Math.round(duration / 60)} min` : ''}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button onClick={() => play(tracks[0])} disabled={!tracks.length} className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-medium text-base transition-opacity hover:opacity-90 disabled:opacity-40"><Play size={15} fill="currentColor" /> Play</button>
            <button onClick={() => { const list = shuffled(tracks); play(list[0], list) }} disabled={!tracks.length} className={pill}><Shuffle size={15} /> Shuffle</button>
            <button onClick={download} disabled={!tracks.length || !!busy} className={pill}><Download size={15} /> {busy === 'download' ? 'Finding songs…' : 'Download all'}</button>
            <button onClick={savePlaylist} disabled={!tracks.length || !!busy} className={pill}><ListPlus size={15} /> {busy === 'playlist' ? 'Saving…' : 'Save as playlist'}</button>
            {url && <button onClick={() => api.openExternal(url)} className={pill}><ExternalLink size={15} /> {urlLabel}</button>}
            {onRefresh && <RefreshButton onClick={onRefresh} loading={loading} loadedAt={loadedAt} />}
          </div>
        </div>
      </div>
      {loading && !tracks.length
        ? <p role="status" className="flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" /> Loading songs…</p>
        : error
          ? <p role="status" className="rounded-xl border border-border bg-elevated p-4 text-sm text-red-300">{error}</p>
          : tracks.length
            ? <OnlineSongList tracks={tracks} numbered={numbered} showAlbum showMeta={showMeta} onPlay={track => play(track)} />
            : <p role="status" className="rounded-xl border border-border bg-elevated p-4 text-sm text-muted">No songs here.</p>}
    </div>
  )
}

/** Playlists or charts as a grid of covers; `detail(item)` is the line under each name. */
export function CoverGrid({ items, onOpen, detail }) {
  return (
    <div className="grid grid-cols-2 gap-5 @md:grid-cols-3 @lg:grid-cols-4 @xl:grid-cols-5">
      {items.map(item => (
        <button key={item.id} type="button" onClick={() => onOpen(item)} className="group min-w-0 text-left">
          <Cover src={item.image} className="aspect-square w-full transition-transform group-hover:scale-[1.02]" />
          <p className="mt-2 truncate text-sm text-white group-hover:text-accent">{item.name}</p>
          <p className="truncate text-xs text-muted">{detail(item)}</p>
        </button>
      ))}
    </div>
  )
}
