import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, ChevronLeft, ChevronRight, Disc3, Loader2, Lock, Music, Search, Sparkles, Unlock, X } from 'lucide-react'
import Modal from './Modal'
import { showToast } from './Toaster'
import { api } from '../api'
import { trackArtURL } from '../onlineTracks'
import { useTranslation } from '../i18n'
import { plural } from '../plural'
import {
  ALBUM_FIELDS, ALBUM_TRACK_FIELDS, SOURCE_LABELS, TRACK_FIELDS,
  fieldSource, fieldValue, formatValue, sameValue, storeFields, storeValues,
} from '../metadataFields'

// Fix Metadata: look a song (or a whole album) up on the online sources,
// compare what they say with what the library has, pick values field by
// field, and apply them as one undoable change. Picked values are locked
// (electron/metadata/store.js), so rescans and lookups leave them alone.

const FIELD_BY_ID = Object.fromEntries(TRACK_FIELDS.map(field => [field.id, field]))
const isBlank = value => value === null || value === undefined || value === ''
// "Music" is a placeholder some files carry, not a genre.
const isEmptyField = (id, value) => isBlank(value) || (id === 'genres' && String(value).trim().toLowerCase() === 'music')
const minutes = seconds => (seconds > 0 ? `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}` : '')

/** One album shared by every song (a track list of one album), else ''. */
function sharedAlbum(tracks) {
  const albums = new Set(tracks.map(track => String(track.album || '').trim().toLowerCase()))
  return albums.size === 1 && tracks[0]?.album ? tracks[0].album : ''
}

function mostCommon(values) {
  const counts = new Map()
  for (const value of values.filter(value => !isBlank(value))) {
    const key = JSON.stringify(value)
    counts.set(key, { value, count: (counts.get(key)?.count || 0) + 1 })
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)
}

function Cover({ src, size = 'h-10 w-10' }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  if (!src || failed) return <div className={`${size} flex flex-shrink-0 items-center justify-center rounded-md bg-card text-muted`}><Music size={14} /></div>
  return <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className={`${size} flex-shrink-0 rounded-md object-cover`} />
}

function SourceBadge({ source }) {
  if (!source) return null
  return <span className="rounded border border-border px-1 py-px text-[9px] uppercase tracking-wider text-muted">{SOURCE_LABELS[source] || source}</span>
}

function ScoreBadge({ score }) {
  const tone = score >= 90 ? 'border-accent/40 bg-accent/10 text-accent' : score >= 70 ? 'border-border text-white' : 'border-border text-muted'
  return <span className={`rounded-full border px-1.5 py-px text-[10px] tabular-nums ${tone}`} title="How well it fits">{score}%</span>
}

