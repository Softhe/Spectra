# Spectra

Which copy kept the air? Drop two files of the _same song_ from different
sources (a SoundCloud MP3 vs an M4A, a WAV vs a FLAC) and Spectra tells you
which one is actually higher quality — by reading the audio, not the header.

![Spectra demo comparison](docs/screenshot.png)

Encoders write a bitrate in the header. That is a claim: a 320 kbps file
upconverted from 128 still dies at 16 kHz. Spectra decodes each file in your
browser, runs a spectral analysis, and finds the **spectral ceiling** — the
frequency where the encoder truly gave up — plus rolloff character, a
0–100 quality score, dynamics, and stereo info. Everything runs locally;
**no file ever leaves your browser.**

## Features

- **True-bitrate detection** — spectral ceiling, brickwall/steep/natural
  rolloff classification, and a codec-only quality score, calibrated on a
  93-item labeled corpus (MP3, AAC, Opus, ALAC, transcodes, upconverts, at
  44.1 and 48 kHz, plus 40-second and 16-minute files).
- **Fake-lossless flagging** — a WAV/FLAC/ALAC that measures band-limited
  gets called out, whatever the header claims.
- **Side-by-side evidence** — per-file spectrograms with cutoff markers,
  an overlaid average-spectrum plot, and a metric-by-metric table.
- **A/B compare by ear** — one click previews both copies back-to-back at
  the same position with RMS-matched loudness, plus a global volume slider.
- **Honest ties** — quiet/acoustic material with no high-frequency content
  is reported as source-limited instead of misgraded.
- **Fast on big files** — DSP runs in a Web Worker, results are cached in
  IndexedDB (re-drops resolve instantly), and 15+ minute files analyze from
  excerpts with a "Lite" badge instead of exhausting memory.

## Quickstart

Requires Node 22.

```sh
npm install
npm run dev      # http://0.0.0.0:8080
npm run build    # production bundle + DB migrate (skips without DATABASE_URL)
npm run typecheck
npm test         # repo unit suites
```

Drop two audio files (MP3, M4A/AAC, WAV, FLAC, AIFF, OGG/Opus, WebM) into
File A and File B — or press **Load a demo comparison** to see a full-range
master called out against a 16 kHz brickwalled rip hiding behind identical
headers. Apple Lossless (ALAC `.m4a`) decodes only in Safari; elsewhere,
convert it to FLAC or WAV first.

## How it works

`src/lib/audio/analyze.ts` is the engine: Web Audio decode → mono mix-down
with sustained-clip detection → windowed STFT (4096-pt Hann, 50% overlap)
over loudness-ranked regions → occupancy + mean-spectrum cliff detection for
the cutoff → ratio-aware quality classes → composite score → verdict with
jitter-proof win margins. Header sniffing (`sniff.ts`) is deliberately
distrusted: VBR MP3s report unknown bitrate instead of the first-frame
placeholder, and MP3 is only claimed after a confirmed frame sync. M4A's
index is found wherever it sits in the file (even after the audio), and the
codec comes from the sample entry, so ALAC isn't mistaken for AAC.

The DSP core (`runDsp`) is shared verbatim between the main-thread fallback
and `dsp.worker.ts`, so both paths produce identical numbers by construction.

## Validating with the corpus

`scripts/corpus/` holds the reproducible harness behind the numbers above
(see its README for the recipe): synth → encode at known bitrates → decode
with the browser's own decoder → score with the real detection code. The
93-item corpus covers 44.1 and 48 kHz encodes (AAC, Opus, MP3, ALAC), long
and 16-minute Lite items, and M4As with the index at the end. The scorer
prints the confusion matrix, the reference verdicts and PASS/FAIL
calibration checks; any threshold change must keep every check passing.
Seven known 48 kHz-vs-44.1 kHz calibration gaps are listed in `KNOWN_GAPS`
(`score-corpus.mjs`) and reported as XFAIL until a dedicated recalibration;
a gap that starts passing reports XPASS and fails the run until removed.

## Privacy

Analysis is 100% client-side. Files are read via blob URLs and object URLs
that never leave the tab; the IndexedDB result cache stays on your device.

## License

MIT — see [LICENSE](LICENSE).
