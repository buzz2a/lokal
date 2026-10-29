import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { sidecarForRole, mergeReports, prepareStemCache } from './automix-import-cues.mjs'
import { verifyPreparedStemSources, verifyRenderedWav } from './automix-export-stems.mjs'
import { validateStemRenderReport, validStemClipManifest, STEM_CLIP_SCHEMA } from './automix-transition-clip.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const require = createRequire(import.meta.url)
const { validateAdvancedReport, mergeAdvancedAnalysis } =
  require('../electron/automix/advanced-report.js')

const SHA1 = 'a'.repeat(64)
const SHA2 = 'b'.repeat(64)
const REVISION = 'c'.repeat(40)
const stat = { size:123456, mtimeMs:1760000000000 }
const report = {
  cue_detector:'disco-eth/cue-detr',
  cue_detector_revision:REVISION,
  cue_processor_revision:'one',
  song1_transition_start_seconds:166,
  song1_cue_snapped_seconds:181.8,
  song1_estimated_bpm:124,
  song2_transition_start_seconds:8,
  song2_cue_snapped_seconds:24,
  song2_estimated_bpm:120,
}
const source = { ...stat, sha256:SHA1 }
const out = () => sidecarForRole('song1',report,source,200)
const incoming = () => sidecarForRole('song2',report,source,200)

test('imported overlap START is represented as outgoing/incoming role cue', () => {
  assert.deepEqual(out().transitionCues.exits,[{time:166,confidence:0.95}])
  assert.deepEqual(incoming().transitionCues.entrances,[{time:8,confidence:0.95}])
  assert.equal(out().transitionCues.entrances.length,0)
})

test('valid fingerprinted report merges without changing base loudness/tempo', () => {
  const parsed = validateAdvancedReport(out(),stat)
  assert.ok(parsed)
  const base = {duration:200,bpm:124,firstBeat:0.2,energy:0.5,
    transitionCues:{entrances:[],exits:[{time:181,confidence:0.6}]}}
  const enhanced = mergeAdvancedAnalysis(base,parsed)
  assert.equal(enhanced.modelCueAnalysis,true)
  assert.equal(enhanced.bpm,124)
  assert.equal(enhanced.transitionCues.exits[0].source,'cue-detr')
  assert.equal(enhanced.transitionCues.exits[0].time,166)
  assert.equal(enhanced.transitionCues.exits.length,2)
})

test('wrong size, stale timestamp, malformed candidate and huge duration fail closed', () => {
  assert.equal(validateAdvancedReport(out(),{...stat,size:1}),null)
  assert.equal(validateAdvancedReport(out(),{...stat,mtimeMs:stat.mtimeMs+2000}),null)
  assert.equal(validateAdvancedReport({...out(),durationSeconds:1},stat),null)
  assert.equal(validateAdvancedReport({...out(),transitionCues:{exits:[null],entrances:[]}},stat),null)
  assert.equal(validateAdvancedReport({...out(),source:{...source,sha256:SHA1.slice(2)}},stat),null)
})

test('repeated cue preparation merges different paired role timings', () => {
  const combined=mergeReports(out(),incoming())
  assert.equal(combined.transitionCues.exits.length,1)
  assert.equal(combined.transitionCues.entrances.length,1)
  const replaced=mergeReports(combined,{...incoming(),source:{...source,sha256:SHA2}})
  assert.equal(replaced.transitionCues.exits.length,0)
})

test('stem preparation refuses mismatched fixed-role source files', async t => {
  const root = mkdtempSync(join(tmpdir(),'lokal-automix-stem-check-'))
  t.after(() => rmSync(root, {recursive:true,force:true}))
  const engine = join(root,'external')
  mkdirSync(engine)
  const outgoing = join(root,'a.mp3')
  const incoming = join(root,'b.mp3')
  writeFileSync(outgoing,'a')
  writeFileSync(incoming,'b')
  writeFileSync(join(engine,'song1.mp3'),'a')
  writeFileSync(join(engine,'song2.mp3'),'not the selected song')
  await assert.rejects(
    prepareStemCache({engine,song1:outgoing,song2:incoming}),
    /must match the requested track exactly/,
  )
})

test('offline WAV export rejects a mismatched source before invoking Python', async t => {
  const root=mkdtempSync(join(tmpdir(),'lokal-automix-render-check-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const engine=join(root,'engine')
  mkdirSync(engine)
  const first=join(root,'out.mp3')
  const second=join(root,'in.mp3')
  writeFileSync(first,'same-song')
  writeFileSync(second,'different-song')
  writeFileSync(join(engine,'song1.mp3'),'same-song')
  writeFileSync(join(engine,'song2.mp3'),'wrong-input')
  await assert.rejects(
    verifyPreparedStemSources(engine,first,second),
    /differs from the selected audio/,
  )
})

test('offline stem export validates WAV format instead of accepting arbitrary output', t => {
  const root=mkdtempSync(join(tmpdir(),'lokal-automix-wav-check-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const bad=join(root,'broken.wav')
  writeFileSync(bad,Buffer.alloc(256,0))
  assert.throws(()=>verifyRenderedWav(bad),/not a WAV/)
  const good=join(root,'rendered.wav')
  const wav=Buffer.alloc(256)
  wav.write('RIFF',0,'ascii')
  wav.write('WAVE',8,'ascii')
  writeFileSync(good,wav)
  assert.equal(verifyRenderedWav(good),256)
})

test('stem clip manifest maps mixed-window timeline to source resume point', () => {
  const sha1='a'.repeat(64), sha2='b'.repeat(64), wav='c'.repeat(64)
  const upstream={
    song1_sha256:sha1, song2_sha256:sha2,
    song1_transition_start_seconds:166.5,
    song2_transition_start_seconds:7.5,
    song2_transition_end_source_seconds:24.0,
    transition_seconds:16.0, master_gain:.93,
    sample_rate:44100, channels:2,
    handoff_smoothness_qa:{passed:true},
    vocal_continuity_qa:{passed:true},
  }
  const timeline=validateStemRenderReport(upstream,{song1sha:sha1,song2sha:sha2})
  assert.equal(timeline.outStart,166.5)
  assert.equal(timeline.resumeIn,24)
  assert.equal(timeline.length,16)
  const manifest={
    schema:STEM_CLIP_SCHEMA,
    source:{outgoingSha256:sha1,incomingSha256:sha2},
    timeline,clip:{sha256:wav},
  }
  assert.equal(validStemClipManifest(manifest,{song1sha:sha1,song2sha:sha2,clipSha:wav}),true)
  assert.equal(validStemClipManifest(manifest,{song1sha:sha2,song2sha:sha2,clipSha:wav}),false)
  assert.equal(validStemClipManifest(manifest,{song1sha:sha1,song2sha:sha2,clipSha:sha1}),false)
  assert.equal(validateStemRenderReport({...upstream, song2_transition_end_source_seconds:5},{song1sha:sha1,song2sha:sha2}),null)
  assert.equal(validateStemRenderReport({...upstream, vocal_continuity_qa:{passed:false}},{song1sha:sha1,song2sha:sha2}),null)
  assert.equal(validateStemRenderReport({...upstream, handoff_smoothness_qa:{passed:false}},{song1sha:sha1,song2sha:sha2}),null)
  assert.equal(validateStemRenderReport({...upstream, song1_sha256:sha2},{song1sha:sha1,song2sha:sha2}),null)
})
