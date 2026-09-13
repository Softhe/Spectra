// Synthesizes corpus WAVs with node (no browser). Run: node scripts/corpus/gen-wavs.mjs
import { mkdirSync, writeFileSync } from "node:fs";

const CORPUS_DIR = process.env.CORPUS_DIR || "/tmp/corpus";
const SR = 44100, SEC = 8, N = SR * SEC;
mkdirSync(`${CORPUS_DIR}/wav`, { recursive: true });

function render(kind) {
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
    L[i] = Math.max(-1, Math.min(1, s + spread));
    R[i] = Math.max(-1, Math.min(1, s - spread));
  }
  return { L, R };
}

function wavBytes(L, R) {
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

for (const kind of ["bright", "quiet", "noisy", "sweep"]) {
  const { L, R } = render(kind);
  writeFileSync(`${CORPUS_DIR}/wav/${kind}.wav`, wavBytes(L, R));
  console.log("wrote", kind);
}
