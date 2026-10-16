// Beatport (see electron/beatport.js): the Top 100 and DJ charts, per genre,
// and the signed-in user's own playlists. The songs play, queue and download
// from the playback sources like any other online song (onlineActions.js).
//
// Where the page is (tab, genre, open chart or playlist) lives in the URL, so
// Back returns to it.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowLeft, Disc3, Download, ExternalLink, ListMusic, ListPlus, Loader2, LogIn, Play, Shuffle, Trophy } from 'lucide-react'
import FadeImg from '../components/FadeImg'
import OnlineSongList from '../components/OnlineSongList'
import RefreshButton from '../components/RefreshButton'
import { BeatportSignInModal } from '../components/ScrobblerSignIn'
import { showToast } from '../components/Toaster'
import { usePageReady } from '../pageCache'
import { api } from '../api'
import { downloadOnline, playOnline, resolveOnline } from '../onlineActions'
import { saveAsPlaylist } from '../trackActions'
import { plural } from '../plural'

const TABS = [
  { id: 'top', label: 'Top 100', icon: Trophy },
  { id: 'charts', label: 'DJ charts', icon: Disc3 },
  { id: 'playlists', label: 'My playlists', icon: ListMusic },
]
const CACHE_TTL_MS = 10 * 60 * 1000

// Answers kept for the session, so going back to a list doesn't load it again.
const cache = new Map()

const shuffled = list => {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Load `key` with `loader` (from the cache when fresh); `reload()` loads it again. */
function useBeatport(key, loader) {
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
      if (!result || result.error) { setState({ loading: false, data: null, error: result?.error || 'Beatport did not answer.', signedOut: !!result?.signedOut, loadedAt: 0 }); return }
      const at = Date.now()
      cache.set(key, { at, data: result })
      setState({ loading: false, data: result, error: '', signedOut: false, loadedAt: at })
    })
  }, [key, reload]) // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: () => setReload(n => n + 1) }
}

