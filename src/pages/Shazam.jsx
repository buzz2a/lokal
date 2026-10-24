// Shazam (see electron/shazam.js): its charts per country, city and genre,
// its own playlists, and the user's Shazams (imported data, Shazam for Mac,
// or Apple Music). The songs
// play, queue and download from the playback sources like any other online
// song (onlineActions.js).
//
// Where the page is (tab, region, chart, open playlist) lives in the URL, so
// Back returns to it.

import React, { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Link2, ListMusic, Loader2, Radar, Trash2, Trophy, Upload } from 'lucide-react'
import { CoverGrid, TrackCollection, pill, useCachedLoad } from '../components/OnlineCollection'
import RefreshButton from '../components/RefreshButton'
import { ShazamSignInModal } from '../components/ScrobblerSignIn'
import { showToast } from '../components/Toaster'
import { usePageReady } from '../pageCache'
import { api } from '../api'
import { plural } from '../plural'

const TABS = [
  { id: 'charts', label: 'Charts', icon: Trophy },
  { id: 'playlists', label: 'Playlists', icon: ListMusic },
  { id: 'mine', label: 'My Shazams', icon: Radar },
]

// Answers kept for the session, so going back to a list doesn't load it again.
const cache = new Map()

const useShazam = (key, loader) => useCachedLoad(cache, key, loader, { noAnswer: 'Shazam did not answer.' })

const dateOf = value => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

const notice = 'rounded-xl border border-border bg-elevated p-4 text-sm'
const select = 'max-w-[14rem] rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-white outline-none focus:border-accent/50 disabled:opacity-50'

function Loading({ children }) {
  return <p role="status" className="flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" /> {children}</p>
}

/** A chart's title: "Shazam Top 200 · France", "Shazam Pop · Worldwide", "Shazam Top · Paris". */
function chartName(list, region) {
  if (!list) return 'Shazam chart'
  if (list.kind === 'city') return `Shazam Top · ${list.name}`
  return `Shazam ${list.name} · ${region?.name || 'Worldwide'}`
}

function Charts({ regions, regionId, listId, go }) {
  const region = regions.find(entry => entry.id === regionId) || regions[0]
  const all = [...(region?.lists || []), ...(region?.cities || [])]
  const list = all.find(entry => entry.id === listId) || all[0]
  const result = useShazam(list ? `chart:${list.id}` : '', () => api.shazamChart(list.id, region?.id || ''))
  const data = result.data || {}
  const charts = (region?.lists || []).filter(entry => entry.kind !== 'genre')
  const genres = (region?.lists || []).filter(entry => entry.kind === 'genre')

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <select aria-label="Region" value={region?.id || ''} onChange={event => go({ region: event.target.value, list: '' })} className={select}>
          {regions.map(entry => <option key={entry.id || 'world'} value={entry.id}>{entry.name}</option>)}
        </select>
        <select aria-label="Chart" value={list?.id || ''} onChange={event => go({ list: event.target.value })} className={select}>
          <optgroup label="Charts">{charts.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</optgroup>
          {genres.length > 0 && <optgroup label="Genres">{genres.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</optgroup>}
          {region?.cities?.length > 0 && <optgroup label="Cities">{region.cities.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</optgroup>}
        </select>
      </div>
      <TrackCollection
        source="Shazam" numbered
        name={chartName(list, region)}
        subtitle={[data.updated && `Updated ${dateOf(data.updated)}`, 'The most Shazamed songs'].filter(Boolean).join(' · ')}
        image={data.image || data.tracks?.[0]?.artwork_url || ''} tracks={data.tracks || []}
        path={`/shazam?${new URLSearchParams({ ...(region?.id ? { region: region.id } : {}), ...(list ? { list: list.id } : {}) })}`}
        loading={result.loading} error={result.error} loadedAt={result.loadedAt} onRefresh={result.reload}
      />
    </>
  )
}

/** Shazam's playlists as a grid of covers, with "Load more". */
function PlaylistGrid({ onOpen }) {
  const [pages, setPages] = useState(1)
  const first = useShazam('playlists:1', () => api.shazamPlaylists({ page: 1 }))
  const [more, setMore] = useState({ items: [], next: false, loading: false, error: '' })
  useEffect(() => { setPages(1); setMore({ items: [], next: false, loading: false, error: '' }) }, [first.data])
  const loadMore = async () => {
    const page = pages + 1
    setMore(current => ({ ...current, loading: true, error: '' }))
    const result = await Promise.resolve(api.shazamPlaylists({ page })).catch(error => ({ error: error.message }))
    if (result?.error) { setMore(current => ({ ...current, loading: false, error: result.error })); return }
    setPages(page)
    setMore(current => ({ items: [...current.items, ...(result.items || [])], next: !!result.next, loading: false, error: '' }))
  }

  if (first.loading && !first.data) return <Loading>Loading playlists…</Loading>
  if (first.error) return <p role="status" className={`${notice} text-red-300`}>{first.error}</p>
  const items = [...(first.data?.items || []), ...more.items]
  const next = more.items.length ? more.next : !!first.data?.next
  if (!items.length) return <p role="status" className={`${notice} text-muted`}>Shazam has no playlists right now.</p>

  return (
    <div className="space-y-6">
      <div className="flex justify-end"><RefreshButton onClick={first.reload} loading={first.loading} loadedAt={first.loadedAt} /></div>
      <CoverGrid items={items} onOpen={onOpen} detail={item => item.description || (item.updated ? `Updated ${dateOf(item.updated)}` : '')} />
      {more.error && <p className="text-sm text-red-300">{more.error}</p>}
      {next && <div className="flex justify-center"><button type="button" onClick={loadMore} disabled={more.loading} className={pill}>{more.loading && <Loader2 size={14} className="animate-spin" />}Load more</button></div>}
    </div>
  )
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent || '')

const readBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
  reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
  reader.readAsDataURL(file)
})

