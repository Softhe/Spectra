#!/bin/sh
# Encode the AAC/Opus/transcode leg of the labeled corpus with native FFmpeg.
# Usage: FF=/path/to/ffmpeg CORPUS_DIR=/tmp/corpus [LITE=1] sh scripts/corpus/encode.sh
# (defaults: ffmpeg from $PATH, CORPUS_DIR=/tmp/corpus, LITE unset)
# Needs: aac, libopus, libmp3lame, alac, pcm_s16le encoders (FFmpeg 7.x static
# builds have all of them; the Playwright-bundled ffmpeg is video-only).
set -eu
FF="${FF:-ffmpeg}"
CORPUS_DIR="${CORPUS_DIR:-/tmp/corpus}"
mkdir -p "$CORPUS_DIR/enc"
ff() { "$FF" -hide_banner -loglevel error -y "$@"; }

# ---- original 44.1 kHz / 8 s leg (unchanged) ----
for kind in bright quiet noisy sweep; do
  for br in 64 128 256; do
    ff -i "$CORPUS_DIR/wav/$kind.wav" \
      -c:a aac -b:a "${br}k" -ar 44100 -ac 2 "$CORPUS_DIR/enc/${kind}-aac-${br}.m4a"
  done
  for br in 64 96 128; do
    ff -i "$CORPUS_DIR/wav/$kind.wav" \
      -c:a libopus -b:a "${br}k" "$CORPUS_DIR/enc/${kind}-opus-${br}.ogg"
  done
done

# Transcode fixtures: lossy content in lossless clothing…
ff -i "$CORPUS_DIR/enc/bright-aac-64.m4a" \
  -c:a pcm_s16le "$CORPUS_DIR/enc/bright-aac64-to-wav.wav"
# …and a cross-codec upconvert (MP3-128 re-encoded as AAC-256).
ff -i "$CORPUS_DIR/wav/bright.wav" \
  -c:a libmp3lame -b:a 128k "$CORPUS_DIR/enc/bright-mp3-128.mp3"
ff -i "$CORPUS_DIR/enc/bright-mp3-128.mp3" \
  -c:a aac -b:a 256k -ar 44100 -ac 2 "$CORPUS_DIR/enc/bright-mp3128-to-aac256.m4a"

# ---- 48 kHz leg: same signals, same bitrates, native 48 kHz source ----
# Each item has a 44.1 kHz counterpart (strip "-48k") that must get the same
# quality class (score-corpus EXPECT same-class-48k).
for kind in bright quiet noisy sweep; do
  cp "$CORPUS_DIR/wav/$kind-48k.wav" "$CORPUS_DIR/enc/${kind}-48k-ref.wav"
  for br in 64 128 256; do
    ff -i "$CORPUS_DIR/wav/$kind-48k.wav" \
      -c:a aac -b:a "${br}k" -ar 48000 -ac 2 "$CORPUS_DIR/enc/${kind}-48k-aac-${br}.m4a"
  done
  for br in 64 96 128; do
    ff -i "$CORPUS_DIR/wav/$kind-48k.wav" \
      -c:a libopus -b:a "${br}k" "$CORPUS_DIR/enc/${kind}-48k-opus-${br}.ogg"
  done
  # NOTE: the 44.1 kHz MP3 counterparts come from lamejs (make-corpus.mjs);
  # these are libmp3lame. Both are LAME with default lowpass tables.
  for br in 128 320; do
    ff -i "$CORPUS_DIR/wav/$kind-48k.wav" \
      -c:a libmp3lame -b:a "${br}k" -ar 48000 "$CORPUS_DIR/enc/${kind}-48k-mp3-${br}.mp3"
  done
done
# 48 kHz ALAC, moov at end (no +faststart): the sniffer must report 48000,
# not a 44100 default.
ff -i "$CORPUS_DIR/wav/bright-48k.wav" -c:a alac "$CORPUS_DIR/enc/bright-48k-alac.m4a"

# ---- long leg: 40 s with quiet intro + fade-out (loudness-ranked regions) ----
# Deliberately WITHOUT -movflags +faststart: FFmpeg's default writes `moov`
# after `mdat`, i.e. beyond the sniffer's first-512 KB window for these sizes.
cp "$CORPUS_DIR/wav/bright-long.wav" "$CORPUS_DIR/enc/bright-long-ref.wav"
ff -i "$CORPUS_DIR/wav/bright-long.wav" \
  -c:a aac -b:a 256k -ar 44100 -ac 2 "$CORPUS_DIR/enc/bright-long-aac-256.m4a"
ff -i "$CORPUS_DIR/wav/bright-long.wav" -c:a alac "$CORPUS_DIR/enc/bright-long-alac.m4a"

# ---- optional Lite leg (>15 min → analyze.ts liteAnalysis path) ----
# 16 min of bright-long looped, AAC-256, moov at end (~30 MB encoded,
# ~170 MB decoded f32). Opt-in because of size: LITE=1.
if [ "${LITE:-}" = "1" ]; then
  ff -stream_loop -1 -i "$CORPUS_DIR/wav/bright-long.wav" -t 960 \
    -c:a aac -b:a 256k -ar 44100 -ac 2 "$CORPUS_DIR/enc/bright-lite-aac-256.m4a"
fi

echo "encoded $(ls "$CORPUS_DIR/enc" | wc -l) files into $CORPUS_DIR/enc"
