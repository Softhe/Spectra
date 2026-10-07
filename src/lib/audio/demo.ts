import { fft, hann } from "./fft";

const SR = 44100;
const SECONDS = 6.5;
const FFT = 4096;
// 50% Hann overlap: half the hops of the original 1024 at no audible
// difference for a demo low-pass (brickwall edge stays at full FFT resolution).
const HOP = 2048;
const WIN = hann(FFT);

function saw(phase: number): number {
  return 2 * (phase - Math.floor(phase)) - 1;
}

// Fixed-seed PRNG: the demo renders byte-identical files on every click, so
// the IndexedDB result cache makes repeat "Load a demo comparison" resolves
// instant instead of re-analyzing fresh random audio, and QA captures of the
// demo stay reproducible. Seeded per invocation, not shared module state, so
// overlapping renders never split one stream's output mid-sequence.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function env(t: number, attack: number, decay: number): number {
  if (t < 0) return 0;
  if (t < attack) return t / attack;
  return Math.exp(-(t - attack) * decay);
}

async function renderMaster(): Promise<{ left: Float32Array; right: Float32Array }> {
  const rand = mulberry32(0x5aba1e);
  const n = Math.floor(SR * SECONDS);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  let pink = 0;
  let phBass = 0;
  let ph1 = 0;
  let ph2 = 0;
  let ph3 = 0;
  let ph4 = 0;
  const inc = (hz: number) => hz / SR;

  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const beat = t % 0.5;
    const hatT = t % 0.25;
    const bar = t % 2;

    phBass += inc(55);
    ph1 += inc(220);
    ph2 += inc(277.18);
    ph3 += inc(329.63);
    ph4 += inc(440);

    const kick =
      Math.sin(2 * Math.PI * (52 + beat * 8) * beat) * env(beat, 0.004, 14) * 0.72;
    const bass = saw(phBass) * 0.2 * (0.65 + 0.35 * Math.sin(2 * Math.PI * 0.5 * t));
    const pad =
      (saw(ph1) * 0.11 + saw(ph2) * 0.09 + saw(ph3) * 0.08 + saw(ph4) * 0.06) *
      (0.55 + 0.45 * Math.sin(2 * Math.PI * 0.125 * t));

    const white = rand() * 2 - 1;
    pink = 0.97 * pink + 0.03 * white;
    const air = pink * 0.05;
    const hat = white * env(hatT, 0.001, 28) * (bar < 1 ? 0.38 : 0.22);
    const ride = white * env(t % 1, 0.002, 8) * 0.07;

    const mix = kick + bass + pad + hat + ride + air;
    const spread = pad * 0.15 + hat * 0.2;
    left[i] = Math.max(-1, Math.min(1, mix + spread));
    right[i] = Math.max(-1, Math.min(1, mix - spread));
    // Yield once per second of audio so the "Building demo" state can paint.
    if (i > 0 && i % SR === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return { left, right };
}

async function brickwallChannel(input: Float32Array, cutoffHz: number): Promise<Float32Array> {
  const n = input.length;
  const out = new Float32Array(n);
  const real = new Float32Array(FFT);
  const imag = new Float32Array(FFT);
  const acc = new Float32Array(n);
  const wsum = new Float32Array(n);
  const binHz = SR / FFT;
  const passBin = Math.floor((cutoffHz - 400) / binHz);
  const stopBin = Math.floor(cutoffHz / binHz);
  // Gain table is identical for every hop — build once, not per position.
  const gain = new Float32Array(FFT + 1);
  for (let k = passBin; k <= FFT - passBin; k++) {
    const dist = Math.min(k, FFT - k);
    if (dist < stopBin) {
      const t = (stopBin - dist) / Math.max(1, stopBin - passBin);
      gain[k] = t * t * (3 - 2 * t);
    }
  }

  for (let pos = 0, steps = 0; pos + FFT <= n; pos += HOP, steps++) {
    real.fill(0);
    imag.fill(0);
    for (let i = 0; i < FFT; i++) real[i] = input[pos + i]! * WIN[i]!;
    fft(real, imag, false);
    for (let k = passBin; k <= FFT - passBin; k++) {
      real[k]! *= gain[k]!;
      imag[k]! *= gain[k]!;
    }
    fft(real, imag, true);
    for (let i = 0; i < FFT; i++) {
      acc[pos + i]! += real[i]! * WIN[i]!;
      wsum[pos + i]! += WIN[i]! * WIN[i]!;
    }
    if (steps % 24 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  for (let i = 0; i < n; i++) {
    const d = wsum[i]!;
    out[i] = d > 1e-6 ? acc[i]! / d : 0;
  }
  return out;
}

function encodeWav(left: Float32Array, right: Float32Array): Blob {
  const n = left.length;
  const dataSize = n * 2 * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, SR, true);
  view.setUint32(28, SR * 2 * 2, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, left[i]!));
    const r = Math.max(-1, Math.min(1, right[i]!));
    view.setInt16(o, l * 32767, true);
    view.setInt16(o + 2, r * 32767, true);
    o += 4;
  }
  return new Blob([buf], { type: "audio/wav" });
}

export async function makeDemoFiles(): Promise<{ a: File; b: File }> {
  const master = await renderMaster();
  const [ripL, ripR] = await Promise.all([
    brickwallChannel(master.left, 16000),
    brickwallChannel(master.right, 16000),
  ]);
  const aBlob = encodeWav(master.left, master.right);
  const bBlob = encodeWav(ripL, ripR);
  const a = new File([aBlob], "demo-master.wav", { type: "audio/wav" });
  const b = new File([bBlob], "demo-128k-rip.wav", { type: "audio/wav" });
  return { a, b };
}