/** "Import Shazam data": a zip or CSV from shazam.com/privacy. */
function ImportButton({ primary = false, label = 'Import Shazam data' }) {
  const input = useRef(null)
  const [busy, setBusy] = useState(false)
  const choose = async event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy(true)
    try {
      const result = await Promise.resolve(api.shazamImport({ name: file.name, data: await readBase64(file) }))
      if (!result?.ok) throw new Error(result?.error || 'Import failed.')
      showToast(result.added ? `Imported ${plural(result.added, 'Shazam')} (${result.total} in all).` : `No new Shazams: all ${result.total} were already imported.`)
      window.dispatchEvent(new Event('lokal:shazam'))
    } catch (error) { showToast(error.message) }
    finally { setBusy(false) }
  }
  return (
    <>
      <input ref={input} type="file" accept=".zip,.csv,application/zip,text/csv" className="hidden" onChange={choose} />
      <button type="button" onClick={() => input.current?.click()} disabled={busy}
        className={primary ? 'inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-medium text-base hover:opacity-90 disabled:opacity-50' : pill}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}{busy ? 'Importing…' : label}
      </button>
    </>
  )
}

/** The ways to bring in the user's Shazams, when none is set up yet. */
function ShazamSources({ onLink }) {
  return (
    <div className="grid max-w-4xl gap-4 @lg:grid-cols-2">
      <div className="space-y-3 rounded-xl border border-border bg-card/40 p-5">
        <p className="text-sm text-white">Import your Shazam data</p>
        <ol className="list-decimal space-y-1 pl-4 text-xs leading-relaxed text-muted">
          <li>Open <button type="button" onClick={() => api.openExternal('https://www.shazam.com/privacy')} className="text-accent hover:underline">shazam.com/privacy</button> and choose Download your data.</li>
          <li>Sign in with the account your Shazam app uses. Shazam emails you a zip (it can take a few days).</li>
          <li>Choose that zip, or the SyncedShazams.csv inside it.</li>
        </ol>
        <ImportButton primary />
        <p className="text-[11px] leading-relaxed text-subtle">No subscription needed. Import a newer export any time to add new Shazams.</p>
      </div>
      <div className="space-y-3 rounded-xl border border-border bg-card/40 p-5">
        {isMac && (
          <>
            <p className="text-sm text-white">Shazam for Mac</p>
            <p className="text-xs leading-relaxed text-muted">Install Shazam from the Mac App Store and sign in with the same Apple ID as your phone: Lokal reads its library on its own.</p>
          </>
        )}
        <p className={`text-sm text-white ${isMac ? 'pt-2' : ''}`}>Apple Music subscribers</p>
        <p className="text-xs leading-relaxed text-muted">With Settings › Apple Music › Sync Shazams on in the Shazam app, your Shazams are in the playlist “My Shazam Tracks”.</p>
        <button type="button" onClick={onLink} className={pill}><Link2 size={14} /> Link Apple Music</button>
      </div>
    </div>
  )
}

/** Every source of the user's Shazams: imported data, Shazam for Mac, Apple Music. */
function MyShazams({ version, account, onOpen, onLink }) {
  const result = useShazam(`library:${version}`, () => api.shazamLibrary())
  const forget = async () => {
    if (!window.confirm('Forget the imported Shazams? You can import them again later.')) return
    await Promise.resolve(api.shazamDisconnect('imported')).catch(() => {})
    window.dispatchEvent(new Event('lokal:shazam'))
  }
  const toolbar = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <ImportButton label={account.imported ? 'Import newer data' : 'Import Shazam data'} />
      {account.imported > 0 && <button type="button" onClick={forget} className={pill}><Trash2 size={14} /> Forget imported</button>}
      {!account.apple && <button type="button" onClick={onLink} className={pill}><Link2 size={14} /> Link Apple Music</button>}
      <RefreshButton onClick={result.reload} loading={result.loading} loadedAt={result.loadedAt} />
    </div>
  )
  if (result.loading && !result.data) return <Loading>Loading your Shazams…</Loading>
  if (result.error) {
    return (
      <div className="space-y-4">
        {toolbar}
        <div className={`${notice} flex flex-wrap items-center gap-3`}>
          <p className={result.signedOut ? 'text-muted' : 'text-red-300'}>{result.error}</p>
          {result.signedOut && <button type="button" onClick={onLink} className={pill}><Link2 size={14} /> Link again</button>}
        </div>
      </div>
    )
  }
  const items = Array.isArray(result.data) ? result.data : []
  return (
    <div className="space-y-6">
      {toolbar}
      {items.length
        ? <CoverGrid items={items} onOpen={onOpen} detail={item => item.description || (item.updated ? `Updated ${dateOf(item.updated)}` : 'Apple Music library')} />
        : <p role="status" className={`${notice} text-muted`}>No Shazam playlist in your Apple Music library yet. In the Shazam app, turn on Settings › Apple Music › Sync Shazams, or import your Shazam data.</p>}
    </div>
  )
}

