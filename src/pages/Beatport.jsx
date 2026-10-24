// Beatport (see electron/beatport.js): the Top 100 and DJ charts, per genre,
// and the signed-in user's own playlists. The songs play, queue and download
// from the playback sources like any other online song (onlineActions.js).
//
// Where the page is (tab, genre, open chart or playlist) lives in the URL, so
// Back returns to it.

import React, { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Disc3, ListMusic, Loader2, LogIn, Trophy } from 'lucide-react'
import { CoverGrid, TrackCollection, pill, useCachedLoad } from '../components/OnlineCollection'
import RefreshButton from '../components/RefreshButton'
import { BeatportSignInModal } from '../components/ScrobblerSignIn'
import { usePageReady } from '../pageCache'
import { api } from '../api'
import { plural } from '../plural'

const TABS = [
  { id: 'top', label: 'Top 100', icon: Trophy },
  { id: 'charts', label: 'DJ charts', icon: Disc3 },
  { id: 'playlists', label: 'My playlists', icon: ListMusic },
]

// Answers kept for the session, so going back to a list doesn't load it again.
const cache = new Map()

const useBeatport = (key, loader) => useCachedLoad(cache, key, loader, { noAnswer: 'Beatport did not answer.' })

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
      <CoverGrid items={items} onOpen={onOpen} detail={item => [item.curator, item.track_count ? plural(item.track_count, 'song') : ''].filter(Boolean).join(' · ')} />
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
      source="Beatport" showMeta
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
    <TrackCollection source="Beatport" showMeta name={name} subtitle="The best-selling tracks on Beatport right now" tracks={Array.isArray(result.data) ? result.data : []}
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
