# Spectra

Compare two local copies of the same recording for technical evidence of audio preservation, then listen at aligned positions and matched RMS level. Add up to two more copies when needed.

![Spectra comparison](docs/screenshot.png)

Spectra decodes and analyzes audio in your browser. Audio is not uploaded to an analysis service. Results are estimates, not certification of an original master, original encoding bitrate, lossless provenance, or audible superiority.

## Reading a result

- **Likely preserves more** means the measured differences support a relative preference between comparable copies.
- **No clear quality difference detected** means the measurements do not support a preference. It does not establish equal fidelity.
- **Not reliably comparable** means the recording match is uncertain or the files appear to contain different recordings.
- **Shared-passage comparison unavailable** means both copies could not be measured over common passages. Playback remains available, but no quality preference is shown.

Recording-match status and recommendation evidence are separate. Low/medium/high evidence labels are heuristic categories, not calibrated probabilities. Numerical scores are experimental indicators, not percentages of retained fidelity or universal ratings across songs.

Codec, sample rate, stream bitrate and bit depth describe the file. The spectral characteristics describe its decoded audio. A FLAC container does not prove a pristine source; a sharp cutoff does not prove a particular previous bitrate. Filtering and noise can affect bandwidth measurements.

## Features

- Browser decoding with worker DSP and an IndexedDB analysis cache.
- Envelope-based recording matching and trim alignment, with an uncertain outcome for insufficient evidence.
- Shared-passage remeasurement, including equal-length copies. Displays actual analyzed duration separately from the overlapping timeline. Incomplete refinement cannot silently create a preference from mismatched measurements.
- Estimated bandwidth and rolloff, sustained clipping indicators, crest factor and stereo measurements.
- Aligned A/B playback, RMS level matching, short loops, swapping, and a blind listening mode that hides identity and measurements until reveal.
- Optional third/fourth copies with pairwise comparisons. Ineligible comparisons do not earn ranking points.
- Streaming PCM WAV analysis for large files, including RF64 ds64 data lengths. Unsupported or malformed headers are rejected rather than given guessed giant sizes.
- Integer-grid bit-depth checks. Silence does not establish content depth, and a detected lower integer grid is not a provenance certificate.

## Local development

Requires Node.js 22 or newer. Install the lockfile dependencies:

```sh
npm ci
npm run dev
```

The local development page is at http://127.0.0.1:8080. Auth is disabled in the checked-in app flag. No database or API key is needed for audio comparison.

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

The test runner works without POSIX shell syntax. The environment wrapper resolves local JavaScript command bins on Windows without invoking a command shell. Database migration skips when DATABASE_URL is absent.

Browser smoke checks accept output paths inside this project:

```sh
node scripts/browser-smoke.mjs http://127.0.0.1:8080/ screenshots/dev.png
```

The helper checks desktop/mobile rendering, errors, overflow, branding and auth invariants. Visually inspect its screenshots as well. Use a distinct output path and --baseline for built-output comparison.

## Audio support

Drop supported MP3, M4A/AAC, WAV, FLAC, AIFF, OGG/Opus or WebM files into the slots. Support ultimately depends on the browser decoder. ALAC M4A may be unsupported in the browser being used; convert a separate test copy to a supported lossless format when necessary. Decoder failures are reported without a quality verdict.

## Validation and private audio

The synthetic corpus and its known calibration gaps are documented in scripts/corpus/README.md. A passing unit suite is not proof of calibrated quality detection. Encode/decode toolchain changes and synthetic signal changes require separate baseline review.

The opt-in playlist runner accepts explicitly selected files inside a dedicated audio-tests directory. It never discovers a listening library, extracts archives, converts inputs in place, or uploads audio. It limits input size, duration and estimated decoded memory, runs sequentially, hashes inputs before/after, and checkpoints each pair into a separate local run directory.

See scripts/corpus/README.md for its cases.json format and invocation. Keep private audio, tags, filenames and full reports out of Git. Use anonymous fixture identifiers in shareable evidence. Use separate extracted copies and retain the original ZIPs.

## Implementation

- src/lib/audio/analyze.ts: browser analysis and the shared comparison decision.
- src/lib/audio/align.ts: envelope matching and lag estimates.
- src/lib/audio/refine.ts: aligned common windows and coverage metadata.
- src/lib/audio/rank.ts: consistent refined values and pairwise eligibility.
- src/lib/audio/wav-source.ts: bounded PCM WAV/RF64 reading.

The DSP functions are shared between workers and the main-thread fallback. The result cache uses sampled hashes for reuse; these are not full-file identity proofs. No exact-file-equivalence claim is made from those cache keys.

## License

MIT. See LICENSE.
