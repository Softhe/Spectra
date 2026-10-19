// Byte-fixture unit checks for sniffContainer. Run from the repo root:
//   node --experimental-strip-types --no-warnings --loader ./scripts/corpus/ts-resolve.mjs ./scripts/corpus/sniff-check.mjs
// Cases 8+ need genuine encodes in $CORPUS_DIR/enc (scripts/corpus/README.md,
// step 2b); each is skipped gracefully when its file is absent.
import { sniffContainer } from "../../src/lib/audio/sniff.ts";
import { existsSync, readFileSync } from "node:fs";

const CORPUS_DIR = process.env.CORPUS_DIR || "/tmp/corpus";

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
const u8 = (arr) => new Uint8Array(arr).buffer;

// 1. MP3 CBR 128, no Xing -> claimed 128, vbr unknown(null)
{
  const b = new Uint8Array(4200);
  b.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 0); // ID3, size 0
  b.set([0xff, 0xfb, 0x90, 0x64], 10); // MPEG1 L3, 128k, 44.1k, joint stereo
  const r = sniffContainer(u8(b), "song.mp3", "audio/mpeg");
  eq("mp3-cbr", [r.codec, r.claimedKbps, r.vbr, r.sampleRate, r.channels], ["MP3", 128, null, 44100, 2]);
}
// 2. MP3 with Xing in first frame -> VBR, claimed unknown (NOT first-frame 32k placeholder)
{
  const b = new Uint8Array(4200);
  b.set([0xff, 0xfb, 0x20, 0x64], 0); // bitrate idx 2 = 32k placeholder
  b.set([0x58, 0x69, 0x6e, 0x67], 100); // "Xing"
  const r = sniffContainer(u8(b), "vbr.mp3", "audio/mpeg");
  eq("mp3-vbr", [r.codec, r.claimedKbps, r.vbr], ["MP3", null, true]);
}
// 3. MP3 with "Xing" ONLY deep in audio bytes -> must NOT false-positive
{
  const b = new Uint8Array(9000);
  b.set([0xff, 0xfb, 0x90, 0x64], 0);
  b.set([0x58, 0x69, 0x6e, 0x67], 8000);
  const r = sniffContainer(u8(b), "cbr.mp3", "audio/mpeg");
  eq("mp3-no-false-xing", [r.claimedKbps, r.vbr], [128, null]);
}
// 4. MP4 esds: max 256000 then avg 128000 -> claimed must be the AVG (128)
{
  const b = new Uint8Array(256);
  b.set([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20], 0); // ftyp M4A
  const e = 64;
  b.set([0x65, 0x73, 0x64, 0x73], e); // "esds"
  const w32 = (v, o) => { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };
  w32(256000, e + 12);
  w32(128000, e + 16);
  const r = sniffContainer(u8(b), "song.m4a", "audio/mp4");
  eq("mp4-esds-avg", [r.codec, r.claimedKbps], ["AAC", 128]);
}
// 5. Tagged FLAC (ID3 prefix) -> parses streaminfo with shifted offsets
{
  const b = new Uint8Array(64);
  b.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05], 0); // ID3 size 5
  b.set([0xaa, 0xbb, 0xcc, 0xdd, 0xee], 10);
  const base = 15;
  b.set([0x66, 0x4c, 0x61, 0x43], base); // fLaC
  b.set([0x10, 0x00, 0x00, 0x22], base + 4); // STREAMINFO last, len 34
  b[base + 18] = 0x0a; b[base + 19] = 0xc4; b[base + 20] = 0x42; b[base + 21] = 0xf0; // 44100, 2ch, 16-bit
  const r = sniffContainer(u8(b), "tagged.flac", "audio/flac");
  eq("flac-tagged", [r.codec, r.sampleRate, r.channels, r.bitDepth], ["FLAC", 44100, 2, 16]);
}
// 6. Ogg Vorbis ident packet -> channels + rate from packet layout
{
  const b = new Uint8Array(128);
  b.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
  const i = 28;
  b.set([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0, 0, 0, 0, 2, 0x44, 0xac, 0, 0], i);
  const r = sniffContainer(u8(b), "song.ogg", "audio/ogg");
  eq("ogg-vorbis", [r.codec, r.sampleRate, r.channels], ["Vorbis", 44100, 2]);
}
// 7. Plain WAV still fine (regression)
{
  const b = new Uint8Array(64);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  ws(0, "RIFF"); ws(8, "WAVE"); ws(12, "fmt ");
  const v = new DataView(b.buffer);
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, 48000, true); v.setUint32(28, 48000 * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  const r = sniffContainer(u8(b), "song.wav", "audio/wav");
  eq("wav", [r.codec, r.sampleRate, r.channels, r.claimedKbps], ["PCM", 48000, 2, 1536]);
}

