import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eligibleStemTransition, createStemPlayback } from '../src/audio/stemPlayback.js'
import { defaultStemClipPath } from './automix-transition-clip.mjs'

const require=createRequire(import.meta.url)
const { stemClipPath, loadPreparedStemClip, isPreparedStemClipName } =
  require('../electron/automix/stem-clip.js')
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')

const plan={kind:'beatmatch',start:166.1,length:16,inOffset:7.9}
const clip={audio:Uint8Array.from({length:256},(_,i)=>i%256),
  outStart:166.4,inStart:8,resumeIn:24,durationSeconds:16,masterGain:.9}

test('only source-aligned, native-speed stem windows may substitute for AutoMix',()=>{
  assert.equal(eligibleStemTransition(clip,plan),true)
  assert.equal(eligibleStemTransition(clip,plan,1.25),false)
  assert.equal(eligibleStemTransition({...clip,outStart:160},plan),false)
  assert.equal(eligibleStemTransition({...clip,resumeIn:5},plan),false)
  assert.equal(eligibleStemTransition({...clip,durationSeconds:30},plan),false)
  assert.equal(eligibleStemTransition(null,plan),false)
  assert.equal(eligibleStemTransition(clip,{...plan,kind:'smart'}),false)
})

test('Electron loads only fingerprinted local prepared pairs', async t=>{
  const dir=mkdtempSync(join(tmpdir(),'lokal-stem-pair-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const outFile=join(dir,'out.mp3'),inFile=join(dir,'in.mp3')
  const a=Buffer.from('original outgoing audio bytes')
  const b=Buffer.from('original incoming audio bytes')
  writeFileSync(outFile,a)
  writeFileSync(inFile,b)
  const out={file_path:outFile},incoming={file_path:inFile}
  const output=defaultStemClipPath(outFile,inFile)
  assert.equal(stemClipPath(out,incoming),output)
  const wav=Buffer.alloc(256,0)
  wav.write('RIFF',0)
  wav.write('WAVE',8)
  writeFileSync(output,wav)
  const manifest={
    schema:'lokal-automix-stem-clip-v1',
    source:{outgoingSha256:sha(a),incomingSha256:sha(b)},
    clip:{sha256:sha(wav),bytes:wav.length,durationSeconds:16},
    timeline:{outStart:166.4,inStart:8,resumeIn:24,length:16,masterGain:.9},
  }
  writeFileSync(output+'.json',JSON.stringify(manifest))
  const loaded=await loadPreparedStemClip(out,incoming)
  assert.equal(loaded.durationSeconds,16)
  assert.equal(loaded.resumeIn,24)
  assert.equal(loaded.audio.length,256)
  assert.equal(await loadPreparedStemClip({...out,file_path:'https://example.com/a.mp3'},incoming),null)
  assert.equal(await loadPreparedStemClip({...out,start_offset_ms:100},incoming),null)
  assert.equal(await loadPreparedStemClip(out,{...incoming,file_path:outFile}),null)
  // The same *file path* with new audio bytes cannot reuse the old window.
  writeFileSync(inFile,Buffer.from('changed incoming audio'))
  assert.equal(await loadPreparedStemClip(out,incoming),null)
})

test('a forged clip with wrong source revision fails closed',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'lokal-stem-forged-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const outFile=join(dir,'a.flac'),inFile=join(dir,'b.flac')
  writeFileSync(outFile,'outgoing')
  writeFileSync(inFile,'incoming')
  const clipPath=stemClipPath({file_path:outFile},{file_path:inFile})
  const wav=Buffer.alloc(256,1)
  writeFileSync(clipPath,wav)
  writeFileSync(clipPath+'.json',JSON.stringify({
    schema:'lokal-automix-stem-clip-v1',
    source:{outgoingSha256:'a'.repeat(64),incomingSha256:sha('incoming')},
    clip:{sha256:sha(wav),bytes:wav.length},
    timeline:{outStart:130,inStart:7,resumeIn:24,length:16,masterGain:.9},
  }))
  assert.equal(await loadPreparedStemClip({file_path:outFile},{file_path:inFile}),null)
})

test('third stem deck follows pause/resume and resumes the incoming source',async()=>{
  const oldAudio=globalThis.Audio
  class FakeMedia {
    constructor(src='') {
      this.src=src;this.currentTime=0;this.duration=16
      this.paused=true;this.listeners=new Map()
    }
    addEventListener(type,fn) {
      const list=this.listeners.get(type)||new Set();list.add(fn);this.listeners.set(type,list)
    }
    removeEventListener(type,fn){this.listeners.get(type)?.delete(fn)}
    emit(type){for(const fn of this.listeners.get(type)||[])fn()}
    async play(){this.paused=false;this.emit('play')}
    pause(){this.paused=true;this.emit('pause')}
    removeAttribute(){this.src=''}
    load(){}
  }
  globalThis.Audio=FakeMedia
  const parameter=()=>({
    value:0, cancelScheduledValues(){},
    setValueAtTime(x){this.value=x}, linearRampToValueAtTime(x){this.value=x},
    setTargetAtTime(x){this.value=x},
  })
  const node=()=>({gain:parameter(),connect(){return this},disconnect(){}})
  const ctx={
    currentTime:100,createMediaElementSource(){return node()},createGain:node,
  }
  const outgoing=new FakeMedia(),incoming=new FakeMedia()
  let ending=0,aborting=0
  try {
    const outFade=node(),inFade=node(),outGain=node(),inGain=node()
    const referenceEQ = { type:'peaking',
      frequency:{value:1200}, Q:{value:1.1}, gain:{value:3} }
    const copies=[]
    ctx.createBiquadFilter=()=>{
      const filter=node()
      filter.frequency={value:0}
      filter.Q={value:0}
      filter.type='peaking'
      copies.push(filter)
      return filter
    }
    const handler=createStemPlayback({
      clip,ctx,analyser:node(),outgoing,incoming,
      outFade,inFade,outGain,inGain,equalizer:[referenceEQ],
      getVolume:()=>.65,
      onFinish:()=>ending++,onAbort:()=>aborting++,
    })
    assert.ok(handler)
    assert.equal(copies.length,1,'the optional stem signal must pass through an EQ clone')
    assert.equal(copies[0].gain.value,3)
    assert.equal(await handler.start(),true)
    assert.equal(inGain.gain.value,.65,'the real incoming decoder must not remain muted')
    assert.equal(inFade.gain.value,0)
    incoming.emit('pause')
    assert.equal(handler.element.paused,true)
    incoming.emit('play')
    await Promise.resolve()
    assert.equal(handler.element.paused,false)
    handler.element.currentTime=15.7
    handler.element.emit('timeupdate')
    assert.ok(Math.abs(incoming.currentTime-23.7)<.01)
    assert.equal(inFade.gain.value,1)
    handler.element.emit('ended')
    assert.equal(ending,1)
    assert.equal(aborting,0)
    handler.stop()
    const second=createStemPlayback({
      clip,ctx,analyser:node(),outgoing,incoming,
      outFade:node(),inFade:node(),outGain:node(),inGain:node(),
      getVolume:()=>.65,
      onFinish:()=>ending++,onAbort:()=>aborting++,
    })
    await second.start()
    incoming.currentTime=45 // explicit user seek (not internal resume)
    incoming.emit('seeking')
    assert.equal(aborting,1,'user seek must cancel optional third deck')
    second.stop()
  } finally {
    if (oldAudio === undefined) delete globalThis.Audio
    else globalThis.Audio=oldAudio
  }
})

test('generated stem windows never masquerade as user library recordings',()=>{
  const one='example.mp3.lokal-stem-to-'+'f'.repeat(24)+'.wav'
  assert.equal(isPreparedStemClipName(one),true)
  assert.equal(isPreparedStemClipName(one+'.json'),false)
  assert.equal(isPreparedStemClipName('normal-listening.wav'),false)
  assert.equal(isPreparedStemClipName('album_mix_to_stems.wav'),false)
})
