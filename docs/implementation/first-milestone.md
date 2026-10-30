# First implementation milestone

Status: Local candidate, uncommitted. No production deployment.

## Delivered

- Two upload slots initially, with optional third/fourth copies. Two-file comparisons no longer show a redundant leaderboard.
- A relative preference or inconclusive result leads the page. Experimental scores live in technical details; slot headings no longer present a quality percentage.
- Structured outcomes and reason codes distinguish a preference, insufficient separation and non-comparable recordings. Unknown or uncertain identity withholds the preference.
- Actual metadata is separated from spectral estimates. Removed True class, exact-bitrate implications and categorical lossless-provenance language.
- Shared passages are measured for equal-duration copies too. A comparison carries a common measurement key, measured seconds, overlap seconds and window count. Missing or incompatible shared measurements withhold a quality preference instead of mixing refined/base results.
- Ineligible pairs earn no ranking points. Refined values and decisions are shared by the result panel, badges, table and copied report.
- Alignment/playback survives refinement failure. Cancellation and stale-generation checks also cover effect cleanup.
- Removed exact-file-identity claims based on sampled cache hashes or filename/size. Full identity verification remains future work.
- Blind mode clears OS/browser media metadata and uses anonymous clip titles. Coverage/progress details are hidden, and preference styling disappears immediately without a transition clue.
- RF64 reads ds64 data lengths with safe integer checks. A virtual 5 GiB test and a small FFmpeg RF64 file validate the fix. Unsupported extra sentinel-sized chunks are rejected.
- A native Node test runner replaces POSIX shell syntax. Windows command-bin resolution works without a command shell. Smoke outputs stay within the project directory.
- The browser corpus generator is seeded and records generator version, seed, Node/browser versions and lamejs asset hash.
- The opt-in private-playlist runner validates a dedicated test root, rejects escaping paths, limits workload, runs sequentially, checks input hashes and checkpoints results. It does not discover a music library or convert files in place.

## Verification

- Windows Node 24: 365 tests passed, five skipped, zero failed.
- CodeOne Linux Node 24 and Node 22.23.4: the same active unit suites passed. Temporary code-only workspaces were removed afterward. No private audio was transferred.
- Windows type checking and production build passed. Lint has no errors and two pre-existing Fast Refresh export warnings.
- Development and built-output desktop/mobile smoke passed with no console/page errors, overflow, branding warnings, auth mismatch or baseline divergence. Screenshots were inspected.
- Actual copied files were uploaded through the UI on development and production. Slot expansion, shared coverage, preferences, collapsed technical details, swap labels, copied report, blind/reveal and anonymous media metadata passed assertions.
- A revoked object URL simulated a real refinement input failure. The application comparison returned no preference.
- The private 18-case audio set retained the expected pattern: four preferences and two inconclusive results for both the six cross-service and six controlled 128 kbps pairs; duplicate/equivalent/container controls remained neutral; the trim aligned correctly; unrelated tracks were rejected. All assertions in the bounded runner passed.
- The RF64 5 GiB regression passes. The real small RF64 fixture reports 44,100 frames for one second at 44.1 kHz stereo PCM16.

The synthetic corpus was rescored using the existing generated inputs. It still reports 35 pass, three fail, five expected fail and two unexpected pass, matching the earlier baseline. This gate is unresolved. The new seeded generator has not yet received a fully regenerated, reviewed calibration baseline. No detector thresholds or expected-gap entries were changed to conceal these results.

## Limits and next work

This milestone implements the first delivery's foundation, interpretation and minimum shared-comparison handling. It does not complete the full roadmap.

- The matcher remains envelope-based. Spectral fingerprint evaluation, local alignment consistency and drift/edit handling remain to be implemented and validated.
- Evidence categories remain heuristic. Per-window consistency, broader negative controls and a recording-level held-out benchmark are still needed before stronger confidence claims.
- No new universal quality model, master identifier, provenance certification, ABX statistics, dropout detector or channel-damage classifier was introduced.
- No full-byte or full-decoded-audio identity confirmation is exposed. Neutral measurements must not be relabeled as proven equivalence.
- The playlist runner consumes prepared copied inputs. Archive selection and controlled-derivative generation remain separate opt-in preparation steps.
- Chromium UI checks do not qualify Firefox/Safari or establish listening preference/audibility.
- Re-measuring equal-length files performs extra work. It is sequential in the low-memory queue; reuse based on recorded matching region layouts is a future optimization.

The next milestone should establish a reproducible seeded calibration baseline and evaluate stronger recording matching on held-out positive/negative pairs before changing score calibration.
