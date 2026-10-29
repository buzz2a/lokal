#!/usr/bin/env node
// Offline import of VertexSelection/automix-engine CUE-DETR reports.
// Optional Python execution is explicit (--engine); never runs in playback.
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const SCHEMA = 'lokal-automix-advanced-v1'
export const suffix = '.lokal-automix.json'
const DETECTOR = 'disco-eth/cue-detr'

export async function fileSha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export function sidecarForRole(role, report, source, duration) {
  if (!['song1', 'song2'].includes(role)) throw Error('Invalid song role')
  if (report.cue_detector !== DETECTOR || typeof report.cue_detector_revision !== 'string' ||
      !/^[a-f0-9]{40}$/.test(report.cue_detector_revision)) throw Error('Unrecognized CUE-DETR report')
  if (!(Number.isFinite(duration) && duration >= 20)) throw Error('Invalid decoded track duration')
  const position = Number(report[`${role}_transition_start_seconds`])
  const cue = Number(report[`${role}_cue_snapped_seconds`])
  const bpm = Number(report[`${role}_estimated_bpm`])
  if (![position, cue, bpm].every(Number.isFinite) ||
      position < 0 || cue < position || cue > duration + 0.5 ||
      bpm < 50 || bpm > 220) throw Error('Invalid or out-of-range cue/tempo')
  const entry = { time: Math.round(position * 1000) / 1000, confidence: 0.95 }
  return {
    schema: SCHEMA,
    source: { size: source.size, mtimeMs: source.mtimeMs, sha256: source.sha256 },
    durationSeconds: duration,
    bpm,
    analyzer: {
      id: DETECTOR,
      revision: report.cue_detector_revision,
      processorRevision: String(report.cue_processor_revision || ''),
    },
    transitionCues: {
      entrances: role === 'song2' ? [entry] : [],
      exits: role === 'song1' ? [entry] : [],
    },
  }
}

export function mergeReports(previous, incoming) {
  if (!previous || previous.schema !== SCHEMA ||
      previous.source?.sha256 !== incoming.source.sha256 ||
      previous.source?.size !== incoming.source.size ||
      previous.source?.mtimeMs !== incoming.source.mtimeMs ||
      previous.analyzer?.revision !== incoming.analyzer.revision ||
      previous.analyzer?.processorRevision !== incoming.analyzer.processorRevision) return incoming
  const merged = structuredClone(incoming)
  for (const role of ['entrances', 'exits']) {
    const cues = [...incoming.transitionCues[role], ...(previous.transitionCues?.[role] || [])]
      .filter(c => Number.isFinite(c?.time) && Number.isFinite(c?.confidence) &&
        c.time >= 0 && c.time <= incoming.durationSeconds &&
        c.confidence >= 0 && c.confidence <= 1)
    const byTime = new Map()
    for (const cue of cues) byTime.set(cue.time.toFixed(2), cue)
    merged.transitionCues[role] = [...byTime.values()]
      .sort((a,b)=>b.confidence-a.confidence||a.time-b.time)
      .slice(0, 24).sort((a,b)=>a.time-b.time)
  }
  return merged
}

