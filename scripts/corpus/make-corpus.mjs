// Builds the MP3 leg of the labeled corpus: synth signals -> MP3 (lamejs) /
// WAV refs / transcodes -> decoded mono f32 dumped to $CORPUS_DIR/items.
// Run from the repo root (needs the dev server on :8080):
//   npm install --prefix /tmp/corpus-tools lamejs   # one-time tool install
//   node scripts/corpus/make-corpus.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const CORPUS_DIR = process.env.CORPUS_DIR || "/tmp/corpus";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8080";
const LAMEJS_MIN_JS =
  process.env.LAMEJS_MIN_JS || "/tmp/corpus-tools/node_modules/lamejs/lame.min.js";
const OUT = `${CORPUS_DIR}/items`;
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();
const p = await b.newPage();
await p.goto(APP_URL, { waitUntil: "domcontentloaded" });
await p.addScriptTag({ path: LAMEJS_MIN_JS });
const hasLame = await p.evaluate(() => typeof window.lamejs !== "undefined");
console.log("lamejs:", hasLame);
const aacOk = await p.evaluate(async () => {
  if (typeof AudioEncoder === "undefined") return false;
  try {
    const r = await AudioEncoder.isConfigSupported({
      codec: "mp4a.40.2", sampleRate: 44100, numberOfChannels: 2, bitrate: 128_000,
    });
    return r.supported;
  } catch { return false; }
});
console.log("aac-encode:", aacOk);
if (!hasLame) throw new Error("lamejs failed to load");

