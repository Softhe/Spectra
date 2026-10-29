# Complete decoded-audio check and page text

Date: 2026-10-29

The page now separates passage-based quality evidence from an optional complete decoded-audio check. Neutral reports do not display a low-evidence label. Recording-match status, coverage and the recommendation have separate descriptions.

## Changes

- Rewrote the page descriptions, help text, blind-mode prompts, diagnostics, labels and copied report using the unslop writing guidance. Short controls with clear labels remain concise.
- Use PCM data rate for uncompressed audio, encoded audio bitrate for lossy files, and variable compressed bitrate for FLAC/ALAC. File-size averages are labeled as including metadata.
- Explain that lossless compression can produce a smaller file without lower quality. It does not prove source provenance.
- Show measured passage duration separately from total overlap, using the same formatter in the page and copied report.
- Compare every sample through a bounded slice-source interface. Streaming WAV reads use the existing PCM reader. Native FLAC decoding requires a known native rate and sample count, rejects unsupported layouts and enforces an allocation estimate before decode.
- Distinguish exact decoded equality, tolerance matches, differences and unavailable checks. The copied report includes the completed check's status, scope and sample count.
- Bind checks to the current file objects. Replacing/swapping files or entering blind mode removes prior results. New analysis cancels an active check. Cancelled, timed-out and stale checks cannot publish certificates.

## Numerical scope

Exact means equal decoded Float32 values in this browser, not identical file bytes or proof of an original master. Tolerance is an explicit absolute sample bound. It is not an audible-quality threshold.

Chromium decoding of a controlled PCM16 FLAC produced slightly different normalization from streamed WAV PCM16. The cross-format bound is one FLAC quantization step or the default 0.0000001 bound, whichever is larger. This does not change gain or seek a best fit. Same-format comparisons use the default bound. The report keeps tolerance matches separate from exact equality.

## Reproducible validation

With FFmpeg, Playwright Chromium and the development server available:

```sh
node scripts/corpus/equivalence-check.mjs http://127.0.0.1:8080/ ../audio-tests
```

This command creates a new directory of deterministic synthetic fixtures. It never reads a listening library or overwrites existing test inputs. Results, file hashes, tool versions and screenshots remain in that directory. No copyrighted/private audio is included in the repository.

The browser cases cover WAV byte/metadata differences with exact decoded equality, native WAV/FLAC decoder tolerance, a changed final sample, small floating-point differences, sample-rate/channel mismatches, unsupported channel layouts and a FLAC allocation estimate that exceeds the limit. UI checks cover neutral wording, bitrate labels, coverage, copied report, complete checks, cancellation, blind-mode reset and mobile layout.

Unit tests cover full traversal beyond the first chunk, the final sample in each channel, exact/tolerance separation, numerical bounds, missing ranges, invalid sample values, cancellation, and the shared presentation helpers. The earlier synthetic calibration gaps remain visible. No DSP score threshold or KNOWN_GAPS entry changed in this update.

The complete check is optional. Unsupported files remain available for ordinary analysis and listening. A failed or unavailable equivalence check does not create a quality preference.

## Validation result

The update passed 373 active unit tests with five skips on Windows and Linux Node 22.23.4. Windows type checking and production build passed. Lint reports two existing Fast Refresh export warnings and no errors.

The generated browser suite passed nine engine cases and the complete UI workflow. The built production page passed the same UI workflow. Development and production desktop/mobile smoke checks passed with no page/console errors, horizontal overflow, branding/auth warnings or baseline divergence. Screenshots were inspected.

The existing synthetic calibration remains at 35 pass, three fail, five expected fail and two unexpected pass. These outcomes match the earlier baseline. This update does not resolve that calibration work or claim listening-test validation.