// ---- Genuine FFmpeg encodes from $CORPUS_DIR/enc (encode.sh) ----
// Each case is skipped gracefully when the file is absent.
const SNIFF_WINDOW = 512 * 1024; // sniffContainer's head window
const encPath = (f) => [`${CORPUS_DIR}/enc/${f}`, `${CORPUS_DIR}/${f}`].find(existsSync);
const loadEnc = (f) => {
  const path = encPath(f);
  if (!path) return null;
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
/** Top-level MP4 boxes -> { type: offset } (first occurrence). */
const topBoxes = (ab) => {
  const v = new DataView(ab), out = {};
  for (let o = 0; o + 8 <= ab.byteLength;) {
    let n = v.getUint32(o);
    const t = String.fromCharCode(v.getUint8(o + 4), v.getUint8(o + 5), v.getUint8(o + 6), v.getUint8(o + 7));
    if (n === 1) n = Number(v.getBigUint64(o + 8));
    if (!(t in out)) out[t] = o;
    if (n < 8) break;
    o += n;
  }
  return out;
};
const withEnc = (label, f, fn) => {
  const ab = loadEnc(f);
  if (!ab) { console.log(`skip ${label} (${f} absent; build the corpus first, see scripts/corpus/README.md)`); return; }
  fn(ab);
};
// Fixture precondition: the file really has moov after mdat, past the
// sniff window (FFmpeg default without +faststart). Without this the case
// would silently test the easy layout.
const moovAtEnd = (label, ab) => {
  const bx = topBoxes(ab);
  eq(`${label}-precondition-moov-after-mdat-beyond-512k`,
    bx.moov > bx.mdat && bx.moov >= SNIFF_WINDOW, true);
};

// 8. Genuine FFmpeg M4A: timescale (not duration) as sample rate (regression
// for the mdhd+20 → duration bug, which resampled every short M4A).
// (Previously looked in $CORPUS_DIR/ instead of $CORPUS_DIR/enc/, so it
// always skipped; encPath now checks enc/ first.)
withEnc("real-m4a", "bright-aac-128.m4a", (ab) => {
  const r = sniffContainer(ab, "bright-aac-128.m4a", "audio/mp4");
  eq("real-m4a", [r.codec, r.sampleRate, r.channels, r.vbr], ["AAC", 44100, 2, true]);
  eq("real-m4a-claimed-near128", r.claimedKbps >= 100 && r.claimedKbps <= 200, true);
});
// 9. 48 kHz AAC (short, moov at end but inside the window): real rate.
withEnc("real-m4a-48k", "bright-48k-aac-128.m4a", (ab) => {
  const r = sniffContainer(ab, "bright-48k-aac-128.m4a", "audio/mp4");
  eq("real-m4a-48k", [r.codec, r.sampleRate, r.channels], ["AAC", 48000, 2]);
});
// 10. Long AAC-256, moov at end beyond 512 KB: sample rate must still be sniffed.
withEnc("long-aac-moov-end", "bright-long-aac-256.m4a", (ab) => {
  moovAtEnd("long-aac-moov-end", ab);
  const r = sniffContainer(ab, "bright-long-aac-256.m4a", "audio/mp4");
  eq("long-aac-moov-end", [r.codec, r.sampleRate, r.channels], ["AAC", 44100, 2]);
});
// 11. ALAC, moov at end beyond 512 KB: codec ALAC + real rate (44.1k and 48k,
// so a 44100 default can't pass both) + the cookie's real bit depth (16).
for (const [f, sr] of [["bright-long-alac.m4a", 44100], ["bright-48k-alac.m4a", 48000]]) {
  const label = f.replace(/\.m4a$/, "");
  withEnc(label, f, (ab) => {
    moovAtEnd(label, ab);
    const r = sniffContainer(ab, f, "audio/mp4");
    eq(label, [r.codec, r.sampleRate, r.channels], ["ALAC", sr, 2]);
    eq(`${label}-bitdepth`, r.bitDepth, 16);
  });
}
// 12. 48 kHz Opus (Ogg): always reports 48000 (Opus's fixed decode rate).
withEnc("real-opus-48k", "bright-48k-opus-128.ogg", (ab) => {
  const r = sniffContainer(ab, "bright-48k-opus-128.ogg", "audio/ogg");
  eq("real-opus-48k", [r.codec, r.sampleRate, r.channels], ["Opus", 48000, 2]);
});
// 13. Optional Lite leg (LITE=1): 16 min AAC, moov ~30 MB in.
withEnc("lite-aac-moov-end", "bright-lite-aac-256.m4a", (ab) => {
  moovAtEnd("lite-aac-moov-end", ab);
  const r = sniffContainer(ab, "bright-lite-aac-256.m4a", "audio/mp4");
  eq("lite-aac-moov-end", [r.codec, r.sampleRate, r.channels], ["AAC", 44100, 2]);
});

console.log(fails === 0 ? "ALL PASS" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