// ---- synthesis + encode + decode, all in-page ----
const items = await p.evaluate(async (aacOk) => {
  const SR = 44100, SEC = 8, N = SR * SEC;
  const out = [];
  const push = (name, kind, L, R, meta = {}) => out.push({ name, kind, L: Array.from(L), R: Array.from(R), meta });

  function render(kind) {
    const L = new Float32Array(N), R = new Float32Array(N);
    let pink = 0, ph = 0;
    const harms = [110, 220, 330, 440, 660, 880, 1320, 1760, 2640, 3520, 5280, 7040, 10560, 14080, 17600];
    for (let i = 0; i < N; i++) {
      const t = i / SR;
      let s = 0, spread = 0;
      if (kind === "bright" || kind === "noisy") {
        for (let h = 0; h < harms.length; h++) {
          const a = 0.24 / (h + 1);
          s += Math.sin(2 * Math.PI * harms[h] * t + h) * a;
          spread += Math.sin(2 * Math.PI * harms[h] * t * 1.003) * a * 0.3;
        }
        const beat = t % 0.5;
        s += Math.sin(2 * Math.PI * 55 * beat) * Math.exp(-beat * 14) * 0.7; // kick
        const hatT = t % 0.25;
        const w = Math.random() * 2 - 1;
        s += w * Math.exp(-hatT * 28) * 0.3; // hat
        pink = 0.97 * pink + 0.03 * w;
        s += pink * 0.04;
        if (kind === "noisy") s += pink * 0.35 + (Math.random() * 2 - 1) * 0.02; // hiss bed
      } else if (kind === "quiet") {
        s += Math.sin(2 * Math.PI * 220 * t) * 0.16 + Math.sin(2 * Math.PI * 277.18 * t) * 0.11
          + Math.sin(2 * Math.PI * 329.63 * t) * 0.09 + Math.sin(2 * Math.PI * 440 * t) * 0.05;
        const pl = t % 2;
        s += Math.sin(2 * Math.PI * 880 * pl) * Math.exp(-pl * 6) * 0.12;
        spread = s * 0.08;
      } else if (kind === "sweep") {
        // Stepped sines, 1 s per step, 2 kHz → 19 kHz geometric: each band's
        // survival directly shows the encoder low-pass. Plus a quiet mid tone.
        const step = Math.min(7, Math.floor(t / 1.0));
        const f = 2000 * Math.pow(2, step * 0.46); // ≈2k … 18.9k
        ph += f / SR;
        s += Math.sin(2 * Math.PI * ph) * 0.4;
        s += Math.sin(2 * Math.PI * 440 * t) * 0.05; // mid reference tone
        spread = s * 0.05;
      }
      L[i] = Math.max(-1, Math.min(1, s + spread));
      R[i] = Math.max(-1, Math.min(1, s - spread));
    }
    return { L, R };
  }

  const f32ToI16 = (f) => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) o[i] = Math.max(-1, Math.min(1, f[i])) * 32767; return o; };
  const concat = (chunks, total) => { const o = new Uint8Array(total); let p = 0; for (const c of chunks) { o.set(c, p); p += c.length; } return o; };

  function mp3(L, R, kbps, mono = false) {
    const enc = mono
      ? new lamejs.Mp3Encoder(1, SR, kbps)
      : new lamejs.Mp3Encoder(2, SR, kbps);
    const l = f32ToI16(L), r = f32ToI16(R);
    const m = mono ? (() => { const o = new Int16Array(l.length); for (let i = 0; i < o.length; i++) o[i] = (l[i] + r[i]) / 2; return o; })() : null;
    const chunks = []; let total = 0;
    for (let i = 0; i < l.length; i += 1152) {
      const d = mono
        ? enc.encodeBuffer(m.subarray(i, i + 1152))
        : enc.encodeBuffer(l.subarray(i, i + 1152), r.subarray(i, i + 1152));
      if (d.length) { chunks.push(new Uint8Array(d.buffer, d.byteOffset, d.length)); total += d.length; }
    }
    const e = enc.flush();
    if (e.length) { chunks.push(new Uint8Array(e.buffer, e.byteOffset, e.length)); total += e.length; }
    return concat(chunks, total);
  }

  function adts(frameLen) {
    const h = new Uint8Array(7);
    h[0] = 0xFF; h[1] = 0xF1; h[2] = 0x50; // LC, 44.1k, top bits of ch=2
    h[3] = 0x80 | ((frameLen >> 11) & 3);
    h[4] = (frameLen >> 3) & 0xFF;
    h[5] = ((frameLen & 7) << 5) | 0x1F;
    h[6] = 0xFC;
    return h;
  }

  async function aac(L, R, bitrate) {
    const chunks = [];
    const enc = new AudioEncoder({ output: (c) => chunks.push(c), error: (e) => { throw e; } });
    enc.configure({ codec: "mp4a.40.2", sampleRate: SR, numberOfChannels: 2, bitrate });
    const FR = 1024;
    for (let i = 0, ts = 0; i < L.length; i += FR, ts += (FR / SR) * 1e6) {
      const n = Math.min(FR, L.length - i);
      const data = new Float32Array(n * 2);
      for (let j = 0; j < n; j++) { data[j] = L[i + j]; data[n + j] = R[i + j]; }
      enc.encode(new AudioData({ format: "f32-planar", sampleRate: SR, numberOfFrames: n, timestamp: Math.round(ts), data: data.buffer }));
    }
    await enc.flush();
    const parts = []; let total = 0;
    for (const c of chunks) {
      const sz = c.byteLength;
      const raw = new Uint8Array(sz);
      c.copyTo(raw);
      const h = adts(sz + 7);
      const frame = new Uint8Array(7 + sz);
      frame.set(h, 0); frame.set(raw, 7);
      parts.push(frame); total += frame.length;
      c.close();
    }
    enc.close();
    return concat(parts, total);
  }

  function wav(L, R) {
    const buf = new ArrayBuffer(44 + N * 4), v = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); v.setUint32(4, 36 + N * 4, true); ws(8, "WAVE"); ws(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * 4, true); v.setUint16(32, 4, true);
    v.setUint16(34, 16, true); ws(36, "data"); v.setUint32(40, N * 4, true);
    let o = 44;
    for (let i = 0; i < N; i++) {
      v.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 32767, true);
      v.setInt16(o + 2, Math.max(-1, Math.min(1, R[i])) * 32767, true);
      o += 4;
    }
    return new Uint8Array(buf);
  }

  async function decode(bytes, mime) {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    // Realtime AudioContext: decodeAudioData keeps the NATURAL sample rate
    // (OfflineAudioContext would resample and paint imaging above Nyquist).
    const ctx = new AudioContext();
    const audio = await ctx.decodeAudioData(ab);
    await ctx.close();
    const l = audio.getChannelData(0), r = audio.numberOfChannels > 1 ? audio.getChannelData(1) : l;
    const mono = new Float32Array(l.length);
    for (let i = 0; i < mono.length; i++) mono[i] = (l[i] + r[i]) / 2;
    return { mono: Array.from(mono), sr: audio.sampleRate, ch: audio.numberOfChannels };
  }

  const mp3Rates = [96, 128, 192, 320];
  const aacRates = aacOk ? [64, 128, 256] : [];
  for (const kind of ["bright", "quiet", "noisy", "sweep"]) {
    const { L, R } = render(kind);
    push(`${kind}-ref`, "wav", L, R);
    const wbytes = wav(L, R);
    for (const kbps of mp3Rates) {
      const d = await decode(mp3(L, R, kbps), "audio/mpeg");
      out.push({ name: `${kind}-mp3-${kbps}`, kind: "mp3", kbps, ...d });
    }
    // Mono 64k: starved-but-valid low anchor (stereo 64k is encoder garbage).
    {
      const d = await decode(mp3(L, R, 64, true), "audio/mpeg");
      out.push({ name: `${kind}-mp3-64m`, kind: "mp3", kbps: 64, ...d });
    }
    for (const br of aacRates) {
      const d = await decode(await aac(L, R, br * 1000), "audio/aac");
      out.push({ name: `${kind}-aac-${br}`, kind: "aac", kbps: br, ...d });
    }
    if (kind === "bright") {
      // transcodes: lossy content in lossless clothing + upconverted MP3.
      // NOTE: stereo 64k from lamejs is digital silence (encoder quirk), so
      // the transcode source is the valid mono 64k decode, dual-mono'd.
      const m64 = await decode(mp3(L, R, 64, true), "audio/mpeg");
      out.push({ name: "bright-mp364-to-wav", kind: "transcode", ...m64 });
      const m128bytes = mp3(L, R, 128);
      const tmpCtx = new AudioContext();
      const tmp = await tmpCtx.decodeAudioData(m128bytes.buffer.slice(m128bytes.byteOffset, m128bytes.byteOffset + m128bytes.byteLength));
      await tmpCtx.close();
      const tl = tmp.getChannelData(0), tr = tmp.getChannelData(1);
      const d = await decode(mp3(tl, tr, 320), "audio/mpeg");
      out.push({ name: "bright-mp3128-to-mp3320", kind: "upconvert", ...d });
    }
  }
  return { items: out, aacOk };
}, aacOk);

// ---- write bins + manifest ----
import("node:fs").then(({ writeFileSync }) => {
  const manifest = [];
  for (const it of items.items) {
    let mono;
    if (it.mono) {
      mono = Float32Array.from(it.mono);
    } else {
      // WAV refs carry L/R arrays; mix to mono, sr is 44100 by construction.
      const L = Float32Array.from(it.L), R = Float32Array.from(it.R);
      mono = new Float32Array(L.length);
      for (let i = 0; i < mono.length; i++) mono[i] = (L[i] + R[i]) / 2;
      it.sr = 44100; it.ch = 2; it.kbps = null;
    }
    const buf = Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength);
    writeFileSync(`${OUT}/${it.name}.f32`, buf);
    manifest.push({ name: it.name, kind: it.kind, kbps: it.kbps ?? null, sr: it.sr, ch: it.ch, samples: mono.length });
  }
  writeFileSync(`${CORPUS_DIR}/manifest.json`, JSON.stringify({ aacOk: items.aacOk, items: manifest }, null, 1));
  console.log(`wrote ${manifest.length} items, aac=${items.aacOk}`);
});
await b.close();
