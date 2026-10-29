import React, { useEffect, useRef, useState } from 'react'

const WORKSHOP_URL = 'https://steamcommunity.com/sharedfiles/filedetails/?id=2873513347'

// This component mounts the creator's original Wallpaper Engine project. The
// renderer binds $mediaThumbnail to the wallpaper's own sleeve and vinyl-label
// materials; no second, perspective-guessed DOM artwork layer is necessary.
export default function FullscreenTurntable({ track, playing, progress = 0, duration = 0, onNext, onPrevious, onPlayPause }) {
  const stageRef = useRef(null)
  const mediaRef = useRef(null)
  const snapshotRef = useRef(null)
  const commandsRef = useRef({ onNext, onPrevious, onPlayPause })
  commandsRef.current = { onNext, onPrevious, onPlayPause }
  const [artwork, setArtwork] = useState('')
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)

  const trackId = track?.id
  const artworkPath = track?.artwork_path || ''
  const localArtwork = !!artworkPath
  const onlineArtwork = track?.artwork_url || ''

  // WebWallGL's original scene binds live images to $mediaThumbnail.
  // Electron resolves full embedded local artwork using the trusted track ID;
  // online artwork goes through the existing HTTPS-only image validator.
  useEffect(() => {
    let active = true
    setArtwork('')
    if ((trackId && localArtwork) || onlineArtwork) {
      Promise.resolve(window.electron?.wallpaperCoverData?.({
        trackId: localArtwork ? trackId : null,
        url: onlineArtwork,
      }))
        .then(result => { if (active) setArtwork(result || '') })
        .catch(() => {})
    }
    return () => { active = false }
  }, [trackId, artworkPath, localArtwork, onlineArtwork])

  snapshotRef.current = {
    hasMedia: !!track,
    title: track?.title || '',
    artist: track?.artist || '',
    album: track?.album || '',
    playing,
    position: Number(progress) || 0,
    duration: Number(duration) || 0,
    thumbnail: artwork,
    hasThumbnail: !!artwork,
  }

  // Mount exactly once per chosen source; updating the song uses the media
  // source's set() method rather than tearing down the WebGL scene.
  useEffect(() => {
    let cancelled = false
    let scene = null
    const start = async () => {
      if (!stageRef.current || !window.electron?.wallpaperWorkshopGet) {
        setStatus('missing')
        return
      }
      setStatus('loading')
      setError('')
      try {
        const result = await window.electron.wallpaperWorkshopGet()
        if (cancelled) return
        if (!result?.bytes?.length) {
          setStatus('missing')
          setError(result?.error || '')
          return
        }
        const { mount, bytesSource, createMediaSource } = await import('webwallgl')
        if (cancelled) return
        const media = createMediaSource(snapshotRef.current, {
          skipNext: () => commandsRef.current.onNext?.(),
          skipPrevious: () => commandsRef.current.onPrevious?.(),
          playPause: () => commandsRef.current.onPlayPause?.(),
        })
        mediaRef.current = media
        scene = await mount(stageRef.current, {
          source: bytesSource(result.bytes, result.project || undefined, result.key),
          media,
          fps: 60,
          fit: 'cover',
          volume: 0,
          // Native display resolution (bounded by WebWallGL's 4096px cap).
          // A fixed 1x DPR would visibly blur this 4K artwork on HiDPI screens.
          renderDpr: 0,
          autoplay: true,
        })
        if (cancelled) { scene.destroy({ releasePkgCache: true }); return }
        // Album artwork may have loaded while the scene was initializing.
        media.set(snapshotRef.current)
        setStatus('ready')
      } catch (cause) {
        try { (scene || cause?.instance)?.destroy({ releasePkgCache: true }) } catch {}
        if (!cancelled) {
          setStatus('failed')
          setError(cause?.message || 'The original scene could not be rendered.')
        }
      }
    }
    start()
    return () => {
      cancelled = true
      mediaRef.current = null
      try { scene?.destroy({ releasePkgCache: true }) } catch {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retry])

  useEffect(() => {
    mediaRef.current?.set(snapshotRef.current)
  }, [track, playing, progress, duration, artwork])

  // Keep rendering even when music is paused: the wallpaper's own playback
  // event controls its tonearm, platter deceleration, and other authored motion.
  const selectOriginal = async () => {
    const result = await window.electron?.wallpaperWorkshopChoose?.()
    if (result?.installed) setRetry(v => v + 1)
    else if (result?.error) setError(result.error)
  }

  return (
    <div className="absolute inset-0 overflow-hidden" data-original-turntable="">
      <div ref={stageRef} className="absolute inset-0 pointer-events-none" />
      {status !== 'ready' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/90 text-white">
          <div className="max-w-md rounded-xl border border-white/15 bg-neutral-900/95 p-6 text-center shadow-2xl">
            <h3 className="mb-3 text-lg font-semibold">Original Vinyl Record Player</h3>
            {status === 'loading' ? (
              <p className="text-sm text-white/60">Loading the original wallpaper scene…</p>
            ) : (
              <>
                <p className="mb-4 text-sm text-white/70">
                  {status === 'missing'
                    ? 'Install the original wallpaper through Steam Workshop, or select its scene.pkg file. Lokal does not redistribute the creator’s assets.'
                    : 'The wallpaper could not be opened. Confirm it is the original Wallpaper Engine scene.pkg.'}
                </p>
                {error && <p className="mb-4 text-xs text-red-300">{error}</p>}
                <div className="flex justify-center gap-3">
                  <button type="button" onClick={selectOriginal}
                    className="rounded-full bg-white px-4 py-2 text-sm font-medium text-black hover:bg-white/80">
                    Select original scene.pkg
                  </button>
                  <button type="button" onClick={() => window.electron?.openExternal?.(WORKSHOP_URL)}
                    className="rounded-full border border-white/30 px-4 py-2 text-sm text-white hover:bg-white/10">
                    Steam Workshop
                  </button>
                </div>
                <button type="button" className="mt-4 text-xs text-white/50 hover:text-white" onClick={() => setRetry(v => v + 1)}>
                  Retry detection
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
