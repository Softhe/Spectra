# Audio quality corpus

Labeled test data for the detection engine in `src/lib/audio/analyze.ts`.
Four synthesized signals (bright / quiet / noisy / stepped-sine sweep) are
encoded at known bitrates; the scorer runs the app's **real** detection
functions against the decoded PCM and prints a confusion matrix, the A/B
verdicts the app must get right, and an `EXPECT` block of calibration
invariants (exit code 1 on any FAIL or XPASS; see [Known gaps](#known-gaps)).

Composition (93 items in the snapshot):

| Leg                    | Items                                                                                                       | Rate / length    | Source                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------- |
| original               | `{kind}-ref`, `-mp3-{96,128,192,320,64m}`, `-aac-{64,128,256}`, `-opus-{64,96,128}`, transcodes             | 44.1 kHz, 8 s    | lamejs + FFmpeg           |
| 48 kHz                 | `{kind}-48k-ref`, `-48k-aac-{64,128,256}`, `-48k-opus-{64,96,128}`, `-48k-mp3-{128,320}`, `bright-48k-alac` | 48 kHz, 8 s      | FFmpeg (MP3 = libmp3lame) |
| long                   | `bright-long-ref`, `bright-long-aac-256`, `bright-long-alac`                                                | 44.1 kHz, 40 s   | FFmpeg                    |
| Lite (opt-in `LITE=1`) | `bright-lite-aac-256`                                                                                       | 44.1 kHz, 16 min | FFmpeg                    |

`bright-long` has a −30 dB intro (0–6 s), fade-in (6–8 s), full level
(8–33 s) and a fade-out to silence (33–40 s), so the >20 s loudness-ranked
picker in `pickRegions` must skip both ends. The Lite item loops it to 16 min
(> 15 min → `pickRegionsFromBuffer` + `excerptRegion` + `runDsp` with spans,
mirrored in `score-corpus.mjs`). All long/ALAC `.m4a` files are written
**without** `+faststart`, so `moov` sits after `mdat` and past the sniffer's
512 KB head window (`sniff-check.mjs` asserts that layout as a precondition).

`manifest.json` is a committed snapshot of the corpus composition. The audio
itself (tens of MB of derived files) lives in `$CORPUS_DIR` (default
`/tmp/corpus`) and is regenerable with the recipe below.

## Recipe

```sh
# 0. Tools (one time): playwright browsers, lamejs, a native FFmpeg 7+ with
#    aac/libopus/libmp3lame/alac encoders. The Playwright-bundled ffmpeg is
#    video-only; ffmpeg-static (7.0.2, same build as the snapshot) works:
npx playwright install chromium
npm install --prefix /tmp/corpus-tools lamejs ffmpeg-static
export FF=/tmp/corpus-tools/node_modules/ffmpeg-static/ffmpeg

# 1. Synthesize the reference WAVs (deterministic, seeded): 4 × 44.1 kHz/8 s
#    (byte-identical to the original corpus), 4 × 48 kHz/8 s, bright-long 40 s
node scripts/corpus/gen-wavs.mjs

# 2a. MP3 leg via lamejs in the browser. Any page works as the host; the
#     corpus static server avoids needing the app dev server:
node scripts/corpus/static-server.mjs &   # serves decode.html + audio on :8099
APP_URL=http://127.0.0.1:8099/corpus/decode.html node scripts/corpus/make-corpus.mjs

# 2b. AAC/Opus/ALAC/transcode/48k/long legs via native FFmpeg
#     (LITE=1 adds the 16-min item: ~30 MB encoded, ~170 MB decoded f32)
LITE=1 sh scripts/corpus/encode.sh

# 3. Decode everything with the browser's own decoder into .f32 mono.
#    FF enables the FFmpeg fallback for ALAC (see scope notes).
node scripts/corpus/decode-dump.mjs

# 4. Score: cutoff / rolloff / class / score per item + key verdicts
node --experimental-strip-types --no-warnings \
  --loader ./scripts/corpus/ts-resolve.mjs ./scripts/corpus/score-corpus.mjs

# 5. Header-parser fixtures + real-encode sniff checks (files from step 2b;
#    each real-file case skips when its file is absent)
node --experimental-strip-types --no-warnings \
  --loader ./scripts/corpus/ts-resolve.mjs ./scripts/corpus/sniff-check.mjs
```

`ts-resolve.mjs` is a tiny ESM hook that lets plain Node import the repo's
extensionless TypeScript sources, so the harness always tests real code —
never copies.

## Scope notes

- Pure test tones (e.g. two sine waves, no mid-band content) defeat any
  relative-threshold detector: with an empty mid band there is no anchor, so
  window leakage reads as full bandwidth. Two separate guards were tried
  (absolute −90 dBFS floor; skipping mid-silent frames) and both misgraded
  quiet music, so both were reverted. Real songs always carry mid-band
  energy; test tones are out of scope (the app targets same-song
  comparisons, where both files share the same sparseness anyway).
- **Decode rate.** `decode.html` decodes with `OfflineAudioContext(2, 128,
rate)` like the app's `decodeNative`; a realtime `AudioContext` resamples to
  the device rate, so 48 kHz items would silently be graded at 44.1 kHz.
  `rate` is the item's label (48000 for `-48k` names, else 44100). The
  original Opus items therefore stay decoded at 44.1 kHz (as in the snapshot),
  whereas the app decodes Opus at the sniffed 48 kHz — the `-48k-opus` items
  cover that path.
- **ALAC is not decodable in Chromium or Firefox** (`decodeAudioData` rejects
  it; Playwright WebKit lacks host libs here). The app's analysis therefore
  fails on ALAC in those browsers. With `FF` set, `decode-dump.mjs` decodes
  ALAC with FFmpeg instead and tags the item `decoder: "ffmpeg"` — those items
  test the detector on the true PCM, not the app's decode path.
- **48 kHz same-class expectations are strict** and some pairs fail for
  encoder reasons, not grader reasons (FFmpeg's native AAC shows no low-pass
  at 44.1 kHz/256k but a visible ~21.4 kHz cut at 48 kHz; the 48k MP3s come
  from libmp3lame, the 44.1 kHz ones from lamejs). Those pairs are tracked as
  [known gaps](#known-gaps). Read the detail lines (class@cutoff/rolloff for
  both sides) before "fixing" the grader.
- **Long items** reuse the 8 s signal with an envelope, so their spectrum
  (and class) must match the short item; the regions check additionally
  proves loudness ranking excluded the intro and fade-out.

## Known gaps

`KNOWN_GAPS` in `score-corpus.mjs` lists checks that currently fail for an
accepted reason, keyed by check name + item pair, each with the exact wrong
outcome it records (`classA/classB` for same-class checks) and a one-line
reason. The scorer then prints:

| Line                               | Meaning                                      | Exit code   |
| ---------------------------------- | -------------------------------------------- | ----------- |
| `XFAIL`                            | listed, failing with the recorded outcome    | not counted |
| `FAIL … (known gap changed …)`     | listed, failing with a different outcome     | 1           |
| `XPASS … — remove from KNOWN_GAPS` | listed, now passing                          | 1           |
| `FAIL … stale KNOWN_GAPS entry`    | entry matches no check (typo / renamed item) | 1           |

The summary line counts `pass / fail / xfail / xpass / skip`. Current gaps,
all `same-class-48k` (48 kHz item vs its 44.1 kHz twin) and all the 44.1 kHz
detector being too generous on some real encodes:

| Pair                                    | Recorded (48k/44.1k) | Reason                                                   |
| --------------------------------------- | -------------------- | -------------------------------------------------------- |
| `bright-48k-aac-128` ~ `bright-aac-128` | medium/standard      | cuts 17.1k vs 16.9k straddle the 17 kHz class line       |
| `bright-48k-aac-256` ~ `bright-aac-256` | high/lossless        | 44.1k AAC-256 shows no low-pass → false lossless         |
| `noisy-48k-aac-256` ~ `noisy-aac-256`   | high/lossless        | same as above                                            |
| `quiet-48k-aac-64` ~ `quiet-aac-64`     | low/high             | sparse 44.1k AAC-64 reads full band                      |
| `quiet-48k-opus-64` ~ `quiet-opus-64`   | low/standard         | sparse 44.1k Opus-64 cut reads ~15.9k vs ~12k at 48k     |
| `sweep-48k-aac-128` ~ `sweep-aac-128`   | medium/lossless      | sparse 44.1k sweep reads full band → false lossless      |
| `sweep-48k-mp3-320` ~ `sweep-mp3-320`   | high/lossless        | lamejs 44.1k sweep reads lossless vs libmp3lame 48k high |

These are deferred to a separate 44.1 kHz detector recalibration PR. That PR
should delete each entry as its check turns XPASS; never add an entry to
silence a new regression without a reason and a recorded outcome.

## Bounded private-playlist checks

Use copies extracted into a dedicated directory named audio-tests, outside the listening library. The runner does not extract ZIPs or generate derivatives. Prepare any controlled encodes as new files in that test directory using explicit no-overwrite options.

Create cases.json in the dataset directory. Paths are relative to that directory and may not escape it, including through symlinks:

```json
{
  "cases": [
    { "a": "copies/source-128.mp3", "b": "copies/source.flac", "expected": "b-parent" },
    { "a": "copies/one.flac", "b": "copies/equivalent.wav", "expected": "neutral" },
    { "a": "copies/one.flac", "b": "copies/unrelated.flac", "expected": "different" }
  ]
}
```

Expected values are observational, neutral, different, or b-parent. b-parent permits an inconclusive result and fails on a reversed preference. It does not certify audibility. Only use it for a controlled parent/derivative relationship, not simply because one file is FLAC. Cross-service pairs normally remain observational.

With the local development server running and ffprobe available:

```sh
node scripts/corpus/playlist-check.mjs ../audio-tests/dataset http://127.0.0.1:8080/ 8 0
```

The last arguments are pair limit and zero-based offset. Each run is limited to 16 pairs, 64 MiB per compressed input, 512 MiB total input, ten minutes per file, and an estimated 256 MiB of decoded float audio per file. Free-space preflight requires at least 1 GiB or three times the selected input bytes, whichever is greater. These are conservative workload bounds, not a guarantee against operating-system or hardware failures.

The runner uses one fresh browser context at a time and the application's actual decode, worker DSP, alignment, refinement and comparison functions. It binds its fixture server to loopback and accepts a loopback application URL. Shared-passage failures cannot silently fall back to a quality recommendation. A failed case is checkpointed before the run stops. Ctrl+C closes the browser. Completed pairs remain in runs/<timestamp>/results.json, and offset allows a subsequent bounded run to continue.

Private run manifests record full input hashes, metadata and tool versions. Inputs are rehashed after analysis. Never commit those manifests, recordings, tags, filenames or private reports. Console progress uses anonymous pair IDs. The .gitignore excludes audio-tests inside the repository; keeping private data outside the repository is preferred.

The synthetic browser generator now uses a fixed 0x12345678 seed and records generatorVersion 2. Historical manifests generated with Math.random are not byte-reproducible and must not be silently compared as though they used the same inputs. Keep the existing calibration gaps visible until their new deterministic baseline is independently reviewed.

The synthetic scorer uses compareQualityMeasurements to exercise measurement calibration without treating short synthetic signals as verified songs. Product recommendations use compareAnalyses, which also requires recording identity and compatible shared-measurement coverage. Real-playlist checks exercise this complete product path.
