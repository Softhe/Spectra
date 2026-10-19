// Decodes $CORPUS_DIR/enc/* via the browser (same decoder the app uses)
// and appends items to the corpus. Run from the repo root:
//   node scripts/corpus/static-server.mjs &  # serves decode.html + audio on :8099
//   node scripts/corpus/decode-dump.mjs
// FF=/path/to/ffmpeg enables a fallback for files the browser cannot decode
// at all (ALAC: neither Chromium nor Firefox decodeAudioData supports it).
// Such items are tagged decoder:"ffmpeg" in the manifest — they test the
// detector on the true PCM, NOT the app's decode path (which fails on them).
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, writeSync } from "node:fs";
import { chromium } from "playwright";

const CORPUS_DIR = process.env.CORPUS_DIR || "/tmp/corpus";
const STATIC_URL = process.env.STATIC_URL || "http://127.0.0.1:8099";
const OUT = `${CORPUS_DIR}/items`;
const CHUNK = 1 << 20; // samples per base64 transfer
const FF = process.env.FF || "";

/** Lossless-only fallback: decode with FFmpeg to interleaved stereo f32le, mix (L+R)/2. */
function ffDecode(path, rate) {
  const raw = execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-i", path,
    "-f", "f32le", "-ac", "2", "-ar", String(rate), "-"], { maxBuffer: 1 << 30 });
  const st = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const mono = new Float32Array(st.length / 2);
  for (let i = 0; i < mono.length; i++) mono[i] = (st[2 * i] + st[2 * i + 1]) / 2;
  return mono;
}
mkdirSync(OUT, { recursive: true });

const files = readdirSync(`${CORPUS_DIR}/enc`).sort();
console.log("files:", files.length);

/** File name -> manifest labels, or null to skip. */
function classify(f) {
  if (f === "bright-aac64-to-wav.wav") return { name: "bright-aac64-to-wav", kind: "transcode", kbps: null };
  if (f === "bright-mp3128-to-aac256.m4a") return { name: "bright-mp3128-to-aac256", kind: "upconvert", kbps: 256 };
  let m = f.match(/^(.*)-ref\.wav$/); // 48k / long PCM references
  if (m) return { name: `${m[1]}-ref`, kind: "wav", kbps: null };
  m = f.match(/^(.*)-alac\.m4a$/);
  if (m) return { name: `${m[1]}-alac`, kind: "alac", kbps: null };
  m = f.match(/^(.*?)-(aac|opus|mp3)-(\d+)\.(m4a|ogg|mp3)$/);
  if (m) return { name: f.replace(/\.(m4a|ogg|mp3)$/, ""), kind: m[2], kbps: parseInt(m[3], 10) };
  return null;
}

const b = await chromium.launch();
const p = await b.newPage();
await p.goto(`${STATIC_URL}/corpus/decode.html`);

const manifest = JSON.parse(readFileSync(`${CORPUS_DIR}/manifest.json`, "utf8"));
const seen = new Set(manifest.items.map((i) => i.name));
let added = 0;
for (const f of files) {
  const c = classify(f);
  if (!c) {
    console.log("skip", f);
    continue;
  }
  const { name, kind, kbps } = c;
  if (seen.has(name)) {
    console.log("have", name);
    continue;
  }
  // Decode rate: the corpus's own sample-rate label. Original items were
  // decoded at 44.1 kHz (incl. Opus, whose sniffed rate is 48 kHz — the app
  // would decode those at 48 kHz; kept as-is so old results stay comparable).
  const rate = name.includes("-48k") ? 48000 : 44100;
  const r = await p.evaluate(([path, rt]) => window.decodeOne(path, rt), [`/corpus-files/enc/${f}`, rate]);
  if (!r.ok) {
    console.log("DECODE-FAIL", name, r.error);
    if (!FF || kind !== "alac") continue;
    const mono = ffDecode(`${CORPUS_DIR}/enc/${f}`, rate);
    writeFileSync(`${OUT}/${name}.f32`, Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength));
    manifest.items.push({ name, kind, kbps, sr: rate, ch: 2, samples: mono.length, decoder: "ffmpeg" });
    seen.add(name);
    added++;
    console.log("ok (ffmpeg fallback)", name, "sr=" + rate, "samples=" + mono.length);
    continue;
  }
  const fd = openSync(`${OUT}/${name}.f32`, "w");
  for (let s = 0; s < r.samples; s += CHUNK) {
    const b64 = await p.evaluate(([st, n]) => window.chunkB64(st, n), [s, CHUNK]);
    writeSync(fd, Buffer.from(b64, "base64"));
  }
  closeSync(fd);
  manifest.items.push({ name, kind, kbps, sr: r.sr, ch: r.ch, samples: r.samples });
  seen.add(name);
  added++;
  console.log("ok", name, "sr=" + r.sr, "ch=" + r.ch, "samples=" + r.samples);
}
manifest.aacEncoder = "ffmpeg-7.0.2-native-aac";
writeFileSync(`${CORPUS_DIR}/manifest.json`, JSON.stringify(manifest, null, 1));
console.log(`added ${added} items`);
await b.close();
