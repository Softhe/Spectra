// Byte-fixture unit checks for sniffContainer. Run from the repo root:
//   node --experimental-strip-types --no-warnings --loader ./scripts/corpus/ts-resolve.mjs ./scripts/corpus/sniff-check.mjs
// The last case needs one genuine .m4a (see scripts/corpus/README section in
// the top-level README); it is skipped gracefully when absent.
import { sniffContainer } from "../../src/lib/audio/sniff.ts";
import { existsSync, readFileSync } from "node:fs";

const CORPUS_DIR = process.env.CORPUS_DIR || "/tmp/corpus";

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
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

// 8. Genuine FFmpeg M4A: timescale (not duration) as sample rate (regression
// for the mdhd+20 → duration bug, which resampled every short M4A).
{
  const m4a = `${CORPUS_DIR}/bright-aac-128.m4a`;
  if (!existsSync(m4a)) {
    console.log("skip real-m4a (build the corpus first; see README)");
  } else {
    const b = readFileSync(m4a);
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    const r = sniffContainer(ab, "bright-aac-128.m4a", "audio/mp4");
    eq("real-m4a", [r.codec, r.sampleRate, r.channels, r.vbr], ["AAC", 44100, 2, true]);
    eq("real-m4a-claimed-near128", r.claimedKbps >= 100 && r.claimedKbps <= 200, true);
  }
}

console.log(fails === 0 ? "ALL PASS" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
