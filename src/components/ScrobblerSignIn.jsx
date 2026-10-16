// Sign-in popups for the scrobbling services, opened from Account Connections:
// numbered steps, nothing else.
//   Last.fm:     create an API account, key, secret, username, authorize.
//   ListenBrainz: get the user token, paste it, connect.
//   Beatport:     username and password, or a token from the API docs page.

import React, { useEffect, useRef, useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import Modal from './Modal'
import { api } from '../api'

const AUTH_TIMEOUT_MS = 120000
const input = 'w-full bg-card border border-border rounded-lg px-3 py-2 text-sm text-white outline-none placeholder:text-subtle focus:border-accent/50'

function Step({ n, children }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-accent/40 bg-accent/10 text-[11px] font-display text-accent">{n}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function LinkButton({ href, children }) {
  return (
    <button type="button" onClick={() => api.openExternal(href)}
      className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-white/85 hover:border-accent/30 hover:text-white">
      {children} <ExternalLink size={13} className="text-muted" />
    </button>
  )
}

function PrimaryButton({ onClick, disabled, busy, children }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-base hover:bg-accent-dim disabled:opacity-40">
      {busy && <Loader2 size={14} className="animate-spin" />}{children}
    </button>
  )
}

const Status = ({ status }) => status?.message
  ? <p role="status" className={`text-xs ${status.error ? 'text-red-400' : 'text-muted'}`}>{status.message}</p>
  : null

/**
 * Last.fm: the API account's key and secret, the username, then authorization
 * in the browser. Calls onConnected(settings patch) once the session is saved.
 */
