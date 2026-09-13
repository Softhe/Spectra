// Decodes $CORPUS_DIR/enc/* via the browser (same decoder the app uses)
// and appends items to the corpus. Run from the repo root:
//   node scripts/corpus/static-server.mjs &  # serves decode.html + audio on :8099
//   node scripts/corpus/decode-dump.mjs
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const CORPUS_DIR = process.env.CORPUS_DIR || "/tmp/corpus";
const STATIC_URL = process.env.STATIC_URL || "http://127.0.0.1:8099";
const OUT = `${CORPUS_DIR}/items`;
mkdirSync(OUT, { recursive: true });

const files = readdirSync(`${CORPUS_DIR}/enc`).sort();
console.log("files:", files.length);

const b = await chromium.launch();
const p = await b.newPage();
await p.goto(`${STATIC_URL}/corpus/decode.html`);

const manifest = JSON.parse(readFileSync(`${CORPUS_DIR}/manifest.json`, "utf8"));
const seen = new Set(manifest.items.map((i) => i.name));
let added = 0;
for (const f of files) {
  const m = f.match(/^(.*?)-(aac|opus|mp3)-(\d+)(?:-to-(.*))?\.(m4a|ogg|mp3)$/) ||
    f.match(/^(.*?)-(aac64)-to-(wav)\.wav$/);
  let name, kind, kbps;
  if (f === "bright-aac64-to-wav.wav") {
    name = "bright-aac64-to-wav"; kind = "transcode"; kbps = null;
  } else if (f === "bright-mp3128-to-aac256.m4a") {
    name = f.replace(/\.m4a$/, ""); kind = "upconvert"; kbps = 256;
  } else if (m) {
    name = f.replace(/\.(m4a|ogg|mp3)$/, "");
    kind = m[2] === "mp3" ? "mp3" : m[2];
    kbps = parseInt(m[3], 10);
  } else {
    console.log("skip", f);
    continue;
  }
  if (seen.has(name)) {
    console.log("have", name);
    continue;
  }
  const r = await p.evaluate((path) => window.decodeOne(path), `/corpus-files/enc/${f}`);
  if (!r.ok) {
    console.log("DECODE-FAIL", name, r.error);
    continue;
  }
  const mono = Float32Array.from(r.mono);
  writeFileSync(`${OUT}/${name}.f32`, Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength));
  manifest.items.push({ name, kind, kbps, sr: r.sr, ch: r.ch, samples: mono.length });
  seen.add(name);
  added++;
  console.log("ok", name, "sr=" + r.sr, "ch=" + r.ch);
}
manifest.aacEncoder = "ffmpeg-7.0.2-native-aac";
writeFileSync(`${CORPUS_DIR}/manifest.json`, JSON.stringify(manifest, null, 1));
console.log(`added ${added} items`);
await b.close();
