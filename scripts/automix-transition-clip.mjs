// Offline, pair-specific stem clip preparation for an eventual third audio
// deck. Keeps only the mixed window, not the two full songs; the receiving
// player must resume song 2 at song2_transition_end_source_seconds.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileSha256 } from './automix-import-cues.mjs'

export const STEM_CLIP_SCHEMA = 'lokal-automix-stem-clip-v1'
export function defaultStemClipPath(outgoing, incoming) {
  const id = createHash('sha256').update(path.resolve(incoming)).digest('hex').slice(0, 24)
  return path.resolve(outgoing) + '.lokal-stem-to-' + id + '.wav'
}

const finite = value => typeof value === 'number' && Number.isFinite(value)

/** Read-only, fail-closed interpretation of the upstream stem-render report.
 * The renderer's full WAV timeline contains song 1 up to outStart followed
 * by the mixed window, followed by song 2 from resumeIn. Without this map a
 * player might repeat a vocal line or silently skip an entire phrase.
 */
export function validateStemRenderReport(report, { song1sha, song2sha } = {}) {
  if (!report || !/^[a-f0-9]{64}$/.test(song1sha || '') ||
      !/^[a-f0-9]{64}$/.test(song2sha || '') ||
      report.song1_sha256 !== song1sha || report.song2_sha256 !== song2sha) return null
  const outStart = report.song1_transition_start_seconds
  const inStart = report.song2_transition_start_seconds
  const resumeIn = report.song2_transition_end_source_seconds
  const length = report.transition_seconds
  const masterGain = report.master_gain
  const sampleRate = report.sample_rate
  if (![outStart, inStart, resumeIn, length, masterGain, sampleRate].every(finite) ||
      outStart < 15 || inStart < 0 || inStart > 60 ||
      resumeIn <= inStart || resumeIn > 7200 || length < 6 || length > 45 ||
      !(masterGain > 0 && masterGain <= 1.05) ||
      sampleRate < 22050 || sampleRate > 192000 || report.channels !== 2) return null
  // Model-driven pre-rendered stem mix must pass the upstream QA before it
  // can be published for potential *live* handoffs. A standalone WAV can
  // still be auditioned, even if QA does not pass.
  if (report.handoff_smoothness_qa?.passed !== true ||
      report.vocal_continuity_qa?.passed !== true) return null
  return {
    outStart, inStart, resumeIn, length, masterGain, sampleRate,
  }
}

export function validStemClipManifest(manifest, { song1sha, song2sha, clipSha } = {}) {
  if (manifest?.schema !== STEM_CLIP_SCHEMA ||
      manifest?.source?.outgoingSha256 !== song1sha ||
      manifest?.source?.incomingSha256 !== song2sha ||
      manifest?.clip?.sha256 !== clipSha) return false
  const { outStart, inStart, resumeIn, length, masterGain } = manifest.timeline || {}
  return [outStart, inStart, resumeIn, length, masterGain].every(finite) &&
      outStart >= 15 && inStart >= 0 && resumeIn > inStart &&
      length >= 6 && length <= 45 && masterGain > 0 && masterGain <= 1.05
}

export async function exportStemWindow({
  sourceWav, reportPath, outgoing, incoming, output, ffmpeg = 'ffmpeg',
  ffprobe = 'ffprobe', overwrite = false,
}) {
  if (!output || !existsSync(sourceWav) || !existsSync(reportPath)) {
    throw Error('Prepared master WAV, report and explicit output are required')
  }
  if ([sourceWav, reportPath, outgoing, incoming].some(f => path.resolve(f) === path.resolve(output))) {
    throw Error('Stem clip must not overwrite a source or its report')
  }
  const destination = path.resolve(output)
  const manifestPath = destination + '.json'
  if (!overwrite && (existsSync(destination) || existsSync(manifestPath))) {
    throw Error('Prepared clip or manifest already exists; use --overwrite')
  }
  const sourceHashes = await Promise.all([fileSha256(outgoing), fileSha256(incoming)])
  const raw = JSON.parse(readFileSync(reportPath, 'utf8'))
  const timing = validateStemRenderReport(raw, {
    song1sha: sourceHashes[0], song2sha: sourceHashes[1],
  })
  if (!timing) throw Error('The stem report is stale, unsafe or failed vocal/level QA')
  const sourceStat = statSync(sourceWav)
  if (!sourceStat.isFile() || sourceStat.size < 128 ||
      sourceStat.size > 2 * 1024 * 1024 * 1024) throw Error('Invalid master WAV')

  const temp = `${destination}.${process.pid}.tmp.wav`
  const tempManifest = `${manifestPath}.${process.pid}.tmp`
  try {
    // FFmpeg performs an accurate PCM cut. Do NOT extract the upstream
    // preview, which includes song 1 lead-in and song 2 suffix.
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-ss', String(timing.outStart), '-i', sourceWav,
      '-t', String(timing.length), '-map', '0:a:0',
      '-ac', '2', '-c:a', 'pcm_s24le', '-f', 'wav', temp,
    ], { stdio: 'pipe', timeout: 90000 })
    const generated = statSync(temp)
    if (generated.size < 128 || generated.size > 100 * 1024 * 1024) {
      throw Error('Mixed stem clip has invalid size')
    }
    const clipLength = Number(execFileSync(ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', temp,
    ], { encoding: 'utf8', timeout: 30000 }).trim())
    if (!finite(clipLength) || Math.abs(clipLength - timing.length) > 0.1) {
      throw Error('Stem clip duration differs from its source timeline')
    }
    const clipSha = await fileSha256(temp)
    const manifest = {
      schema: STEM_CLIP_SCHEMA,
      source: { outgoingSha256: sourceHashes[0], incomingSha256: sourceHashes[1] },
      clip: { sha256: clipSha, bytes: generated.size, durationSeconds: clipLength },
      timeline: timing,
    }
    writeFileSync(tempManifest, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
    // The manifest is the commit marker; a reader must also compare clip SHA.
    // Remove any previous marker first or it could point at a partly replaced
    // clip if an overwrite is interrupted.
    rmSync(manifestPath, { force: true })
    renameSync(temp, destination)
    renameSync(tempManifest, manifestPath)
    return { output: destination, manifestPath, ...manifest }
  } finally {
    rmSync(temp, { force: true })
    rmSync(tempManifest, { force: true })
  }
}
