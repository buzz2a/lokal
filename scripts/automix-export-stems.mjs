#!/usr/bin/env node
/**
 * Export an already-prepared upstream Demucs stem transition as a normal
 * stereo WAV. The operation is fully offline, explicit and never invoked by
 * Electron playback. Its result can be listened to or added to Lokal's
 * ordinary local library for quality assessment.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync,
  openSync, readSync, closeSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { fileSha256 } from './automix-import-cues.mjs'
import { exportStemWindow, defaultStemClipPath } from './automix-transition-clip.mjs'

const UPSTREAM_OUTPUT = path.join('output', 'beat_overlap', 'beat_overlap_transition.wav')
const UPSTREAM_REPORT = path.join('output', 'beat_overlap', 'beat_overlap_transition_report.json')
const MAX_EXPORT_BYTES = 2 * 1024 * 1024 * 1024

export async function verifyPreparedStemSources(engine, song1, song2) {
  if (!engine || !song1 || !song2) throw Error('Engine and both audio files are required')
  const root = path.resolve(engine)
  for (const [role, original] of [['song1', song1], ['song2', song2]]) {
    const expected = path.join(root, `${role}.mp3`)
    if (!existsSync(expected) || !existsSync(original) ||
        await fileSha256(expected) !== await fileSha256(original)) {
      throw Error(`Prepared ${role}.mp3 differs from the selected audio; refusing stale stem render`)
    }
  }
  return root
}

export function verifyRenderedWav(wav) {
  const stat = statSync(wav)
  if (!stat.isFile() || stat.size < 64 || stat.size > MAX_EXPORT_BYTES) {
    throw Error('No valid bounded upstream WAV was rendered')
  }
  const fd = openSync(wav, 'r')
  const signature = Buffer.alloc(12)
  try {
    if (readSync(fd, signature, 0, signature.length, 0) !== signature.length ||
        !['RIFF', 'RF64'].includes(signature.toString('ascii', 0, 4)) ||
        signature.toString('ascii', 8, 12) !== 'WAVE') {
      throw Error('Upstream stem render is not a WAV file')
    }
  } finally { closeSync(fd) }
  return stat.size
}

export async function exportPreparedStemMix({
  engine, song1, song2, output, python = 'python3', overwrite = false,
  clipOutput = null, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe',
}) {
  if (!output) throw Error('An explicit output WAV path is required')
  const root = await verifyPreparedStemSources(engine, song1, song2)
  const destination = path.resolve(output)
  const source = path.resolve(root, UPSTREAM_OUTPUT)
  if ([song1, song2, source].some(file => path.resolve(file) === destination)) {
    throw Error('Output cannot overwrite an input or upstream master')
  }
  if (existsSync(destination) && !overwrite) {
    throw Error('Output exists; pass --overwrite to replace it explicitly')
  }
  // --render-only fails when the immutable upstream cue/stem caches are
  // incomplete. It does not silently initiate CUE-DETR or Demucs processing.
  execFileSync(python, [path.join(root, 'stem_transition.py'), '--render-only'], {
    cwd: root, stdio: 'inherit', timeout: 40 * 60 * 1000,
  })
  const bytes = verifyRenderedWav(source)
  mkdirSync(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.${process.pid}.tmp`
  try {
    await pipeline(createReadStream(source), createWriteStream(temporary, { flags: 'wx' }))
    if (statSync(temporary).size !== bytes) throw Error('Incomplete rendered WAV copy')
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
  }
  const clip = clipOutput ? await exportStemWindow({
    sourceWav: source, reportPath: path.resolve(root, UPSTREAM_REPORT),
    outgoing: song1, incoming: song2,
    output: clipOutput === 'auto' ? defaultStemClipPath(song1, song2) : clipOutput,
    ffmpeg, ffprobe, overwrite,
  }) : null
  return { output: destination, bytes, clip }
}

const isMain = !!process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = {}
  for (let i = 2; i < process.argv.length; i++) {
    const word = process.argv[i]
    if (!word.startsWith('--')) throw Error('Expected --option: ' + word)
    const name = word.slice(2)
    if (name === 'overwrite') { args.overwrite = true; continue }
    if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) {
      throw Error('Missing argument for ' + word)
    }
    args[name] = process.argv[++i]
  }
  try {
    const result = await exportPreparedStemMix({
      engine: args.engine, song1: args.song1, song2: args.song2,
      output: args.output, python: args.python || 'python3',
      overwrite: args.overwrite === true,
      clipOutput: args['clip-output'], ffmpeg: args.ffmpeg || 'ffmpeg',
      ffprobe: args.ffprobe || 'ffprobe',
    })
    console.log(`Stem-rendered WAV: ${result.output} (${result.bytes} bytes)`)
    if (result.clip) console.log(`Prepared stem transition clip: ${result.clip.output}; pair manifest: ${result.clip.manifestPath}`)
    console.log('This is an offline render; Lokal does not yet insert it into the live playback queue.')
  } catch (error) {
    console.error('Stem mix export failed:', error.message)
    process.exitCode = 1
  }
}
