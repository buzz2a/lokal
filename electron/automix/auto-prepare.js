// Optional, opt-in CUE-DETR preprocessing for the next *local MP3 pair*.
// Never runs on the renderer or audio thread. The user supplies an external
// AutoMix Engine installation; no Python runtime/model weights are bundled.
'use strict'
const fs = require('fs')
const fsp = fs.promises
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const crypto = require('crypto')
const { SCHEMA, readAdvancedReport } = require('./advanced-report')
const MAX_INPUT_BYTES = 160 * 1024 * 1024
const TIMEOUT_MS = 8 * 60 * 1000

function localSource(track) {
  const file = track?.file_path
  if (typeof file !== 'string' || !path.isAbsolute(file) ||
      path.extname(file).toLowerCase() !== '.mp3' ||
      track.start_offset_ms != null || track.end_offset_ms != null ||
      track.startOffsetMs != null || track.endOffsetMs != null ||
      track.atmosNative || track.atmosEncoded) return null
  const duration = Number(track.duration)
  return Number.isFinite(duration) && duration >= 20 && duration <= 7200
    ? { file:path.resolve(file), duration } : null
}

function runModel(executable, script, song1, song2, output, cwd, register) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [script, song1, song2, '--output', output], {
      cwd, stdio: ['ignore','ignore','pipe'], windowsHide:true, shell:false,
    })
    register(child)
    let stderr = ''
    child.stderr.on('data', chunk => {
      // Bound diagnostic output; never show large model logs or source paths.
      stderr = (stderr + chunk.toString()).slice(-1200)
    })
    const timer = setTimeout(() => { child.kill(); reject(Error('CUE-DETR timeout')) }, TIMEOUT_MS)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(Error('CUE-DETR failed: ' + code + ' ' + stderr.slice(-400)))
    })
  })
}