function OpenPlaylist({ kind, id, onBack }) {
  const mine = kind === 'mine'
  const result = useShazam(`${kind}-tracks:${id}`, () => (mine ? api.shazamLibraryPlaylist(id) : api.shazamPlaylist(id)))
  const data = result.data || {}
  return (
    <TrackCollection
      source="Shazam" urlLabel="Apple Music"
      name={data.name || (result.loading ? 'Loading…' : 'Playlist')}
      subtitle={data.description || (mine ? 'Your Shazams' : 'A Shazam playlist')}
      image={data.image || data.tracks?.[0]?.artwork_url || ''} tracks={data.tracks || []}
      path={`/shazam?${kind === 'mine' ? 'mine' : 'playlist'}=${encodeURIComponent(id)}`}
      loading={result.loading} error={result.error} loadedAt={result.loadedAt} onRefresh={result.reload} onBack={onBack}
      url={mine ? '' : data.url}
    />
  )
}

export default function Shazam() {
  const [params, setParams] = useSearchParams()
  const [account, setAccount] = useState(null)
  const [linking, setLinking] = useState(false)
  const [version, setVersion] = useState(0) // bumped when a source of the user's Shazams changes
  usePageReady(true)

  const refreshAccount = () => Promise.resolve(api.shazamStatus()).then(status => setAccount(status && !status.error ? status : { connected: false })).catch(() => setAccount({ connected: false }))
  useEffect(() => {
    refreshAccount()
    const changed = () => {
      for (const key of cache.keys()) if (key.startsWith('mine-tracks:')) cache.delete(key)
      setVersion(n => n + 1); refreshAccount()
    }
    window.addEventListener('lokal:shazam', changed)
    return () => window.removeEventListener('lokal:shazam', changed)
  }, [])

  const tab = TABS.some(entry => entry.id === params.get('tab')) ? params.get('tab') : 'charts'
  const locations = useShazam(tab === 'charts' ? 'locations' : '', () => api.shazamLocations())
  const regions = locations.data?.regions || []
  const playlist = params.get('playlist')
  const mine = params.get('mine')
  const go = patch => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(patch)) value ? next.set(key, value) : next.delete(key)
    setParams(next)
  }
  const linked = () => window.dispatchEvent(new Event('lokal:shazam'))

  let body
  if (playlist || mine) body = <OpenPlaylist kind={mine ? 'mine' : 'playlist'} id={mine || playlist} onBack={() => go({ playlist: '', mine: '' })} />
  else if (tab === 'charts') {
    body = locations.loading && !regions.length
      ? <Loading>Loading charts…</Loading>
      : locations.error
        ? <div className={`${notice} flex flex-wrap items-center gap-3 text-red-300`}>{locations.error} <RefreshButton onClick={locations.reload} loading={locations.loading} /></div>
        : <Charts regions={regions} regionId={params.get('region') || ''} listId={params.get('list') || ''} go={go} />
  } else if (tab === 'playlists') body = <PlaylistGrid onOpen={item => go({ playlist: item.id })} />
  else if (!account) body = <Loading>Loading…</Loading>
  else if (!account.connected) body = <ShazamSources onLink={() => setLinking(true)} />
  else body = <MyShazams version={version} account={account} onOpen={item => go({ mine: item.id })} onLink={() => setLinking(true)} />

  return (
    <div className="p-6 pb-10">
      <div className="mb-6">
        <p className="text-[11px] font-display uppercase tracking-[0.3em] text-accent">Shazam</p>
        <h1 className="mt-1 text-3xl font-display text-white">Charts & Shazams</h1>
      </div>
      {!playlist && !mine && (
        <div role="tablist" className="mb-6 inline-flex gap-1 rounded-xl border border-border bg-card/40 p-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setParams(id === 'charts' ? {} : { tab: id })}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs transition-colors ${tab === id ? 'bg-accent/15 text-accent' : 'text-muted hover:text-white'}`}>
              <Icon size={13} />{label}
            </button>
          ))}
        </div>
      )}
      {body}
      <ShazamSignInModal open={linking} onClose={() => setLinking(false)} onConnected={linked} />
    </div>
  )
}