export function saveReport(file, report) {
  const dest = file + suffix
  let previous
  if (existsSync(dest)) {
    try { previous = JSON.parse(readFileSync(dest, 'utf8')) } catch {}
  }
  const record = mergeReports(previous, report)
  const temporary = `${dest}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
    renameSync(temporary, dest)
  } finally {
    try { rmSync(temporary, { force: true }) } catch {}
  }
}

export async function importCueReport({ song1, song2, reportPath, ffprobe = 'ffprobe' }) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  for (const [role, file] of [['song1', song1], ['song2', song2]]) {
    if (!file || !existsSync(file)) throw Error('Missing track: ' + role)
    const originalStamp = statSync(file)
    const digest = await fileSha256(file)
    if (report[`${role}_sha256`] !== digest) {
      throw Error(`CUE-DETR report fingerprint mismatch for ${role}; refusing stale timings`)
    }
    const duration = Number(execFileSync(ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ], { encoding:'utf8', timeout:30000 }).trim())
    const stats = statSync(file)
    if (stats.size !== originalStamp.size ||
        Math.abs(stats.mtimeMs - originalStamp.mtimeMs) > 1) {
      throw Error(`Audio file ${role} changed during preparation; refusing a stale cache entry`)
    }
    const sidecar = sidecarForRole(role, report, { size:stats.size, mtimeMs:stats.mtimeMs, sha256:digest }, duration)
    saveReport(file, sidecar)
  }
}

/**
 * Optional Demucs window preparation inside an externally managed upstream
 * engine installation. The upstream stem renderer uses fixed root filenames:
 * never replace them silently, and never publish mismatched stems as usable.
 * Only preprocessing happens; Lokal's players do not yet render stem mixes.
 */
export async function prepareStemCache({ engine, song1, song2, python = 'python3' }) {
  if (!engine) throw Error('--prepare-stems requires --engine')
  const root = path.resolve(engine)
  for (const [role, original] of [['song1',song1],['song2',song2]]) {
    const prepared = path.join(root, `${role}.mp3`)
    if (!existsSync(prepared) ||
        await fileSha256(prepared) !== await fileSha256(original)) {
      throw Error(`Upstream ${role}.mp3 must match the requested track exactly; refusing mismatched stem preparation`)
    }
  }
  execFileSync(python, [path.join(root,'stem_transition.py'),'--prepare-only'], {
    cwd: root, stdio: 'inherit', timeout: 3 * 60 * 60 * 1000,
  })
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const name = arg.slice(2)
    if (name === 'prepare-stems') { args[name] = true; continue }
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      console.error('Missing value for --' + name)
      process.exit(2)
    }
    args[name] = argv[++i]
  }
  if (!args.song1 || !args.song2 || (!args.report && !args.engine)) {
    console.error('Usage: node scripts/automix-import-cues.mjs --song1 /path/a.mp3 --song2 /path/b.mp3 --report /path/cue_report.json [--ffprobe ffprobe]')
    console.error('Or: ... --engine /path/automix-engine [--python python3] (runs an installed CUE-DETR engine explicitly)')
    console.error('Add --prepare-stems for optional upstream Demucs caching (requires engine-root song1.mp3/song2.mp3; Linux/WSL).')
    process.exitCode = 2
  } else {
    const temporaryDir = args.engine ? mkdtempSync(path.join(tmpdir(), 'lokal-automix-cues-')) : null
    try {
      let reportPath = args.report
      if (args.engine) {
        if (path.extname(args.song1).toLowerCase() !== '.mp3' ||
            path.extname(args.song2).toLowerCase() !== '.mp3') {
          throw Error('The reference CUE-DETR pipeline currently accepts only MP3')
        }
        if (path.dirname(path.resolve(args.song1)) !== path.dirname(path.resolve(args.song2))) {
          throw Error('CUE-DETR currently requires both tracks in the same directory')
        }
        const script = path.resolve(args.engine, 'cue_analysis.py')
        reportPath = path.join(temporaryDir, 'cue_report.json')
        execFileSync(args.python || 'python3', [
          script, path.resolve(args.song1), path.resolve(args.song2),
          '--output', reportPath,
        ], { stdio: 'inherit', timeout: 30 * 60 * 1000 })
      }
      await importCueReport({ song1:args.song1, song2:args.song2,
        reportPath, ffprobe:args.ffprobe || 'ffprobe' })
      console.log('Saved per-track AutoMix cue reports beside both audio files.')
      if (args['prepare-stems']) {
        await prepareStemCache({
          engine:args.engine, song1:args.song1, song2:args.song2,
          python:args.python || 'python3',
        })
        console.log('Prepared optional upstream Demucs window cache (not yet used in live Lokal audio mixing).')
      }
    } catch (error) {
      console.error('AutoMix cue preparation failed:',error.message)
      process.exitCode = 1
    } finally {
      if (temporaryDir) rmSync(temporaryDir, {recursive:true,force:true})
    }
  }
}
