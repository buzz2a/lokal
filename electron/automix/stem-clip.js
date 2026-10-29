// Read-only provider for explicitly prepared local stem transition windows.
// No external process runs here. A cached cue report or untrusted renderer
// input cannot cause the app to open arbitrary remote URLs or process models.
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { promisify } = require('util')
const stat = fs.promises.stat
const readFile = fs.promises.readFile
const sha = async file => {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
const safeLocal = track => {
  const value = typeof track?.file_path === 'string' ? track.file_path : ''
  if (!value || value.includes('://') || !path.isAbsolute(value)) return null
  if (track.start_offset_ms != null || track.end_offset_ms != null ||
      track.startOffsetMs != null || track.endOffsetMs != null) return null
  return path.resolve(value)
}

const isPreparedStemClipName = name =>
  /\.lokal-stem-to-[a-f0-9]{24}\.wav$/i.test(path.basename(name))

function stemClipPath(outgoing, incoming) {
  const one = safeLocal(outgoing)
  const two = safeLocal(incoming)
  if (!one || !two || one === two) return null
  const id = crypto.createHash('sha256').update(two).digest('hex').slice(0, 24)
  return one + '.lokal-stem-to-' + id + '.wav'
}

const isSHA = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const finite = x => typeof x === 'number' && Number.isFinite(x)
const memo = new Map()
const MAX_CLIP_BYTES = 100 * 1024 * 1024

async function loadPreparedStemClip(outgoing, incoming) {
  const clip = stemClipPath(outgoing, incoming)
  if (!clip) return null
  const one = safeLocal(outgoing), two = safeLocal(incoming)
  try {
    const [s1,s2,sc,sm] = await Promise.all([
      stat(one),stat(two),stat(clip),stat(clip+'.json'),
    ])
    if (![s1,s2,sc,sm].every(s => s.isFile()) ||
        sc.size < 128 || sc.size > MAX_CLIP_BYTES ||
        sm.size < 100 || sm.size > 16 * 1024) return null
    const manifest = JSON.parse(await readFile(clip+'.json','utf8'))
    const timeline = manifest?.timeline || {}
    if (manifest?.schema !== 'lokal-automix-stem-clip-v1' ||
        !isSHA(manifest?.source?.outgoingSha256) ||
        !isSHA(manifest?.source?.incomingSha256) ||
        !isSHA(manifest?.clip?.sha256) ||
        manifest?.clip?.bytes !== sc.size ||
        !finite(manifest?.clip?.durationSeconds) ||
        Math.abs(manifest.clip.durationSeconds - timeline.length) > 0.1 ||
        ![timeline.outStart,timeline.inStart,timeline.resumeIn,
          timeline.length,timeline.masterGain].every(finite) ||
        timeline.outStart < 15 || timeline.inStart < 0 ||
        timeline.resumeIn <= timeline.inStart ||
        timeline.length < 6 || timeline.length > 45 ||
        timeline.masterGain <= 0 || timeline.masterGain > 1.05) return null
    const stamp = [one,s1.size,s1.mtimeMs,two,s2.size,s2.mtimeMs,
      clip,sc.size,sc.mtimeMs,sm.size,sm.mtimeMs].join('|')
    if (!memo.has(stamp)) {
      // Hash after the small manifest validation. This runs off the audio
      // thread and is cached by exact source+clip+manifest file revisions.
      const [outHash,inHash,clipHash] = await Promise.all([sha(one),sha(two),sha(clip)])
      if (outHash !== manifest.source.outgoingSha256 ||
          inHash !== manifest.source.incomingSha256 ||
          clipHash !== manifest.clip.sha256) return null
      memo.set(stamp,true)
      while (memo.size > 16) memo.delete(memo.keys().next().value)
    }
    const bytes = await readFile(clip)
    if (bytes.length !== sc.size ||
        !['RIFF','RF64'].includes(bytes.toString('ascii',0,4)) ||
        bytes.toString('ascii',8,12) !== 'WAVE') return null
    return {
      audio: new Uint8Array(bytes),
      outStart:timeline.outStart,
      inStart:timeline.inStart,
      resumeIn:timeline.resumeIn,
      durationSeconds:timeline.length,
      masterGain:timeline.masterGain,
    }
  } catch {
    // Sidecars are optional. Missing, corrupt and stale pairs keep the
    // existing Web Audio crossfade and cannot interrupt the current track.
    return null
  }
}

module.exports = { stemClipPath, loadPreparedStemClip, isPreparedStemClipName }