async function fileSha256(file) {
  const hash = crypto.createHash('sha256')
  for await(const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function writeSidecar(file, role, report, source, duration) {
  if (report.cue_detector !== 'disco-eth/cue-detr' ||
      !/^[a-f0-9]{40}$/.test(report.cue_detector_revision || '')) {
    throw Error('Unknown model provenance')
  }
  const cue = Number(report[role + '_transition_start_seconds'])
  const snapped = Number(report[role + '_cue_snapped_seconds'])
  const bpm = Number(report[role + '_estimated_bpm'])
  if (![cue,snapped,bpm].every(Number.isFinite) || cue < 0 ||
      snapped < cue || snapped > duration + .5 || bpm < 50 || bpm > 220) {
    throw Error('Invalid model timing')
  }
  const entry = {time:Math.round(cue*1000)/1000,confidence:.95}
  const result = {
    schema:SCHEMA,
    source,
    durationSeconds:duration,
    bpm,
    analyzer:{
      id:'disco-eth/cue-detr',
      revision:report.cue_detector_revision,
      processorRevision:String(report.cue_processor_revision || ''),
    },
    transitionCues:{
      entrances: role === 'song2' ? [entry] : [],
      exits: role === 'song1' ? [entry] : [],
    },
  }
  const dest = file + '.lokal-automix.json'
  try {
    const previous = JSON.parse(await fsp.readFile(dest,'utf8'))
    if (previous?.schema === SCHEMA &&
        previous.source?.sha256 === source.sha256 &&
        previous.analyzer?.revision === result.analyzer.revision) {
      for (const type of ['entrances','exits']) {
        const cues = [...result.transitionCues[type],
          ...(previous.transitionCues?.[type] || [])]
          .filter(c => Number.isFinite(c?.time) && Number.isFinite(c?.confidence) &&
            c.time >= 0 && c.time <= duration && c.confidence >= 0 && c.confidence <= 1)
        const byTime = new Map()
        for (const c of cues) byTime.set(c.time.toFixed(2),c)
        result.transitionCues[type] = [...byTime.values()].slice(0,24)
      }
    }
  } catch {}
  const tmp = dest + '.' + process.pid + '.tmp'
  try {
    await fsp.writeFile(tmp,JSON.stringify(result),{flag:'wx'})
    await fsp.rename(tmp,dest)
  } finally {
    await fsp.rm(tmp,{force:true}).catch(()=>{})
  }
}

function makeAutoPrepare({ executable = process.platform === 'win32' ? 'python' : 'python3' } = {}) {
  let inFlight = null
  let child = null
  let generation = 0
  const pairs = new Map()

  async function prepare(outgoing, incoming, engineFolder) {
    const a = localSource(outgoing), b = localSource(incoming)
    if (!a || !b || a.file === b.file ||
        typeof engineFolder !== 'string' || !path.isAbsolute(engineFolder)) {
      return { prepared:false, reason:'unsupported' }
    }
    const root = path.resolve(engineFolder)
    const script = path.join(root, 'cue_analysis.py')
    try {
      if (!(await fsp.stat(script)).isFile()) return {prepared:false,reason:'no-engine'}
    } catch { return {prepared:false,reason:'no-engine'} }
    let sa, sb
    try {
      [sa,sb] = await Promise.all([fsp.stat(a.file),fsp.stat(b.file)])
      if (![sa,sb].every(s => s.isFile() && s.size > 0 &&
          s.size <= MAX_INPUT_BYTES)) return {prepared:false,reason:'too-large'}
    } catch { return {prepared:false,reason:'missing-source'} }
    // A prepared structural cue on both roles is already source-stamped.
    // Reuse it instead of re-running a minutes-long detector on every app
    // launch or Flow refill.
    if (readAdvancedReport(a.file,sa)?.exits.length &&
        readAdvancedReport(b.file,sb)?.entrances.length) {
      return {prepared:true,cached:true}
    }
    const key = [root,a.file,sa.size,sa.mtimeMs,b.file,sb.size,sb.mtimeMs].join('|')
    if (pairs.has(key)) return pairs.get(key)
    // Supersede any older pair immediately; only one model process remains.
    const token = ++generation
    if (child) child.kill()
    const job = async () => {
      if (token !== generation) return {prepared:false,reason:'superseded'}
      const staging = await fsp.mkdtemp(path.join(os.tmpdir(),'lokal-cue-detr-'))
      try {
        const first = path.join(staging,'song1.mp3')
        const second = path.join(staging,'song2.mp3')
        const reportPath = path.join(staging,'cue_report.json')
        await Promise.all([fsp.copyFile(a.file,first),fsp.copyFile(b.file,second)])
        if (token !== generation) return {prepared:false,reason:'superseded'}
        await runModel(executable,script,first,second,reportPath,root,
          running => { child = running })
        if (token !== generation) return {prepared:false,reason:'superseded'}
        const report = JSON.parse(await fsp.readFile(reportPath,'utf8'))
        const [hashA,hashB] = await Promise.all([fileSha256(a.file),fileSha256(b.file)])
        if (report.song1_sha256 !== hashA || report.song2_sha256 !== hashB) {
          return {prepared:false,reason:'changed-source'}
        }
        const [fa,fb] = await Promise.all([fsp.stat(a.file),fsp.stat(b.file)])
        if (fa.size !== sa.size || fb.size !== sb.size ||
            fa.mtimeMs !== sa.mtimeMs || fb.mtimeMs !== sb.mtimeMs) {
          return {prepared:false,reason:'changed-source'}
        }
        await writeSidecar(a.file,'song1',report,{size:fa.size,mtimeMs:fa.mtimeMs,sha256:hashA},a.duration)
        await writeSidecar(b.file,'song2',report,{size:fb.size,mtimeMs:fb.mtimeMs,sha256:hashB},b.duration)
        return {prepared:true}
      } catch (_) {
        return {prepared:false,reason:'analyzer-failed'}
      } finally {
        child = null
        await fsp.rm(staging,{recursive:true,force:true}).catch(()=>{})
      }
    }
    // Explicitly serialized, so large model sessions never multiply memory
    // usage. Stale queued tasks are discarded when a newer pair is requested.
    const result = (inFlight || Promise.resolve()).catch(()=>{}).then(job)
    inFlight = result
    pairs.set(key,result)
    result.then(value => {
      // An interrupted/failed job must be retryable on the next playback.
      if (!value?.prepared && pairs.get(key) === result) pairs.delete(key)
    }).catch(() => { if (pairs.get(key) === result) pairs.delete(key) })
    while(pairs.size>12)pairs.delete(pairs.keys().next().value)
    return result
  }
  return { prepare, cancel(){ ++generation; child?.kill(); child=null } }
}
module.exports = { localSource, makeAutoPrepare }
