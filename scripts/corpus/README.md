# Audio quality corpus

Labeled test data for the detection engine in `src/lib/audio/analyze.ts`.
Four synthesized signals (bright / quiet / noisy / stepped-sine sweep) are
encoded at known bitrates; the scorer runs the app's **real** detection
functions against the decoded PCM and prints a confusion matrix plus the
A/B verdicts the app must get right.

`manifest.json` is a committed snapshot of the corpus composition. The audio
itself (tens of MB of derived files) lives in `$CORPUS_DIR` (default
`/tmp/corpus`) and is regenerable with the recipe below.

## Recipe

```sh
# 0. Tools (one time): playwright browsers, lamejs, a native FFmpeg 7+
npx playwright install chromium
npm install --prefix /tmp/corpus-tools lamejs

# 1. Synthesize the 4 reference WAVs (deterministic, seeded)
node scripts/corpus/gen-wavs.mjs

# 2a. MP3 leg via lamejs in the browser (needs the dev server on :8080)
node scripts/corpus/make-corpus.mjs

# 2b. AAC/Opus/transcode leg via native FFmpeg
sh scripts/corpus/encode.sh

# 3. Decode everything with the browser's own decoder into .f32 mono
node scripts/corpus/static-server.mjs &   # serves decode.html + audio on :8099
node scripts/corpus/decode-dump.mjs

# 4. Score: cutoff / rolloff / class / score per item + key verdicts
node --experimental-strip-types --no-warnings \
  --loader ./scripts/corpus/ts-resolve.mjs ./scripts/corpus/score-corpus.mjs

# 5. Header-parser fixtures (needs one genuine .m4a from step 2b)
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
