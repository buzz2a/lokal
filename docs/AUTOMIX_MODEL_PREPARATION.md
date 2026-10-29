# Optional AutoMix model preparation

Lokal's baseline AutoMix analysis runs with the app's existing FFmpeg worker
and SQLite cache. The **optional model tier** adds externally prepared
CUE-DETR structural cues and can precompute Demucs stems without bundling a
PyTorch stack into Lokal desktop or the Android APK.

## Prerequisites

- A separately installed and licensed
  [AutoMix Engine](https://github.com/VertexSelection/automix-engine)
  with its documented dependencies and `vendor/cue-detr` model.
- `node` and `ffprobe` on PATH, or pass `--ffprobe /path/to/ffprobe`.
- The upstream CUE-DETR script currently requires **two MP3s in the same
  directory**, even if Lokal itself can play other file formats.
- Windows: the cue importer works in Node; the upstream stem-preparation
  script uses Unix `fcntl` and needs Linux/WSL or an adapted upstream
  installation.

### Prepare and import directly (offline)

```bash
node scripts/automix-import-cues.mjs \
  --song1 "/music/a.mp3" --song2 "/music/b.mp3" \
  --engine "/path/to/automix-engine" --python python3
```

This explicitly runs the upstream `cue_analysis.py`, verifies both source
SHA-256 fingerprints and creates two `*.mp3.lokal-automix.json` sidecars
beside the original tracks. **Lokal never runs that Python analyzer when
playing a song.** For a report that was already prepared:

```bash
node scripts/automix-import-cues.mjs \
  --song1 "/music/a.mp3" --song2 "/music/b.mp3" \
  --report "/path/to/cue_report.json"
```

Report structure includes the upstream model revision and both role-specific
*overlap start* positions. Do not confuse those with later snapped cue
timestamps. The desktop player uses both roles only if it can fit a complete
32-beat overlap; otherwise the normal beatmatch/smart handoff remains.

### Optional stem preparation

The upstream stem script expects two fixed files in its own root. To avoid
overwriting user content, the Lokal helper **will not copy or replace them**.
If you have independently prepared matching `song1.mp3` and `song2.mp3`
in your upstream engine directory, you can add:

```bash
  --prepare-stems
```

along with `--engine`, `--song1` and `--song2`. The helper verifies SHA-256
of the upstream root files before running `stem_transition.py --prepare-only`.
The upstream engine owns the content-addressed 60-second Demucs cache and
model licenses. Stem assets are *not yet played or imported into Lokal*.
This stage prepares them for a future stem-aware renderer, rather than
silently substituting a pre-rendered audio mix or changing bit-perfect paths.

## Audition a real Demucs stem mix (offline)

Once the upstream engine has prepared its content-addressed Demucs windows,
the following explicit command runs its **render-only** path and exports the
actual stem-processed result as a regular stereo WAV:

```bash
node scripts/automix-export-stems.mjs \
  --engine "/path/to/automix-engine" \
  --song1 "/music/a.mp3" --song2 "/music/b.mp3" \
  --output "/music/automix-a-to-b.wav"
```

The tool validates the two upstream root input MP3 files by SHA-256, fails if
`--render-only` cannot find a prepared stem cache, verifies the returned WAV
header and size, and publishes a complete copy atomically.

For live use in the experimental third-deck player, supply
`--clip-output auto` as well. The importer then places the clip beside song 1
with a deterministic fingerprint of song 2's local path so Lokal can find the
exact pair without scanning directories. You may also supply
`--clip-output "/music/a-to-b-stem-window.wav"` for a standalone clip
that will not be discovered automatically. This extracts **only**
the source-verified, already-mixed transition window into a separate bounded
stereo WAV and publishes an adjacent `.json` manifest with the exact outgoing
source position, incoming entry, transition duration and source-resume position.
The exporter refuses a report with failed vocal-continuity or handoff-smoothness
checks and checks the two original audio SHA-256 fingerprints. It uses FFmpeg
and FFprobe for sample-accurate audio extraction and output validation.

Desktop also offers **Automatic Cue Preparation** in Settings → Playback.
When enabled, point **AutoMix Engine Folder** at an existing engine checkout
containing `cue_analysis.py` and its model dependencies. Lokal will
asynchronously stage upcoming **local MP3** pairs, serialize CUE-DETR jobs,
merge fresh structural cues into the existing analysis cache and reuse valid
sidecars in later sessions. A slow or unavailable analyzer never blocks the
active song, and signed streams / other formats retain the lightweight
analysis path. Model weights are not installed or downloaded by Lokal.

The desktop player now supports this prepared clip through an explicit
**Settings → Playback → Prepared Stem Mixes (Experimental)** toggle (default
Off). For a matching local song pair, it verifies both original audio
fingerprints and the clip's SHA-256, uses a third pauseable media deck for
the stem-rendered overlap, and then resumes the incoming source at the exact
time in the manifest. A short audio crossfade masks the join.

The opt-in path never runs Python or Demucs during playback and falls back to
ordinary AutoMix for absent/stale clips, streaming songs, album CUE slices,
unsupported speeds or missing model cues. Skipping and seeking abort the
third deck. **This path requires real-world listening and pause/seek QA
before it should be enabled by default.** It does not replace
existing output unless `--overwrite` is explicitly provided. The output
is an **actual stem-mixed recording**, suitable for playback in Lokal as a
normal local file or for A/B listening evaluation.

This command is deliberately *offline*: the live player does **not** substitute
the resulting WAV for the track-to-track transition yet. The offline mix can
contain both full songs, so its size can be large (bounded to 2 GiB by the
exporter). Do not run it automatically for streaming tracks, an entire Flow
queue or on battery-constrained Android hardware.

## Mobile transfer

Copy both the original audio file and its adjacent
`<filename>.lokal-automix.json` sidecar to device storage. Mobile validates
the file size and timestamp; if timestamps changed during copy, it can verify
the full audio SHA-256 once (asynchronously, only for the explicitly prepared
sidecar). This is computational work, so prewarm the small Flow queue rather
than eagerly hashing a large library.

The Android crossfader can take advantage of model-derived outgoing and
incoming overlap start hints if both are valid and near the end of the
outgoing file. Actual playback stays on the existing Android decoder and
crossfade implementation; model stems are not mixed.

## Safety, invalidation and limitations

- Sidecar files are size capped (128 KiB) and validated against source
  fingerprints, duration, cue bounds and the CUE-DETR model identifier.
- Local audio modifications invalidate the metadata automatically.
- The desktop main process does not run model inference and mobile never
  downloads model weights.
- Sidecars for streaming signed URLs, content URIs and CUE-sliced tracks
  are not used.
- Model structural cues are **not a vocal-absence guarantee**. For mobile
  without separated stems, early transitions are limited to the last
  30 seconds.
- This does not enable sample-aligned, vocal-aware stem mixing or native
  time-stretch on mobile. Those require a dedicated audio rendering pipeline,
  model QA, cache size controls, and explicit opt-in.
- Review upstream LGPL-2.1 and third-party model/weight licenses before
  distributing a bundled model or derived binary dependencies.
