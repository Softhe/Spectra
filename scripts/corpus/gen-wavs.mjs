// Synthesizes corpus WAVs with node (no browser). Run: node scripts/corpus/gen-wavs.mjs
//
// Outputs (all deterministic, seeded; 16-bit stereo PCM):
//   wav/{bright,quiet,noisy,sweep}.wav      44.1 kHz, 8 s  (original corpus — byte-identical)
//   wav/{bright,quiet,noisy,sweep}-48k.wav  48 kHz,   8 s  (48 kHz grading calibration)
//   wav/bright-long.wav                     44.1 kHz, 40 s (quiet intro + fade-out, so the
//                                           >20 s loudness-ranked region picker matters)
import { mkdirSync, writeFileSync } from "node:fs";

const CORPUS_DIR = process.env.CORPUS_DIR || "/tmp/corpus";
mkdirSync(`${CORPUS_DIR}/wav`, { recursive: true });

// Envelope of bright-long (seconds). Mirrored in score-corpus.mjs (LONG_ENV):
// every region the >20 s picker keeps must lie in [LOUD_FROM, LOUD_TO].
const LONG = { sec: 40, introEnd: 6, loudFrom: 8, loudTo: 33, introGain: 0.03 };

function longGain(t) {
  if (t < LONG.introEnd) return LONG.introGain; // ≈ −30 dB quiet intro
  if (t < LONG.loudFrom) {
    const f = (t - LONG.introEnd) / (LONG.loudFrom - LONG.introEnd);
    return LONG.introGain + (1 - LONG.introGain) * f; // fade in
  }
  if (t < LONG.loudTo) return 1;
  return Math.max(0, 1 - (t - LONG.loudTo) / (LONG.sec - LONG.loudTo)); // fade out to silence
}

function render(kind, SR = 44100, SEC = 8, gainAt = null) {
  const N = SR * SEC;
  const L = new Float32Array(N), R = new Float32Array(N);
  let pink = 0, ph = 0;
  // Deterministic PRNG (mulberry32) so the corpus is reproducible.
  let seed = 0x12345678;
  const rnd = () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
      s += Math.sin(2 * Math.PI * 55 * beat) * Math.exp(-beat * 14) * 0.7;
      const hatT = t % 0.25;
      const w = rnd() * 2 - 1;
      s += w * Math.exp(-hatT * 28) * 0.3;
      pink = 0.97 * pink + 0.03 * w;
      s += pink * 0.04;
      if (kind === "noisy") s += pink * 0.35 + (rnd() * 2 - 1) * 0.02;
    } else if (kind === "quiet") {
      s += Math.sin(2 * Math.PI * 220 * t) * 0.16 + Math.sin(2 * Math.PI * 277.18 * t) * 0.11
        + Math.sin(2 * Math.PI * 329.63 * t) * 0.09 + Math.sin(2 * Math.PI * 440 * t) * 0.05;
      const pl = t % 2;
      s += Math.sin(2 * Math.PI * 880 * pl) * Math.exp(-pl * 6) * 0.12;
      spread = s * 0.08;
    } else if (kind === "sweep") {
      const step = Math.min(7, Math.floor(t / 1.0));
      const f = 2000 * Math.pow(2, step * 0.46);
      ph += f / SR;
      s += Math.sin(2 * Math.PI * ph) * 0.4;
      s += Math.sin(2 * Math.PI * 440 * t) * 0.05;
      spread = s * 0.05;
    }
    // Only the long variant is enveloped: the 8 s outputs keep the exact
    // original arithmetic (no multiply), so they stay byte-identical.
    if (gainAt) {
      const g = gainAt(t);
      s *= g; spread *= g;
    }
    L[i] = Math.max(-1, Math.min(1, s + spread));
    R[i] = Math.max(-1, Math.min(1, s - spread));
  }
  return { L, R, SR, N };
}

function wavBytes({ L, R, SR, N }) {
  const buf = Buffer.alloc(44 + N * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(N * 4, 40);
  let o = 44;
  for (let i = 0; i < N; i++) {
    buf.writeInt16LE(Math.max(-1, Math.min(1, L[i])) * 32767, o);
    buf.writeInt16LE(Math.max(-1, Math.min(1, R[i])) * 32767, o + 2);
    o += 4;
  }
  return buf;
}

const out = (name, sig) => {
  writeFileSync(`${CORPUS_DIR}/wav/${name}.wav`, wavBytes(sig));
  console.log("wrote", name, `sr=${sig.SR}`, `sec=${sig.N / sig.SR}`);
};

for (const kind of ["bright", "quiet", "noisy", "sweep"]) out(kind, render(kind));
for (const kind of ["bright", "quiet", "noisy", "sweep"]) out(`${kind}-48k`, render(kind, 48000));
out("bright-long", render("bright", 44100, LONG.sec, longGain));