export function LastfmSignInModal({ open, onClose, settings = {}, onConnected }) {
  const [form, setForm] = useState({ key: '', secret: '', username: '' })
  const [status, setStatus] = useState(null) // { message, error?, busy? }
  const cleanupRef = useRef(null)

  const stop = () => { cleanupRef.current?.(); cleanupRef.current = null }
  useEffect(() => {
    if (!open) return undefined
    setForm({ key: settings.lastfm_api_key || '', secret: settings.lastfm_api_secret || '', username: settings.lastfm_username || '' })
    setStatus(null)
    return stop
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { stop(); onClose?.() }
  const field = name => event => setForm(f => ({ ...f, [name]: event.target.value }))
  const ready = form.key.trim() && form.secret.trim() && form.username.trim()

  const authorize = async () => {
    if (!ready || status?.busy) return
    stop()
    const key = form.key.trim()
    const secret = form.secret.trim()
    const username = form.username.trim()
    const saved = await Promise.resolve(api.saveSettings({ lastfm_api_key: key, lastfm_api_secret: secret, lastfm_username: username, lastfm_enabled: '1' })).catch(e => ({ error: e.message }))
    if (saved?.error) { setStatus({ message: saved.error, error: true }); return }
    onConnected?.({ lastfm_api_key: key, lastfm_api_secret: secret, lastfm_username: username, lastfm_enabled: '1' })
    setStatus({ message: 'Waiting for Last.fm…', busy: true })

    let done = false
    const timer = setTimeout(() => { if (!done) { stop(); setStatus({ message: 'Authorization timed out. Try again.', error: true }) } }, AUTH_TIMEOUT_MS)
    const off = api.onLastfmAuthToken?.(async token => {
      if (!token || done) return
      done = true
      stop()
      setStatus({ message: 'Connecting…', busy: true })
      const result = await Promise.resolve(api.lastfmConnect(key, secret, token)).catch(e => ({ error: e.message }))
      if (!result?.sessionKey) { setStatus({ message: result?.error || 'Last.fm refused the authorization.', error: true }); return }
      const patch = { lastfm_auth_token: token, lastfm_session_key: result.sessionKey, lastfm_username: result.username || username }
      const stored = await Promise.resolve(api.saveSettings(patch)).catch(e => ({ error: e.message }))
      if (stored?.error) { setStatus({ message: stored.error, error: true }); return }
      onConnected?.(patch)
      setStatus(null)
      onClose?.()
    })
    cleanupRef.current = () => { done = true; clearTimeout(timer); off?.() }
    try {
      await api.lastfmAuthorize(key)
    } catch (e) {
      stop()
      setStatus({ message: e?.message || 'Could not open Last.fm.', error: true })
    }
  }

  return (
    <Modal open={open} onClose={close} title="Sign in to Last.fm" width="max-w-sm">
      <div className="space-y-4">
        <Step n={1}><LinkButton href="https://www.last.fm/api/account/create">Create an API account</LinkButton></Step>
        <Step n={2}><input aria-label="API key" value={form.key} onChange={field('key')} placeholder="API key" spellCheck={false} autoComplete="off" className={input} /></Step>
        <Step n={3}><input aria-label="Shared secret" type="password" value={form.secret} onChange={field('secret')} placeholder="Shared secret" spellCheck={false} autoComplete="off" className={input} /></Step>
        <Step n={4}><input aria-label="Username" value={form.username} onChange={field('username')} placeholder="Username" spellCheck={false} autoComplete="off" className={input} /></Step>
        <Step n={5}><PrimaryButton onClick={authorize} disabled={!ready || status?.busy} busy={status?.busy}>Authorize</PrimaryButton></Step>
        <Status status={status} />
      </div>
    </Modal>
  )
}

/** ListenBrainz: the user token from listenbrainz.org/settings. Calls onConnected() once it's accepted. */
export function ListenBrainzSignInModal({ open, onClose, onConnected }) {
  const [token, setToken] = useState('')
  const [status, setStatus] = useState(null)
  useEffect(() => { if (open) { setToken(''); setStatus(null) } }, [open])

  const connect = async () => {
    if (!token.trim() || status?.busy) return
    setStatus({ message: 'Connecting…', busy: true })
    const result = await Promise.resolve(api.listenbrainzConnect(token.trim())).catch(e => ({ error: e.message }))
    if (!result?.ok) { setStatus({ message: result?.error || 'ListenBrainz refused the token.', error: true }); return }
    setStatus(null)
    onConnected?.()
    onClose?.()
  }

  return (
    <Modal open={open} onClose={onClose} title="Sign in to ListenBrainz" width="max-w-sm">
      <div className="space-y-4">
        <Step n={1}><LinkButton href="https://listenbrainz.org/settings/">Get your user token</LinkButton></Step>
        <Step n={2}>
          <input aria-label="User token" type="password" value={token} onChange={e => { setToken(e.target.value); setStatus(null) }}
            onKeyDown={e => { if (e.key === 'Enter') connect() }} placeholder="User token" spellCheck={false} autoComplete="off" className={input} />
        </Step>
        <Step n={3}><PrimaryButton onClick={connect} disabled={!token.trim() || status?.busy} busy={status?.busy}>Connect</PrimaryButton></Step>
        <Status status={status} />
      </div>
    </Modal>
  )
}

/**
 * Beatport: username and password (only the token Beatport gives back is
 * kept), or a token copied from the API docs page when that sign-in fails.
 */
export function BeatportSignInModal({ open, onClose, onConnected }) {
  const [mode, setMode] = useState('password') // 'password' | 'token'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [status, setStatus] = useState(null)
  useEffect(() => { if (open) { setMode('password'); setPassword(''); setToken(''); setStatus(null) } }, [open])

  const ready = mode === 'password' ? username.trim() && password : token.trim()
  const connect = async () => {
    if (!ready || status?.busy) return
    setStatus({ message: 'Signing in to Beatport…', busy: true })
    const result = await Promise.resolve(mode === 'password' ? api.beatportLogin(username.trim(), password) : api.beatportConnectToken(token.trim()))
      .catch(e => ({ error: e.message }))
    setPassword('')
    if (!result?.ok) { setStatus({ message: result?.error || 'Beatport sign-in failed.', error: true }); return }
    setStatus(null)
    onConnected?.(result)
    onClose?.()
  }
  const onEnter = e => { if (e.key === 'Enter') connect() }
  const tab = active => `flex-1 rounded-lg px-3 py-1.5 text-xs transition-colors ${active ? 'bg-accent/15 text-accent' : 'text-muted hover:text-white'}`

  return (
    <Modal open={open} onClose={onClose} title="Sign in to Beatport" width="max-w-sm">
      <div className="space-y-4">
        <div className="flex gap-1 rounded-xl border border-border bg-card/40 p-1">
          <button type="button" className={tab(mode === 'password')} onClick={() => { setMode('password'); setStatus(null) }}>Account</button>
          <button type="button" className={tab(mode === 'token')} onClick={() => { setMode('token'); setStatus(null) }}>Token</button>
        </div>
        {mode === 'password' ? (
          <>
            <Step n={1}>
              <input aria-label="Beatport username" value={username} onChange={e => { setUsername(e.target.value); setStatus(null) }} onKeyDown={onEnter}
                placeholder="Username or email" spellCheck={false} autoComplete="username" className={input} />
            </Step>
            <Step n={2}>
              <input aria-label="Beatport password" type="password" value={password} onChange={e => { setPassword(e.target.value); setStatus(null) }} onKeyDown={onEnter}
                placeholder="Password" autoComplete="current-password" className={input} />
            </Step>
            <Step n={3}><PrimaryButton onClick={connect} disabled={!ready || status?.busy} busy={status?.busy}>Sign in</PrimaryButton></Step>
            <p className="text-[11px] leading-relaxed text-subtle">Your password is sent to Beatport only. Lokal keeps the access token Beatport returns, not the password.</p>
          </>
        ) : (
          <>
            <Step n={1}><LinkButton href="https://api.beatport.com/v4/docs/">Open the Beatport API docs and log in</LinkButton></Step>
            <Step n={2}>
              <textarea aria-label="Beatport token" value={token} onChange={e => { setToken(e.target.value); setStatus(null) }} rows={3}
                placeholder="Paste the JSON of the /auth/o/token/ request (browser dev tools › Network)" spellCheck={false} autoComplete="off" className={`${input} resize-none font-mono text-xs`} />
            </Step>
            <Step n={3}><PrimaryButton onClick={connect} disabled={!ready || status?.busy} busy={status?.busy}>Connect</PrimaryButton></Step>
          </>
        )}
        <Status status={status} />
      </div>
    </Modal>
  )
}
