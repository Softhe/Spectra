# Spectra

Which copy kept the air? Drop two to four files of the _same song_ from
different sources (a SoundCloud MP3 vs an M4A, a WAV vs a FLAC) and Spectra
tells you which one is actually higher quality — by reading the audio, not
the header. If the files disagree about being the same song, it says that
too instead of inventing a winner.

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
- **Same-song verification** — a loudness envelope kept per file checks that
  the two slots really hold the same recording (and how one trims the
  intro). Mismatched uploads are flagged instead of judged; near-threshold
  pairs report "uncertain", never a confident guess from too little
  evidence.
- **Fair (shared-window) comparison** — once all files are analyzed, every
  copy is re-measured over one envelope-aligned window of the loudest
  passage they share. A trimmed copy that lost its intro is no longer
  judged on quieter material; the "Refined" badge marks where a
  re-measured ceiling changed the number.
- **Double-blind listening** — a blind round hides names, numbers and
  spectrograms behind anonymous Clip 1 / Clip 2 (including the winner
  chips), shuffles which copy sits in which slot, and reveals the mapping
  on your call.
- **Lossless depth, honestly reported** — a strict integer-grid check reads
  the bit depth the content actually sits on: 16-bit audio padded into a
  24-bit container is labeled "16-bit of 24", and dithered material is
  reported at the container depth rather than guessed.
- **Interactive excerpt re-scan** — spectrograms render a representative
  excerpt by default; "Re-scan at playhead" runs the DSP over the exact
  passage you just heard and pins it into the picture until you reset.
- **Huge WAVs stay Lite and complete** — PCM WAVs over the decode cap are
  analyzed by streaming straight off the file header walk (one-slice at a
  time) with identical decodeAudioData-parity scaling, instead of being OOM
  killed or truncated.
- **Up to four files at once** — a head-to-head leaderboard (round-robin
  points) puts every pair through the same verdict rules, with per-pair
  ear chips that jump straight into matched-loudness A/B on that pair.
- **A/B compare by ear** — one click previews both copies back-to-back at
  the same position with RMS-matched loudness, plus a global volume slider,
  an optional 5-second aligned loop on tough passages, keyboard A/B
  flipping, and Swap A/B to undo any order effects.
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
npm test         # repo unit suites (incl. alignment + WAV-streaming tests)
```

Drop two to four audio files (MP3, M4A/AAC, WAV, FLAC, AIFF, OGG/Opus,
WebM) into the slots (A–D) — or press **Load a demo comparison** to see a
full-range master called out against a 16 kHz brickwalled rip hiding behind
identical headers. Apple Lossless (ALAC `.m4a`) decodes only in Safari;
elsewhere, convert it to FLAC or WAV first.

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

Around that core sit four small modules:

- `align.ts` — loudness-envelope capture (kept on every analysis) plus the
  same-song check and lag finding behind the "Hold on — these may not be
  the same song" guard and the pair-aligned A/B loop.
- `refine.ts` — the shared-window re-measurement pass (fair comparison).
- `wav-source.ts` — bounded-memory streaming PCM readers for huge WAVs
  (header-only walk, frame-range slices, decodeAudioData-parity scaling).
- `rank.ts` — round-robin pairwise ranking for the 3–4 file leaderboard,
  with refined metrics patched in so numbers never disagree between views.

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
