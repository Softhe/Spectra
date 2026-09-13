#!/bin/sh
# Encode the AAC/Opus/transcode leg of the labeled corpus with native FFmpeg.
# Usage: FF=/path/to/ffmpeg CORPUS_DIR=/tmp/corpus sh scripts/corpus/encode.sh
# (defaults: ffmpeg from $PATH, CORPUS_DIR=/tmp/corpus)
set -eu
FF="${FF:-ffmpeg}"
CORPUS_DIR="${CORPUS_DIR:-/tmp/corpus}"
mkdir -p "$CORPUS_DIR/enc"

for kind in bright quiet noisy sweep; do
  for br in 64 128 256; do
    "$FF" -hide_banner -loglevel error -y -i "$CORPUS_DIR/wav/$kind.wav" \
      -c:a aac -b:a "${br}k" -ar 44100 -ac 2 "$CORPUS_DIR/enc/${kind}-aac-${br}.m4a"
  done
  for br in 64 96 128; do
    "$FF" -hide_banner -loglevel error -y -i "$CORPUS_DIR/wav/$kind.wav" \
      -c:a libopus -b:a "${br}k" "$CORPUS_DIR/enc/${kind}-opus-${br}.ogg"
  done
done

# Transcode fixtures: lossy content in lossless clothing…
"$FF" -hide_banner -loglevel error -y -i "$CORPUS_DIR/enc/bright-aac-64.m4a" \
  -c:a pcm_s16le "$CORPUS_DIR/enc/bright-aac64-to-wav.wav"
# …and a cross-codec upconvert (MP3-128 re-encoded as AAC-256).
"$FF" -hide_banner -loglevel error -y -i "$CORPUS_DIR/wav/bright.wav" \
  -c:a libmp3lame -b:a 128k "$CORPUS_DIR/enc/bright-mp3-128.mp3"
"$FF" -hide_banner -loglevel error -y -i "$CORPUS_DIR/enc/bright-mp3-128.mp3" \
  -c:a aac -b:a 256k -ar 44100 -ac 2 "$CORPUS_DIR/enc/bright-mp3128-to-aac256.m4a"

echo "encoded $(ls "$CORPUS_DIR/enc" | wc -l) files into $CORPUS_DIR/enc"