function Cover({ src, className = '' }) {
  return (
    <div className={`overflow-hidden rounded-xl border border-border bg-elevated ${className}`}>
      {src ? <FadeImg src={src} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-muted"><Disc3 size={36} /></div>}
    </div>
  )
}

const pill = 'inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-white transition-colors hover:border-accent/50 disabled:opacity-40'

/** A list of Beatport songs with play, shuffle, download and save. */
function TrackCollection({ name, subtitle, image, tracks, path, loading, error, loadedAt, onRefresh, onBack, url }) {
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
    const playlist = await saveAsPlaylist(name, rows, { description: `From Beatport${subtitle ? ` · ${subtitle}` : ''}`, coverURL: /^https:\/\//.test(image) ? image : undefined }).catch(() => null)
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
            {url && <button onClick={() => api.openExternal(url)} className={pill}><ExternalLink size={15} /> Beatport</button>}
            {onRefresh && <RefreshButton onClick={onRefresh} loading={loading} loadedAt={loadedAt} />}
          </div>
        </div>
      </div>
      {loading && !tracks.length
        ? <p role="status" className="flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" /> Loading songs…</p>
        : error
          ? <p role="status" className="rounded-xl border border-border bg-elevated p-4 text-sm text-red-300">{error}</p>
          : tracks.length
            ? <OnlineSongList tracks={tracks} showAlbum showMeta onPlay={track => play(track)} />
            : <p role="status" className="rounded-xl border border-border bg-elevated p-4 text-sm text-muted">No songs here.</p>}
    </div>
  )
}

/** Charts or playlists as a grid of covers, with "Load more". */
function CollectionGrid({ kind, genre, onOpen }) {
  const [pages, setPages] = useState(1)
  useEffect(() => { setPages(1) }, [kind, genre])
  const first = useBeatport(`${kind}:${genre}:1`, () => kind === 'charts' ? api.beatportCharts({ genreId: genre, page: 1 }) : api.beatportPlaylists({ page: 1 }))
  const [more, setMore] = useState({ items: [], next: false, loading: false, error: '' })
  useEffect(() => { setMore({ items: [], next: false, loading: false, error: '' }) }, [kind, genre, first.data])
  const loadMore = async () => {
    const page = pages + 1
    setMore(current => ({ ...current, loading: true, error: '' }))
    const result = await Promise.resolve(kind === 'charts' ? api.beatportCharts({ genreId: genre, page }) : api.beatportPlaylists({ page })).catch(error => ({ error: error.message }))
    if (result?.error) { setMore(current => ({ ...current, loading: false, error: result.error })); return }
    setPages(page)
    setMore(current => ({ items: [...current.items, ...(result.items || [])], next: !!result.next, loading: false, error: '' }))
  }

  if (first.loading && !first.data) return <p role="status" className="flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" /> Loading {kind === 'charts' ? 'charts' : 'playlists'}…</p>
  if (first.error) return <p role="status" className="rounded-xl border border-border bg-elevated p-4 text-sm text-red-300">{first.error}</p>
  const items = [...(first.data?.items || []), ...more.items]
  const next = more.items.length ? more.next : !!first.data?.next
  if (!items.length) return <p role="status" className="rounded-xl border border-border bg-elevated p-4 text-sm text-muted">{kind === 'charts' ? 'No charts for this genre.' : 'You have no Beatport playlists yet.'}</p>

  return (
    <div className="space-y-6">
      <div className="flex justify-end"><RefreshButton onClick={first.reload} loading={first.loading} loadedAt={first.loadedAt} /></div>
      <div className="grid grid-cols-2 gap-5 @md:grid-cols-3 @lg:grid-cols-4 @xl:grid-cols-5">
        {items.map(item => (
          <button key={item.id} type="button" onClick={() => onOpen(item)} className="group min-w-0 text-left">
            <Cover src={item.image} className="aspect-square w-full transition-transform group-hover:scale-[1.02]" />
            <p className="mt-2 truncate text-sm text-white group-hover:text-accent">{item.name}</p>
            <p className="truncate text-xs text-muted">{[item.curator, item.track_count ? plural(item.track_count, 'song') : ''].filter(Boolean).join(' · ')}</p>
          </button>
        ))}
      </div>
      {more.error && <p className="text-sm text-red-300">{more.error}</p>}
      {next && <div className="flex justify-center"><button type="button" onClick={loadMore} disabled={more.loading} className={pill}>{more.loading && <Loader2 size={14} className="animate-spin" />}Load more</button></div>}
    </div>
  )
}

function OpenCollection({ kind, id, onBack }) {
  const result = useBeatport(`${kind}-tracks:${id}`, () => kind === 'chart' ? api.beatportChart(id) : api.beatportPlaylist(id))
  const data = result.data || {}
  const subtitle = kind === 'chart' ? [data.curator && `Chart by ${data.curator}`, data.genres?.join(', ')].filter(Boolean).join(' · ') : 'Your Beatport playlist'
  return (
    <TrackCollection
      name={data.name || (result.loading ? 'Loading…' : kind === 'chart' ? 'Chart' : 'Playlist')}
      subtitle={subtitle} image={data.image || ''} tracks={data.tracks || []}
      path={`/beatport?${kind}=${encodeURIComponent(id)}`}
      loading={result.loading} error={result.error} loadedAt={result.loadedAt} onRefresh={result.reload} onBack={onBack}
      url={kind === 'chart' ? data.url : ''}
    />
  )
}

function TopHundred({ genre, genreName }) {
  const result = useBeatport(`top:${genre}`, () => api.beatportTop(genre || undefined))
  const name = `Beatport Top 100${genreName ? ` · ${genreName}` : ''}`
  return (
    <TrackCollection name={name} subtitle="The best-selling tracks on Beatport right now" tracks={Array.isArray(result.data) ? result.data : []}
      path={`/beatport?tab=top${genre ? `&genre=${genre}` : ''}`}
      loading={result.loading} error={result.error} loadedAt={result.loadedAt} onRefresh={result.reload} />
  )
}

export default function Beatport() {
  const [params, setParams] = useSearchParams()
  const [account, setAccount] = useState(null)
  const [signIn, setSignIn] = useState(false)
  usePageReady(true)

  const refreshAccount = () => Promise.resolve(api.beatportStatus()).then(status => setAccount(status && !status.error ? status : { connected: false })).catch(() => setAccount({ connected: false }))
  useEffect(() => {
    refreshAccount()
    const changed = () => { cache.clear(); refreshAccount() }
    window.addEventListener('lokal:beatport', changed)
    return () => window.removeEventListener('lokal:beatport', changed)
  }, [])

  const connected = !!account?.connected
  const genres = useBeatport(connected ? 'genres' : '', () => api.beatportGenres())
  const genreList = Array.isArray(genres.data) ? genres.data : []
  const tab = TABS.some(entry => entry.id === params.get('tab')) ? params.get('tab') : 'top'
  const genre = params.get('genre') || ''
  const chart = params.get('chart')
  const playlist = params.get('playlist')
  const genreName = genreList.find(entry => String(entry.id) === genre)?.name || ''
  const go = patch => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(patch)) value ? next.set(key, value) : next.delete(key)
    setParams(next)
  }

  const header = (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="text-[11px] font-display uppercase tracking-[0.3em] text-accent">Beatport</p>
        <h1 className="mt-1 text-3xl font-display text-white">Charts & playlists</h1>
        {connected && <p className="mt-1 text-xs text-muted">Signed in as {account.username || 'Beatport user'}</p>}
      </div>
    </div>
  )

  if (!account) return <div className="p-6"><p role="status" className="flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" /> Loading…</p></div>

  if (!connected) {
    return (
      <div className="p-6 pb-10">
        {header}
        <div className="max-w-lg rounded-xl border border-border bg-card/40 p-6 space-y-3">
          <p className="text-sm text-white">Connect your Beatport account</p>
          <p className="text-xs leading-relaxed text-muted">See the Top 100 and DJ charts of every genre, and your own Beatport playlists. Songs play and download from your playback sources, like any online album.</p>
          <button type="button" onClick={() => setSignIn(true)} className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-medium text-base hover:opacity-90"><LogIn size={15} /> Sign in to Beatport</button>
        </div>
        <BeatportSignInModal open={signIn} onClose={() => setSignIn(false)} onConnected={() => { cache.clear(); refreshAccount() }} />
      </div>
    )
  }

  // A signed-out answer (the token expired and could not be refreshed): sign in again.
  const signedOut = genres.signedOut
  const genresError = !signedOut && genres.error

  return (
    <div className="p-6 pb-10">
      {header}
      {signedOut && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card/40 p-4">
          <p className="text-sm text-muted">{genres.error}</p>
          <button type="button" onClick={() => setSignIn(true)} className={pill}><LogIn size={14} /> Sign in again</button>
        </div>
      )}
      {chart || playlist
        ? <OpenCollection kind={chart ? 'chart' : 'playlist'} id={chart || playlist} onBack={() => go({ chart: '', playlist: '' })} />
        : (
          <>
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <div role="tablist" className="flex gap-1 rounded-xl border border-border bg-card/40 p-1">
                {TABS.map(({ id, label, icon: Icon }) => (
                  <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => go({ tab: id === 'top' ? '' : id })}
                    className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs transition-colors ${tab === id ? 'bg-accent/15 text-accent' : 'text-muted hover:text-white'}`}>
                    <Icon size={13} />{label}
                  </button>
                ))}
              </div>
              {tab !== 'playlists' && (
                <div className="flex items-center gap-2">
                  {genresError && <span className="text-xs text-red-300">Genres did not load. <button type="button" onClick={genres.reload} className="text-accent hover:underline">Retry</button></span>}
                  <select aria-label="Genre" value={genre} onChange={event => go({ genre: event.target.value })} disabled={!genreList.length}
                    className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-white outline-none focus:border-accent/50 disabled:opacity-50">
                    <option value="">{genres.loading ? 'Loading genres…' : 'All genres'}</option>
                    {genreList.map(entry => <option key={entry.id} value={String(entry.id)}>{entry.name}</option>)}
                  </select>
                </div>
              )}
            </div>
            {tab === 'top' && <TopHundred genre={genre} genreName={genreName} />}
            {tab === 'charts' && <CollectionGrid kind="charts" genre={genre} onOpen={item => go({ chart: String(item.id) })} />}
            {tab === 'playlists' && <CollectionGrid kind="playlists" genre="" onOpen={item => go({ playlist: String(item.id) })} />}
          </>
        )}
      <BeatportSignInModal open={signIn} onClose={() => setSignIn(false)} onConnected={() => { cache.clear(); refreshAccount(); genres.reload() }} />
    </div>
  )
}