function useProviders() {
  const [providers, setProviders] = useState([])
  const [chosen, setChosen] = useState(null)
  useEffect(() => {
    let live = true
    Promise.resolve(api.metadataProviders?.()).then(list => {
      if (!live || !Array.isArray(list)) return
      setProviders(list)
      setChosen(new Set(list.filter(provider => provider.available).map(provider => provider.id)))
    }).catch(() => {})
    return () => { live = false }
  }, [])
  const toggle = id => setChosen(current => {
    const next = new Set(current || [])
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  return { providers, chosen, toggle }
}

function ProviderChips({ providers, chosen, onToggle }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('Sources')}>
      {providers.map(provider => {
        const on = !!chosen?.has(provider.id)
        return (
          <button
            key={provider.id}
            type="button"
            disabled={!provider.available}
            aria-pressed={on}
            onClick={() => onToggle(provider.id)}
            title={provider.available ? undefined : t('Sign in to Beatport in Settings › Integrations')}
            className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${on ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-muted hover:text-white'}`}
          >
            {provider.label}
          </button>
        )
      })}
    </div>
  )
}

function SearchRow({ fields, query, setQuery, onSearch, loading }) {
  const { t } = useTranslation()
  return (
    <form className="flex flex-col gap-2 sm:flex-row" onSubmit={event => { event.preventDefault(); onSearch() }}>
      {fields.map(([id, label]) => (
        <input
          key={id}
          value={query[id] || ''}
          onChange={event => setQuery(current => ({ ...current, [id]: event.target.value }))}
          placeholder={t(label)}
          aria-label={t(label)}
          className="min-w-0 flex-1 rounded-xl border border-border bg-card px-3 py-2 text-sm text-white outline-none focus:border-accent/50"
        />
      ))}
      <button type="submit" disabled={loading} className="inline-flex items-center justify-center gap-2 rounded-xl border border-border px-4 py-2 text-sm text-white transition-colors hover:border-accent/50 disabled:opacity-40">
        {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} {t('Search')}
      </button>
    </form>
  )
}

function Errors({ errors }) {
  if (!errors?.length) return null
  return (
    <p role="status" className="flex items-start gap-1.5 text-[11px] text-yellow-200/80">
      <AlertCircle size={12} className="mt-px flex-shrink-0" />
      {errors.map(error => error.error || error).join(' · ')}
    </p>
  )
}

/** Apply `changes` and say so, with Undo. Returns the result, or null when nothing was applied. */
async function applyAndReport(changes, onApplied, t) {
  const result = await api.metadataApply(changes).catch(error => ({ error: error.message }))
  if (result?.error) { showToast(result.error); return null }
  const updated = result?.tracks || []
  if (updated.length) {
    onApplied?.(updated)
    window.dispatchEvent(new Event('lokal:refresh'))
  }
  const note = result?.errors?.length ? ` · ${t('cover not saved')}` : ''
  const message = updated.length ? `${t('Updated')} ${plural(updated.length, 'song')}${note}` : `${t('Nothing changed')}${note}`
  showToast(message, result?.batchId ? {
    action: {
      label: t('Undo'),
      onClick: async () => {
        const back = await api.metadataUndo(result.batchId).catch(() => null)
        if (back?.tracks?.length) {
          onApplied?.(back.tracks)
          window.dispatchEvent(new Event('lokal:refresh'))
        }
        showToast(back?.error || t('Undone'))
      },
    },
  } : undefined)
  return result
}

/** Picks ({ field: { value, source, ref, confidence } }) as the changes to apply to one track. */
function picksToChanges(trackId, picks) {
  const groups = new Map()
  for (const [id, pick] of Object.entries(picks)) {
    const key = `${pick.source}\0${pick.ref || ''}`
    if (!groups.has(key)) groups.set(key, { trackId, source: pick.source, ref: pick.ref || null, confidence: pick.confidence ?? null, fields: {} })
    Object.assign(groups.get(key).fields, storeValues(id, pick.value))
  }
  return [...groups.values()]
}

// ---------------------------------------------------------------- one song

function TrackFix({ tracks, sources, onApplied }) {
  const { t } = useTranslation()
  const [index, setIndex] = useState(0)
  const [updated, setUpdated] = useState({})
  const track = updated[tracks[index]?.id] || tracks[index]
  const [query, setQuery] = useState({})
  const [state, setState] = useState({ loading: false, candidates: [], errors: [], provenance: {} })
  const [selected, setSelected] = useState(0)
  const [picks, setPicks] = useState({})
  const [applying, setApplying] = useState(false)
  const request = useRef(0)

  const search = useCallback(async (custom = null) => {
    if (!track?.id || !sources.chosen) return
    const version = ++request.current
    setState(current => ({ ...current, loading: true, errors: [] }))
    const result = await api.metadataLookupTrack(track.id, { query: custom || {}, providers: [...sources.chosen] }).catch(error => ({ error: error.message }))
    if (version !== request.current) return
    if (result?.error) { setState({ loading: false, candidates: [], errors: [result.error], provenance: {} }); return }
    const candidates = result.candidates || []
    setState({ loading: false, candidates, errors: result.errors || [], provenance: result.provenance || {} })
    setSelected(0)
    // A close match fills in what the song is missing; the rest is the user's call.
    const best = candidates[0]
    const start = {}
    if (best && best.score >= 90) {
      for (const field of TRACK_FIELDS) {
        const value = fieldValue(best.fields, field.id)
        const current = field.id === 'artwork' ? (track.artwork_path || track.artwork_url) : fieldValue(track, field.id)
        if (!isBlank(value) && isEmptyField(field.id, current) && !fieldSource(result.provenance, field.id)?.locked) {
          start[field.id] = { value, source: best.provider, ref: best.ref, confidence: best.score }
        }
      }
    }
    setPicks(start)
  }, [track?.id, sources.chosen]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!track?.id) return
    setQuery({ title: track.title || '', artist: track.artist || '' })
    setPicks({})
    search()
  }, [track?.id, sources.chosen ? [...sources.chosen].join() : '']) // eslint-disable-line react-hooks/exhaustive-deps

  const candidate = state.candidates[selected] || null
  const pick = (id, value, from = candidate) => setPicks(current => ({ ...current, [id]: { value, source: from ? from.provider : 'user', ref: from?.ref || null, confidence: from?.score ?? null } }))
  const unpick = id => setPicks(current => { const next = { ...current }; delete next[id]; return next })
  const useAll = from => {
    const next = { ...picks }
    for (const field of TRACK_FIELDS) {
      const value = fieldValue(from.fields, field.id)
      if (isBlank(value) || fieldSource(state.provenance, field.id)?.locked) continue
      if (field.id !== 'artwork' && sameValue(field.id, value, fieldValue(track, field.id))) continue
      next[field.id] = { value, source: from.provider, ref: from.ref, confidence: from.score }
    }
    setPicks(next)
  }
  // After an apply or an undo: the songs as they are now, and their sources.
  const refresh = useCallback(async list => {
    onApplied?.(list)
    const fresh = new Map((list || []).map(item => [item.id, item]))
    setUpdated(current => ({ ...current, ...Object.fromEntries(fresh) }))
    const id = tracks[index]?.id
    if (id && fresh.has(id)) {
      const provenance = await api.metadataProvenance(id).catch(() => null)
      if (provenance && !provenance.error) setState(current => ({ ...current, provenance }))
    }
  }, [onApplied, tracks, index])

  const toggleLock = async id => {
    const locked = !!fieldSource(state.provenance, id)?.locked
    const provenance = await api.metadataSetLock(track.id, storeFields(id), !locked).catch(() => null)
    if (provenance && !provenance.error) setState(current => ({ ...current, provenance }))
  }

  const apply = async () => {
    const changes = picksToChanges(track.id, picks)
    if (!changes.length) return
    setApplying(true)
    const result = await applyAndReport(changes, refresh, t)
    setApplying(false)
    if (!result) return
    setPicks({})
    if (index < tracks.length - 1) setIndex(index + 1)
  }

  const pickCount = Object.keys(picks).length

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Cover src={trackArtURL(track)} size="h-12 w-12" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{track.title}</p>
          <p className="truncate text-xs text-muted">{[track.artist, track.album].filter(Boolean).join(' · ')}</p>
        </div>
        {tracks.length > 1 && (
          <div className="flex items-center gap-1 text-xs text-muted">
            <button type="button" aria-label={t('Previous song')} disabled={index === 0} onClick={() => setIndex(index - 1)} className="rounded-lg p-1 hover:bg-card hover:text-white disabled:opacity-30"><ChevronLeft size={16} /></button>
            <span className="tabular-nums">{index + 1} / {tracks.length}</span>
            <button type="button" aria-label={t('Next song')} disabled={index === tracks.length - 1} onClick={() => setIndex(index + 1)} className="rounded-lg p-1 hover:bg-card hover:text-white disabled:opacity-30"><ChevronRight size={16} /></button>
          </div>
        )}
      </div>

      <SearchRow fields={[['title', 'Title'], ['artist', 'Artist']]} query={query} setQuery={setQuery} loading={state.loading}
        onSearch={() => search({ title: query.title, artist: query.artist })} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ProviderChips providers={sources.providers} chosen={sources.chosen} onToggle={sources.toggle} />
        <Errors errors={state.errors} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
        <div className="max-h-[26rem] space-y-1.5 overflow-y-auto pr-1" role="listbox" aria-label={t('Results')}>
          {state.loading && !state.candidates.length && <p role="status" className="flex items-center gap-2 p-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" /> {t('Looking it up…')}</p>}
          {!state.loading && !state.candidates.length && <p role="status" className="p-2 text-xs text-muted">{t('Nothing found. Try another search.')}</p>}
          {state.candidates.map((item, i) => (
            <div
              key={`${item.ref}-${i}`}
              role="option"
              aria-selected={i === selected}
              tabIndex={0}
              onClick={() => setSelected(i)}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(i) } }}
              className={`group flex cursor-pointer gap-2.5 rounded-xl border p-2 transition-colors ${i === selected ? 'border-accent/50 bg-accent/5' : 'border-border bg-card/60 hover:border-white/20'}`}
            >
              <Cover src={item.fields.artwork_url} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-muted">{SOURCE_LABELS[item.provider] || item.provider}</span>
                  <ScoreBadge score={item.score} />
                </div>
                <p className="truncate text-xs text-white">{item.fields.title}</p>
                <p className="truncate text-[11px] text-muted">{[item.fields.artist, item.fields.album, item.fields.year].filter(Boolean).join(' · ')}</p>
                {(item.fields.tempo || item.fields.track_key != null) && (
                  <p className="truncate text-[11px] text-muted">{[item.fields.tempo && `${formatValue('tempo', item.fields.tempo)} BPM`, formatValue('key', fieldValue(item.fields, 'key'))].filter(Boolean).join(' · ')}</p>
                )}
              </div>
              <button type="button" onClick={event => { event.stopPropagation(); setSelected(i); useAll(item) }}
                className="self-start rounded-lg px-1.5 py-0.5 text-[10px] text-muted opacity-0 transition-opacity hover:bg-card hover:text-accent group-hover:opacity-100 group-aria-selected:opacity-100 focus-visible:opacity-100">
                {t('Use all')}
              </button>
            </div>
          ))}
        </div>

        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full table-fixed text-xs">
            <thead className="bg-card/70 text-[10px] uppercase tracking-wider text-muted">
              <tr>
                <th className="w-24 px-3 py-2 text-left font-normal">{t('Field')}</th>
                <th className="px-3 py-2 text-left font-normal">{t('Now')}</th>
                <th className="px-3 py-2 text-left font-normal">{candidate ? SOURCE_LABELS[candidate.provider] : t('Result')}</th>
                <th className="px-3 py-2 text-left font-normal">{t('Will set')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {TRACK_FIELDS.map(field => {
                const current = field.id === 'artwork' ? null : fieldValue(track, field.id)
                const offered = candidate ? fieldValue(candidate.fields, field.id) : null
                const meta = fieldSource(state.provenance, field.id)
                const differs = !isBlank(offered) && (field.id === 'artwork' || !sameValue(field.id, offered, current))
                const chosen = picks[field.id]
                return (
                  <tr key={field.id} className="align-middle">
                    <td className="px-3 py-1.5 text-muted">{t(field.label)}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {field.id === 'artwork' ? <Cover src={trackArtURL(track)} size="h-8 w-8" /> : <span className={`truncate ${isBlank(current) ? 'text-muted/50' : 'text-white'}`}>{formatValue(field.id, current) || '—'}</span>}
                        <SourceBadge source={meta?.source} />
                        <button type="button" onClick={() => toggleLock(field.id)} aria-pressed={!!meta?.locked}
                          title={meta?.locked ? t('Locked: rescans and lookups leave it. Click to unlock.') : t('Lock it, so rescans and lookups leave it')}
                          className={`ml-auto flex-shrink-0 rounded p-0.5 transition-colors ${meta?.locked ? 'text-accent' : 'text-muted/40 hover:text-white'}`}>
                          {meta?.locked ? <Lock size={11} /> : <Unlock size={11} />}
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-1.5">
                      {isBlank(offered) ? <span className="text-muted/40">—</span> : (
                        <button type="button" onClick={() => pick(field.id, offered)} disabled={!differs}
                          title={differs ? t('Use this value') : t('Same as now')}
                          className={`flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors ${differs ? 'text-white hover:bg-accent/10 hover:text-accent' : 'cursor-default text-muted'}`}>
                          {field.id === 'artwork' ? <Cover src={offered} size="h-8 w-8" /> : <span className="truncate">{formatValue(field.id, offered)}</span>}
                          {!differs && <Check size={11} className="flex-shrink-0" />}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      {chosen ? (
                        <div className="flex min-w-0 items-center gap-1.5">
                          {field.pickOnly ? (
                            field.id === 'artwork' ? <Cover src={chosen.value} size="h-8 w-8" /> : <span className="truncate text-accent">{formatValue(field.id, chosen.value)}</span>
                          ) : (
                            <input
                              value={chosen.value ?? ''}
                              onChange={event => setPicks(current => ({ ...current, [field.id]: { value: event.target.value, source: 'user', ref: null, confidence: null } }))}
                              aria-label={`${t(field.label)}: ${t('new value')}`}
                              className="min-w-0 flex-1 rounded-md border border-accent/40 bg-accent/5 px-1.5 py-0.5 text-accent outline-none focus:border-accent"
                            />
                          )}
                          <SourceBadge source={chosen.source} />
                          <button type="button" aria-label={t('Keep the current value')} onClick={() => unpick(field.id)} className="flex-shrink-0 rounded p-0.5 text-muted hover:text-white"><X size={11} /></button>
                        </div>
                      ) : (
                        field.pickOnly ? <span className="text-muted/40">{t('keep')}</span> : (
                          <button type="button" onClick={() => pick(field.id, current ?? '', null)} title={t('Type a value of your own')} className="text-muted/40 hover:text-white">{t('edit')}</button>
                        )
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-[11px] text-muted">{t('Applied values are locked: rescans and lookups leave them alone.')}</p>
        <button type="button" onClick={apply} disabled={!pickCount || applying}
          className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-medium text-base transition-opacity hover:opacity-90 disabled:opacity-40">
          {applying ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {pickCount ? `${t('Apply')} ${plural(pickCount, 'change')}` : t('Apply')}{tracks.length > 1 && index < tracks.length - 1 ? ` · ${t('next')}` : ''}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- an album

function AlbumFix({ tracks, sources, onApplied }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState({})
  const [state, setState] = useState({ loading: false, releases: [], errors: [], tracks: [], provenance: {} })
  const [selected, setSelected] = useState(0)
  const [albumOn, setAlbumOn] = useState(new Set())
  const [trackFieldsOn, setTrackFieldsOn] = useState(() => new Set(ALBUM_TRACK_FIELDS.filter(field => field.defaultOn).map(field => field.id)))
  const [mapping, setMapping] = useState({})
  const [rowsOff, setRowsOff] = useState(new Set())
  const [applying, setApplying] = useState(false)
  const request = useRef(0)
  const ids = useMemo(() => tracks.map(track => track.id), [tracks])

  const local = state.tracks.length ? state.tracks : tracks
  const release = state.releases[selected] || null
  const common = useMemo(() => Object.fromEntries(ALBUM_FIELDS.map(id => {
    const values = mostCommon(local.map(track => (id === 'artwork' ? null : fieldValue(track, id))))
    return [id, { value: values[0]?.value ?? null, mixed: values.length > 1 }]
  })), [local])

  const choose = useCallback((releases, i, localTracks) => {
    const found = releases[i]
    setSelected(i)
    setRowsOff(new Set())
    if (!found) { setMapping({}); setAlbumOn(new Set()); return }
    setMapping(Object.fromEntries(localTracks.map((track, n) => [track.id, found.mapping?.[n]?.index ?? -1])))
    const on = new Set()
    for (const id of ALBUM_FIELDS) {
      const value = fieldValue(found.fields, id)
      if (isBlank(value)) continue
      const values = mostCommon(localTracks.map(track => (id === 'artwork' ? null : fieldValue(track, id))))
      if (id === 'artwork' || values.length !== 1 || !sameValue(id, value, values[0].value)) on.add(id)
    }
    if (!localTracks.some(track => !track.artwork_path && !track.artwork_url)) on.delete('artwork')
    setAlbumOn(on)
  }, [])

  const search = useCallback(async (custom = null) => {
    if (!sources.chosen) return
    const version = ++request.current
    setState(current => ({ ...current, loading: true, errors: [] }))
    const result = await api.metadataLookupAlbum(ids, { query: custom || {}, providers: [...sources.chosen] }).catch(error => ({ error: error.message }))
    if (version !== request.current) return
    if (result?.error) { setState(current => ({ ...current, loading: false, releases: [], errors: [result.error] })); return }
    setState({ loading: false, releases: result.releases || [], errors: result.errors || [], tracks: result.tracks || [], provenance: result.provenance || {} })
    if (!custom) setQuery({ album: result.query?.album || '', artist: result.query?.artist || '' })
    choose(result.releases || [], 0, result.tracks || [])
  }, [ids, sources.chosen, choose])

  useEffect(() => { search() }, [ids.join(), sources.chosen ? [...sources.chosen].join() : '']) // eslint-disable-line react-hooks/exhaustive-deps

  const releaseTrack = trackId => {
    const index = mapping[trackId]
    return release && index >= 0 ? release.tracks?.[index] || null : null
  }

  /** What one song would get: { field: value } in shown fields. */
  const changesFor = track => {
    if (rowsOff.has(track.id) || !release) return {}
    const result = {}
    const locked = id => fieldSource(state.provenance[track.id], id)?.locked
    for (const id of albumOn) {
      const value = fieldValue(release.fields, id)
      if (!isBlank(value) && !locked(id) && (id === 'artwork' || !sameValue(id, value, fieldValue(track, id)))) result[id] = value
    }
    const matched = releaseTrack(track.id)
    if (matched) {
      for (const id of trackFieldsOn) {
        const value = fieldValue(matched.fields, id)
        if (!isBlank(value) && !locked(id) && !sameValue(id, value, fieldValue(track, id))) result[id] = value
      }
    }
    return result
  }

  const planned = local.map(track => ({ track, fields: changesFor(track) }))
  const total = planned.reduce((sum, item) => sum + Object.keys(item.fields).length, 0)
  const songs = planned.filter(item => Object.keys(item.fields).length).length

  const apply = async () => {
    if (!release || !total) return
    const changes = planned.filter(item => Object.keys(item.fields).length).map(item => ({
      trackId: item.track.id,
      source: release.provider,
      ref: release.ref,
      confidence: release.score,
      fields: Object.assign({}, ...Object.entries(item.fields).map(([id, value]) => storeValues(id, value))),
    }))
    setApplying(true)
    await applyAndReport(changes, refresh, t)
    setApplying(false)
  }

  // After an apply or an undo: the songs as they are now, and their sources.
  async function refresh(list) {
    onApplied?.(list)
    const fresh = new Map((list || []).map(track => [track.id, track]))
    const provenance = Object.fromEntries(await Promise.all([...fresh.keys()].map(async id => [id, await api.metadataProvenance(id).catch(() => ({}))])))
    setState(current => ({
      ...current,
      tracks: current.tracks.map(track => fresh.get(track.id) || track),
      provenance: { ...current.provenance, ...provenance },
    }))
  }

  const toggleIn = (setter, id) => setter(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })

  return (
    <div className="space-y-4">
      <SearchRow fields={[['album', 'Album'], ['artist', 'Album artist']]} query={query} setQuery={setQuery} loading={state.loading}
        onSearch={() => search({ album: query.album, artist: query.artist })} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ProviderChips providers={sources.providers} chosen={sources.chosen} onToggle={sources.toggle} />
        <Errors errors={state.errors} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
        <div className="max-h-[30rem] space-y-1.5 overflow-y-auto pr-1" role="listbox" aria-label={t('Releases')}>
          {state.loading && !state.releases.length && <p role="status" className="flex items-center gap-2 p-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" /> {t('Looking it up…')}</p>}
          {!state.loading && !state.releases.length && <p role="status" className="p-2 text-xs text-muted">{t('Nothing found. Try another search.')}</p>}
          {state.releases.map((item, i) => {
            const matched = (item.mapping || []).filter(entry => entry.index !== -1).length
            return (
              <div key={`${item.ref}-${i}`} role="option" aria-selected={i === selected} tabIndex={0}
                onClick={() => choose(state.releases, i, local)}
                onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(state.releases, i, local) } }}
                className={`flex cursor-pointer gap-2.5 rounded-xl border p-2 transition-colors ${i === selected ? 'border-accent/50 bg-accent/5' : 'border-border bg-card/60 hover:border-white/20'}`}>
                <Cover src={item.fields.artwork_url} size="h-12 w-12" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] uppercase tracking-wider text-muted">{SOURCE_LABELS[item.provider] || item.provider}</span>
                    <ScoreBadge score={item.score} />
                  </div>
                  <p className="truncate text-xs text-white">{item.fields.album}</p>
                  <p className="truncate text-[11px] text-muted">{[item.fields.album_artist, item.fields.year, item.fields.record_label].filter(Boolean).join(' · ')}</p>
                  <p className="text-[11px] text-muted">{matched} / {local.length} {t('songs matched')} · {plural(item.tracks?.length || 0, 'track')}</p>
                </div>
              </div>
            )
          })}
        </div>

        <div className="min-w-0 space-y-4">
          {release && (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full table-fixed text-xs">
                <thead className="bg-card/70 text-[10px] uppercase tracking-wider text-muted">
                  <tr>
                    <th className="w-8 px-2 py-2" />
                    <th className="w-24 px-2 py-2 text-left font-normal">{t('Every song')}</th>
                    <th className="px-2 py-2 text-left font-normal">{t('Now')}</th>
                    <th className="px-2 py-2 text-left font-normal">{SOURCE_LABELS[release.provider]}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {ALBUM_FIELDS.map(id => {
                    const offered = fieldValue(release.fields, id)
                    const now = common[id]
                    return (
                      <tr key={id}>
                        <td className="px-2 py-1.5 text-center">
                          <input type="checkbox" checked={albumOn.has(id)} disabled={isBlank(offered)} onChange={() => toggleIn(setAlbumOn, id)} aria-label={`${t('Apply')} ${t(FIELD_BY_ID[id].label)}`} />
                        </td>
                        <td className="px-2 py-1.5 text-muted">{t(FIELD_BY_ID[id].label)}</td>
                        <td className="px-2 py-1.5">
                          {id === 'artwork' ? <Cover src={trackArtURL(local[0])} size="h-8 w-8" /> : (
                            <span className={`block truncate ${isBlank(now.value) ? 'text-muted/50' : 'text-white'}`}>{now.mixed ? t('Mixed') : formatValue(id, now.value) || '—'}</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          {isBlank(offered) ? <span className="text-muted/40">—</span> : id === 'artwork' ? <Cover src={offered} size="h-8 w-8" /> : <span className={`block truncate ${albumOn.has(id) ? 'text-accent' : 'text-white'}`}>{formatValue(id, offered)}</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {release && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[10px] uppercase tracking-wider text-muted">{t('From each song\'s match')}</span>
                {ALBUM_TRACK_FIELDS.map(field => (
                  <button key={field.id} type="button" aria-pressed={trackFieldsOn.has(field.id)} onClick={() => toggleIn(setTrackFieldsOn, field.id)}
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${trackFieldsOn.has(field.id) ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-muted hover:text-white'}`}>
                    {t(field.label)}
                  </button>
                ))}
              </div>
              <div className="max-h-[16rem] overflow-y-auto rounded-xl border border-border">
                <table className="w-full table-fixed text-xs">
                  <tbody className="divide-y divide-border">
                    {planned.map(({ track, fields }) => {
                      const changeText = Object.entries(fields).filter(([id]) => id !== 'artwork').map(([id, value]) => `${t(FIELD_BY_ID[id].label)}: ${formatValue(id, value)}`).join(' · ')
                      return (
                        <tr key={track.id} className={rowsOff.has(track.id) ? 'opacity-40' : ''}>
                          <td className="w-8 px-2 py-1.5 text-center">
                            <input type="checkbox" checked={!rowsOff.has(track.id)} onChange={() => toggleIn(setRowsOff, track.id)} aria-label={`${t('Change')} ${track.title}`} />
                          </td>
                          <td className="w-[36%] px-2 py-1.5">
                            <span className="block truncate text-white"><span className="mr-1.5 tabular-nums text-muted">{track.track_num || '–'}</span>{track.title}</span>
                          </td>
                          <td className="w-[34%] px-2 py-1.5">
                            <select value={mapping[track.id] ?? -1} onChange={event => setMapping(current => ({ ...current, [track.id]: Number(event.target.value) }))}
                              aria-label={`${t('Match for')} ${track.title}`}
                              className="w-full truncate rounded-md border border-border bg-card px-1.5 py-1 text-xs text-white outline-none focus:border-accent/50">
                              <option value={-1}>{t('No match')}</option>
                              {(release.tracks || []).map((item, i) => (
                                <option key={i} value={i}>{`${item.fields.track_num || i + 1}. ${item.fields.title}${item.fields.duration ? ` (${minutes(item.fields.duration)})` : ''}`}</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-2 py-1.5 text-[11px] text-muted">
                            <span className="block truncate" title={changeText}>{changeText || (fields.artwork ? t('Cover') : t('No change'))}</span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-[11px] text-muted">{t('Applied values are locked: rescans and lookups leave them alone.')}</p>
        <button type="button" onClick={apply} disabled={!total || applying}
          className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-medium text-base transition-opacity hover:opacity-90 disabled:opacity-40">
          {applying ? <Loader2 size={14} className="animate-spin" /> : <Disc3 size={14} />}
          {total ? `${t('Apply to')} ${plural(songs, 'song')}` : t('Apply')}
        </button>
      </div>
    </div>
  )
}

/**
 * @param tracks     the songs to fix: one, several of one album (album mode),
 *                   or several of different albums (one after another)
 * @param onApplied  called with the songs as they are after an apply (or undo)
 */
export default function FixMetadataPanel({ open, tracks = [], onClose, onApplied }) {
  const { t } = useTranslation()
  const sources = useProviders()
  const list = useMemo(() => (tracks || []).filter(track => track?.id), [tracks])
  const album = list.length > 1 ? sharedAlbum(list) : ''
  return (
    <Modal open={open} onClose={onClose} title={album ? `${t('Fix metadata')} · ${album}` : t('Fix metadata')} width="max-w-5xl">
      {open && list.length > 0 && sources.chosen && (
        album
          ? <AlbumFix tracks={list} sources={sources} onApplied={onApplied} />
          : <TrackFix tracks={list} sources={sources} onApplied={onApplied} />
      )}
      {open && !sources.chosen && <p role="status" className="flex items-center gap-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" /> {t('Loading…')}</p>}
    </Modal>
  )
}
