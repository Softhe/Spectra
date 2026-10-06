import { fft, hann } from "./fft";
import { sniffContainer } from "./sniff";
import { cacheGet, cacheKeyForFile, cachePut } from "./cache";
import { runDspParallel } from "./dsp-client";
import type {
  Analysis,
  Comparison,
  QualityClass,
  RolloffKind,
  ScoreParts,
  SlotId,
  SpectrogramData,
} from "./types";

const FFT_SIZE = 4096;
const HOP = 2048;
const EPS = 1e-12;
const DISPLAY_BINS = 512;
const DISPLAY_MAX_HZ = 22050;

const hannWindow = hann(FFT_SIZE);
let windowSumSq = 0;
for (let i = 0; i < FFT_SIZE; i++) windowSumSq += hannWindow[i]! * hannWindow[i]!;

function yieldToMain(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Thrown when an analysis is superseded or its slot is cleared. */
export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}

type MonoStats = {
  mono: Float32Array;
  peakDb: number;
  rmsDb: number;
  crestDb: number;
  clipFraction: number;
};

/**
 * Mix down to mono while measuring peak/RMS/clipping in the same pass.
 * Chunked with yields so a full-length song doesn't freeze the tab
 * (previously two separate synchronous passes over the whole buffer).
 */
async function mixDownWithStats(
  buffer: AudioBuffer,
  materialize = true,
  signal?: AbortSignal,
): Promise<MonoStats> {
  const n = buffer.length;
  const ch = buffer.numberOfChannels;
  const mono = materialize ? new Float32Array(n) : new Float32Array(0);
  let peak = 0;
  let sumSq = 0;
  const CHUNK = 1 << 20;

  // Sustained clipping only: runs of ≥16 consecutive samples at ≥0.999.
  // Isolated lossy-decoder overshoots (1–3 samples) never form runs, so the
  // codec stops being punished for its own reconstruction overshoot.
  // `run` carries across chunk boundaries by construction.
  let run = 0;
  let clipRun = 0;
  const tally = (v: number, i: number) => {
    if (materialize) mono[i] = v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sumSq += v * v;
    if (a >= 0.999) {
      run++;
    } else {
      if (run >= 16) clipRun += run;
      run = 0;
    }
  };

  if (ch === 1) {
    const data = buffer.getChannelData(0);
    for (let s = 0; s < n; s += CHUNK) {
      const end = Math.min(n, s + CHUNK);
      for (let i = s; i < end; i++) tally(data[i]!, i);
      if (end < n) {
        await yieldToMain();
        throwIfAborted(signal);
      }
    }
  } else {
    const channels: Float32Array[] = [];
    for (let c = 0; c < ch; c++) channels.push(buffer.getChannelData(c));
    const scale = 1 / ch;
    for (let s = 0; s < n; s += CHUNK) {
      const end = Math.min(n, s + CHUNK);
      for (let i = s; i < end; i++) {
        let v = 0;
        for (let c = 0; c < channels.length; c++) v += channels[c]![i]!;
        tally(v * scale, i);
      }
      if (end < n) {
        await yieldToMain();
        throwIfAborted(signal);
      }
    }
  }

  const rms = Math.sqrt(sumSq / Math.max(1, n));
  if (run >= 16) clipRun += run;
  const peakDb = 20 * Math.log10(peak + EPS);
  const rmsDb = 20 * Math.log10(rms + EPS);
  return {
    mono,
    peakDb,
    rmsDb,
    crestDb: peakDb - rmsDb,
    clipFraction: clipRun / Math.max(1, n),
  };
}

/**
 * Replace NaN/±Infinity samples with 0 in every channel (chunked, with
 * yields like the other full-buffer passes). Mutates the decoded buffer in
 * place — getChannelData returns the live storage — so all downstream
 * readers (mix-down, stereo width, DSP) see sanitized samples.
 */
async function sanitizeNonFinite(buffer: AudioBuffer, signal?: AbortSignal): Promise<void> {
  const CHUNK = 1 << 20;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let s = 0; s < data.length; s += CHUNK) {
      const end = Math.min(data.length, s + CHUNK);
      for (let i = s; i < end; i++) {
        if (!Number.isFinite(data[i]!)) data[i] = 0;
      }
      if (end < data.length) {
        await yieldToMain();
        throwIfAborted(signal);
      }
    }
  }
}

function stereoWidth(buffer: AudioBuffer): number {  if (buffer.numberOfChannels < 2) return 0;
  const L = buffer.getChannelData(0);
  const R = buffer.getChannelData(1);
  const n = Math.min(L.length, R.length);
  let mid = 0;
  let side = 0;
  const step = Math.max(1, Math.floor(n / 250_000));
  for (let i = 0; i < n; i += step) {
    const m = 0.5 * (L[i]! + R[i]!);
    const s = 0.5 * (L[i]! - R[i]!);
    mid += m * m;
    side += s * s;
  }
  if (mid + side < EPS) return 0;
  return Math.min(1, side / (mid + EPS));
}

type Region = { start: number; end: number };

/** Mean-square envelope at 0.5 s blocks, strided. Shared by ranking. */
function envelopeBlocks(
  length: number,
  sampleRate: number,
  tap: (i: number) => number,
): { blockRms: Float32Array; nBlocks: number; block: number } {
  const block = Math.max(1, Math.floor(0.5 * sampleRate));
  const nBlocks = Math.max(1, Math.ceil(length / block));
  const blockRms = new Float32Array(nBlocks);
  const stride = Math.max(1, Math.floor(sampleRate / 4000)); // ~4000 taps/sec
  for (let b = 0; b < nBlocks; b++) {
    const s = b * block;
    const e = Math.min(length, s + block);
    let sumSq = 0;
    let taps = 0;
    for (let i = s; i < e; i += stride) {
      const v = tap(i);
      sumSq += v * v;
      taps++;
    }
    blockRms[b] = sumSq / Math.max(1, taps);
  }
  return { blockRms, nBlocks, block };
}

function rankWindows(
  blockRms: Float32Array,
  nBlocks: number,
  block: number,
  length: number,
  win: number,
  keep: number,
): Region[] {
  const clamp = (start: number): Region => {
    const s = Math.max(0, Math.min(start, length - win));
    return { start: s, end: s + win };
  };
  const windowScore = (start: number): number => {
    const end = Math.min(nBlocks, Math.ceil((start + win) / block));
    let sum = 0;
    let n = 0;
    for (let b = Math.floor(start / block); b < end; b++) {
      sum += blockRms[b]!;
      n++;
    }
    return n ? sum / n : 0;
  };
  const candidates = [0.08, 0.24, 0.4, 0.56, 0.72, 0.86].map((f) =>
    clamp(Math.floor(f * length)),
  );
  candidates.sort((x, y) => windowScore(y.start) - windowScore(x.start));
  const picked = candidates.slice(0, keep);
  picked.sort((x, y) => x.start - y.start);
  return picked;
}

export function pickRegions(samples: Float32Array, sampleRate: number): Region[] {
  const length = samples.length;
  const totalSec = length / sampleRate;
  if (totalSec <= 8) return [{ start: 0, end: length }];

  const windowSec = Math.min(4, totalSec / 3);
  const win = Math.floor(windowSec * sampleRate);
  const clamp = (start: number): Region => {
    const s = Math.max(0, Math.min(start, length - win));
    return { start: s, end: s + win };
  };

  // Short files: fixed fractions as before.
  if (totalSec < 20) {
    return [0.15, 0.5, 0.75].map((f) => clamp(Math.floor(f * length)));
  }

  // Long files: score 6 candidate windows by loudness, keep the loudest 4.
  // A fade-out or silence landing in a fixed window used to dilute occupancy
  // by 25%; loudness ranking makes that structurally impossible.
  const { blockRms, nBlocks, block } = envelopeBlocks(length, sampleRate, (i) => samples[i]!);
  return rankWindows(blockRms, nBlocks, block, length, win, 4);
}

/** Region picking for very long files without materializing full mono. */
export function pickRegionsFromBuffer(buffer: AudioBuffer): Region[] {
  const length = buffer.length;
  const sampleRate = buffer.sampleRate;
  const totalSec = length / sampleRate;
  const windowSec = Math.min(4, totalSec / 3);
  const win = Math.floor(windowSec * sampleRate);
  const ch0 = buffer.getChannelData(0);
  const { blockRms, nBlocks, block } = envelopeBlocks(length, sampleRate, (i) => ch0[i]!);
  return rankWindows(blockRms, nBlocks, block, length, win, 4);
}

export function excerptRegion(length: number, sampleRate: number): Region {
  const totalSec = length / sampleRate;
  const dur = Math.min(12, totalSec);
  const samples = Math.floor(dur * sampleRate);
  const startFrac = totalSec < 16 ? 0 : 0.32;
  let start = Math.floor(startFrac * length);
  if (start + samples > length) start = Math.max(0, length - samples);
  return { start, end: start + samples };
}

export async function stftPower(
  samples: Float32Array,
  start: number,
  end: number,
  onProgress?: (p: number) => void,
  signal?: AbortSignal,
): Promise<{ magDb: Float32Array[]; frames: number; frameRmsDb: Float32Array }> {
  const real = new Float32Array(FFT_SIZE);
  const imag = new Float32Array(FFT_SIZE);
  const nBins = FFT_SIZE / 2;
  const magDb: Float32Array[] = [];
  const rmsList: number[] = [];
  const usable = Math.max(0, end - start - FFT_SIZE);
  const hops = Math.max(1, Math.floor(usable / HOP) + 1);
  let hopIndex = 0;

  for (let pos = start; pos + FFT_SIZE <= end; pos += HOP) {
    real.fill(0);
    imag.fill(0);
    let sumSq = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const v = samples[pos + i]! * hannWindow[i]!;
      real[i] = v;
      sumSq += v * v;
    }
    rmsList.push(10 * Math.log10(sumSq / FFT_SIZE + EPS));
    fft(real, imag, false);
    const frame = new Float32Array(nBins);
    const norm = 1 / (windowSumSq || 1);
    for (let k = 0; k < nBins; k++) {
      const p = (real[k]! * real[k]! + imag[k]! * imag[k]!) * norm;
      frame[k] = 10 * Math.log10(p + EPS);
    }
    magDb.push(frame);
    hopIndex++;
    if (hopIndex % 24 === 0) {
      onProgress?.(hopIndex / hops);
      await yieldToMain();
      throwIfAborted(signal);
    }
  }

  if (magDb.length === 0) {
    // File shorter than FFT window — zero-pad once.
    real.fill(0);
    imag.fill(0);
    const n = Math.min(FFT_SIZE, end - start);
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = samples[start + i]! * hannWindow[i]!;
      real[i] = v;
      sumSq += v * v;
    }
    rmsList.push(10 * Math.log10(sumSq / FFT_SIZE + EPS));
    fft(real, imag, false);
    const frame = new Float32Array(nBins);
    const norm = 1 / (windowSumSq || 1);
    for (let k = 0; k < nBins; k++) {
      const p = (real[k]! * real[k]! + imag[k]! * imag[k]!) * norm;
      frame[k] = 10 * Math.log10(p + EPS);
    }
    magDb.push(frame);
  }

  return { magDb, frames: magDb.length, frameRmsDb: Float32Array.from(rmsList) };
}

/**
 * Loud-frame mask: frames within `gateDb` of the loudest are kept; fades,
 * silence, and MP3 padding are excluded. Returns null (keep everything)
 * when gating would discard more than 75% — never gate the pool away.
 */
export function loudFrameMask(
  frameRmsDb: Float32Array | null | undefined,
  frameCount: number,
  gateDb = 40,
): boolean[] | null {
  if (!frameRmsDb || frameRmsDb.length !== frameCount || frameCount === 0) {
    return null;
  }
  let maxRms = -Infinity;
  for (let i = 0; i < frameRmsDb.length; i++) {
    if (frameRmsDb[i]! > maxRms) maxRms = frameRmsDb[i]!;
  }
  const use = new Array<boolean>(frameCount).fill(false);
  let usedCount = 0;
  for (let i = 0; i < frameCount; i++) {
    if (frameRmsDb[i]! >= maxRms - gateDb) {
      use[i] = true;
      usedCount++;
    }
  }
  if (usedCount < Math.max(1, Math.floor(frameCount / 4))) return null;
  return use;
}

export async function meanSpectrum(
  frames: Float32Array[],
  nBins: number,
  keep?: boolean[] | null,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const mean = new Float32Array(nBins);
  if (frames.length === 0) return mean;
  // Average in linear power, then back to dB. Quiet frames (fades, padding)
  // are skipped when a mask is provided so they can't dilute the mean.
  let used = 0;
  for (let i = 0; i < frames.length; i++) {
    if (keep && !keep[i]) continue;
    const f = frames[i]!;
    for (let k = 0; k < nBins; k++) {
      mean[k]! += Math.pow(10, f[k]! / 10);
    }
    used++;
    if (used % 128 === 0) {
      await yieldToMain();
      throwIfAborted(signal);
    }
  }
  const inv = 1 / Math.max(1, used);
  for (let k = 0; k < nBins; k++) {
    mean[k] = 10 * Math.log10(mean[k]! * inv + EPS);
  }
  return mean;
}

function smooth(input: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = 0;
    let n = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= input.length) continue;
      s += input[j]!;
      n++;
    }
    out[i] = s / n;
  }
  return out;
}

/**
 * Fraction of (loud) frames with content above a mid-anchored threshold.
 * Frames quieter than `maxRms - gateDb` (fades, silence, MP3 padding) are
 * excluded so one dead window can't dilute the pool.
 */
function occupancyCurve(
  frames: Float32Array[],
  sampleRate: number,
  frameRmsDb?: Float32Array | null,
  gateDb = 40,
): Float32Array {
  const nBins = frames[0]?.length ?? 0;
  const occ = new Float32Array(nBins);
  if (frames.length === 0 || nBins === 0) return occ;
  const binHz = sampleRate / FFT_SIZE;
  const midLo = Math.max(1, Math.round(600 / binHz));
  const midHi = Math.min(nBins - 1, Math.round(6000 / binHz));

  let use: boolean[] | null = null;
  let usedCount = frames.length;
  if (frameRmsDb && frameRmsDb.length === frames.length) {
    // Never gate everything away: keep at least the loudest 25%.
    const mask = loudFrameMask(frameRmsDb, frames.length, gateDb);
    if (mask) {
      use = mask;
      usedCount = 0;
      for (let i = 0; i < use.length; i++) if (use[i]) usedCount++;
    }
  }

  for (let i = 0; i < frames.length; i++) {
    if (use && !use[i]) continue;
    const f = frames[i]!;
    let midPeak = -200;
    for (let k = midLo; k <= midHi; k++) {
      if (f[k]! > midPeak) midPeak = f[k]!;
    }
    const thresh = midPeak - 44;
    for (let k = 0; k < nBins; k++) {
      if (f[k]! > thresh) occ[k]! += 1;
    }
  }
  const inv = 1 / Math.max(1, usedCount);
  for (let k = 0; k < nBins; k++) occ[k]! *= inv;
  return occ;
}

export async function detectCutoff(
  frames: Float32Array[],
  sampleRate: number,
  meanDb: Float32Array,
  frameRmsDb?: Float32Array | null,
): Promise<{
  cutoffHz: number;
  rolloff: RolloffKind;
  brickwallHz: number | null;
  hfSlope: number;
  hfOccupancy: number;
  /** Spectral flatness (0 tonal → 1 noise-like) of mean power, 10–20 kHz. */
  hfFlatness: number;
  /** Same, broadband 200 Hz–20 kHz: starved-bitrate noise soup reads ~1. */
  bbFlatness: number;
  /**
   * True when the ceiling looks like the music running out (no cliff, no
   * air) rather than an encoder low-pass — class must cap at "high".
   */
  sourceLimited: boolean;
}> {
  const nBins = frames[0]?.length ?? 0;
  const binHz = sampleRate / FFT_SIZE;
  const nyquist = sampleRate / 2;
  const binAt = (freq: number) =>
    Math.max(1, Math.min(Math.max(2, nBins) - 2, Math.round(freq / binHz)));

  const occ = occupancyCurve(frames, sampleRate, frameRmsDb);
  const sm = smooth(occ, Math.max(1, Math.round(120 / binHz)));

  const OCC_ON = 0.05;
  let cutoffBin = binAt(2000);
  for (let k = binAt(1500); k < nBins; k++) {
    if (sm[k]! >= OCC_ON) cutoffBin = k;
  }
  let cutoffHz = Math.min(nyquist, cutoffBin * binHz);

  const span = Math.max(2, Math.round(600 / binHz));
  let steepest = 0;
  let dropBin = binAt(8000);
  for (let k = binAt(7000); k < nBins - span; k++) {
    const drop = sm[k]! - sm[k + span]!;
    if (drop > steepest) {
      steepest = drop;
      dropBin = k;
    }
  }

  let rolloff: RolloffKind = "natural";
  let brickwallHz: number | null = null;
  // HF slope first: it confirms (or refutes) what the occupancy wobble
  // suggests below. Measured 10 → 16 kHz in dB/octave on the mean spectrum.
  const smDb = smooth(meanDb, 3);
  const slopeHi = Math.min(16000, nyquist - 100);
  const slopeOctaves = Math.log2(slopeHi / 10000);
  const hfSlope =
    slopeOctaves > 0 ? ((smDb[binAt(slopeHi)] ?? 0) - (smDb[binAt(10000)] ?? 0)) / slopeOctaves : 0;

  if (steepest > 0.32 && dropBin * binHz < nyquist - 400) {
    rolloff = "brickwall";
    brickwallHz = dropBin * binHz;
    cutoffHz = brickwallHz;
  } else if (steepest > 0.16 && hfSlope < -6) {
    // Occupancy dips without a real HF decline are sparse-content wobble
    // (quiet mixes, stepped tones) — not an encoder rolloff.
    rolloff = "steep";
  }

  if (rolloff !== "brickwall") {
    // Mean-spectrum cliff fallback for sparse content: the occupancy
    // detector is fooled by window leakage of loud isolated tones, but the
    // mean spectrum shows a 45 dB+ cliff crisply. Only an UPGRADE to
    // brickwall, requiring loud content below (top > −55 dBFS) and no
    // resumption within 6 kHz above (tone gaps resume; encoder cuts don't).
    // A cliff into silence reads as an encoder cut: for this app's job
    // (spotting band-limited "lossless" files) recall beats precision here,
    // and genuinely dull sources are still capped kindly by sourceLimited.
    const meanSm = smooth(meanDb, Math.max(1, Math.round(200 / binHz)));
    const cliffSpan = Math.max(2, Math.round(500 / binHz));
    const recSpan = Math.max(1, Math.round(6000 / binHz));
    for (let k = binAt(8000); k + cliffSpan < nBins; k++) {
      const top = meanSm[k]!;
      if (top < -55) continue;
      if (top - meanSm[k + cliffSpan]! < 45) continue;
      let rec = -Infinity;
      for (let j = k + cliffSpan + 1; j <= Math.min(nBins - 1, k + cliffSpan + recSpan); j++) {
        if (meanSm[j]! > rec) rec = meanSm[j]!;
      }
      if (rec > top - 20) continue; // content gap, not a cut
      rolloff = "brickwall";
      brickwallHz = (k + cliffSpan / 2) * binHz;
      cutoffHz = brickwallHz;
      break;
    }
  }

  cutoffHz = Math.min(cutoffHz, nyquist);

  const lo = binAt(16000);
  const hi = binAt(Math.min(20000, nyquist - 50));
  let hf = 0;
  let n = 0;
  for (let k = lo; k <= hi; k++) {
    hf += sm[k]!;
    n++;
  }
  const hfOccupancy = n ? hf / n : 0;

  // Spectral flatness from the mean power spectrum: geometric mean / mean
  // of linear power. Tonal music ≈ 0.05–0.4, hiss/crowd ≈ 0.5–0.7,
  // quantization-noise soup ≈ 0.85+. Computed in dB space for stability:
  // flatness = 10^((avgDb − 10·log10(avgLin)) / 10).
  const flatness = (loHz: number, hiHz: number): number => {
    const loB = binAt(loHz);
    const hiB = binAt(Math.min(hiHz, nyquist - 50));
    if (hiB <= loB) return 0;
    let sumDb = 0;
    let sumLin = 0;
    let count = 0;
    for (let k = loB; k <= hiB; k++) {
      const db = meanDb[k]!;
      if (!Number.isFinite(db)) continue;
      sumDb += db;
      sumLin += Math.pow(10, db / 10);
      count++;
    }
    if (count === 0 || sumLin <= 0) return 0;
    const avgDb = sumDb / count;
    const avgLin = sumLin / count;
    // Near-silent bands (dither, encoding floor) read "flat" — meaningless,
    // so only report flatness for bands with real energy.
    if (10 * Math.log10(avgLin + EPS) < -75) return 0;
    const f = Math.pow(10, (avgDb - 10 * Math.log10(avgLin + EPS)) / 10);
    return Math.max(0, Math.min(1, f));
  };
  const hfFlatness = flatness(10000, 20000);
  const bbFlatness = flatness(200, 20000);

  // No cliff found (cutoff rode to within a bin or two of Nyquist) yet no
  // real air: the ceiling is the music, not an encoder. Callers cap class.
  const sourceLimited =
    rolloff === "natural" && cutoffHz >= nyquist * 0.985 && hfOccupancy < 0.35;

  return { cutoffHz, rolloff, brickwallHz, hfSlope, hfOccupancy, hfFlatness, bbFlatness, sourceLimited };
}

export function classifyQuality(
  cutoffHz: number,
  nyquist: number,
  rolloff: RolloffKind,
  hfOccupancy: number,
  opts?: { bbFlatness?: number; sourceLimited?: boolean },
): QualityClass {
  const bbFlatness = opts?.bbFlatness ?? 0;
  const sourceLimited = opts?.sourceLimited ?? false;

  // Starved-bitrate noise soup (full-band mush): cap hard. Never fires on
  // the valid corpus (max observed 0.14) — pure insurance.
  if (bbFlatness > 0.45) return "low";

  // The music ran out before any encoder did: provably transparent, but the
  // ceiling reflects the source, so "high" is the honest ceiling.
  if (sourceLimited) return "high";

  // Absolute floors are calibrated at 44.1 kHz; scale for higher rates so
  // 48/96 kHz lossless isn't punished for content living under 22 kHz.
  // The lossless bar caps at 24 kHz — content above that is mic/air, and
  // demanding cutoff ≥ nyquist·0.9 would make 96 kHz lossless unreachable.
  const ref = Math.min(nyquist, 24000);
  const scale = Math.max(1, ref / 22050);
  if (
    cutoffHz >= Math.max(20000, ref * 0.9) &&
    rolloff === "natural" &&
    hfOccupancy >= 0.3
  ) {
    return "lossless";
  }
  if (cutoffHz >= 18500 * scale) return "high";
  if (cutoffHz >= 17000 * scale) return "medium";
  if (cutoffHz >= 14000 * scale) return "standard";
  if (cutoffHz >= 10000 * scale) return "low";
  return "telephone";
}

export function scoreOf(input: {
  cutoffHz: number;
  nyquistHz: number;
  rolloff: RolloffKind;
  hfOccupancy: number;
  /** Sustained-clip fraction (runs ≥16 samples at ≥0.999), not overshoots. */
  clipFraction: number;
  /** Broadband flatness: starved encodes read ~0.7+, music ≤ 0.15. */
  bbFlatness: number;
}): { total: number; parts: ScoreParts } {
  // Codec quality only. Mastering traits (dynamics, width, mono) are
  // displayed separately and must not move this number.
  const parts: ScoreParts = {
    ceiling: Math.min(1, input.cutoffHz / 20000) * 62,
    rolloff: input.rolloff === "natural" ? 12 : input.rolloff === "steep" ? 5 : 0,
    air: Math.min(1, input.hfOccupancy * 2.5) * 14,
    // Clean-spectrum bonus: tonal HF scores over hashy HF. bbFlatness on the
    // valid corpus peaks at 0.14, so legit content keeps ~8 of these points.
    clarity: 12 * (1 - Math.min(1, input.bbFlatness * 3)),
    // Sustained clipping docks; isolated lossy-decoder overshoots don't count
    // (they never form runs — see mixDownWithStats).
    clip:
      input.clipFraction > 0.002 ? -14 : input.clipFraction > 0.0003 ? -6 : 0,
  };
  let total =
    parts.ceiling + parts.rolloff + parts.air + parts.clarity + parts.clip;
  // Starved full-band mush: cap hard regardless of ceiling.
  if (input.bbFlatness > 0.45) total = Math.min(total, 35);
  return { total: Math.max(0, Math.min(100, total)), parts };
}

function resampleFramesToDisplay(
  frames: Float32Array[],
  sampleRate: number,
  excerptStartSec: number,
  excerptDurSec: number,
): SpectrogramData {
  const nFrames = frames.length;
  const srcBins = FFT_SIZE / 2;
  const srcBinHz = sampleRate / FFT_SIZE;
  const maxHz = Math.min(DISPLAY_MAX_HZ, sampleRate / 2);
  const nBins = DISPLAY_BINS;
  const out = new Float32Array(nFrames * nBins);

  for (let t = 0; t < nFrames; t++) {
    const src = frames[t]!;
    for (let b = 0; b < nBins; b++) {
      const hz = (b / (nBins - 1)) * maxHz;
      const srcK = hz / srcBinHz;
      const k0 = Math.min(srcBins - 2, Math.max(0, Math.floor(srcK)));
      const frac = srcK - k0;
      const v = src[k0]! * (1 - frac) + src[k0 + 1]! * frac;
      out[t * nBins + b] = v;
    }
  }

  return {
    frames: out,
    nFrames,
    nBins,
    maxHz,
    durationSec: excerptDurSec,
    excerptStartSec,
  };
}

/**
 * Decode failures name the likely cause: Safari (and older Edge) can't
 * decode Vorbis/Opus at all, so those files get a targeted message instead
 * of the generic format list.
 */
function decodeErrorMessage(fileName: string, codec: string): string {
  if (/vorbis|opus/i.test(codec)) {
    return (
      `Could not decode “${fileName}”. Safari can't play ${codec} files — ` +
      `try this song as MP3, M4A, WAV, or FLAC, or open this page in Chrome or Firefox.`
    );
  }
  return `Could not decode “${fileName}”. Try MP3, M4A, AAC, WAV, FLAC, or OGG.`;
}

/**
 * decodeAudioData that also works on pre-14.1 Safari, where only the
 * callback form exists. Modern engines always take the promise branch —
 * the callback path runs solely when the return value isn't thenable.
 */
function decodeBuffer(
  ctx: OfflineAudioContext | AudioContext,
  bytes: ArrayBuffer,
): Promise<AudioBuffer> {
  try {
    const maybe = (ctx.decodeAudioData as unknown as (
      buf: ArrayBuffer,
    ) => unknown)(bytes);
    if (maybe && typeof (maybe as Promise<AudioBuffer>).then === "function") {
      return maybe as Promise<AudioBuffer>;
    }
  } catch {
    // Fall through to callbacks below.
  }
  return new Promise<AudioBuffer>((resolve, reject) => {
    try {
      (ctx.decodeAudioData as unknown as (
        buf: ArrayBuffer,
        ok: (b: AudioBuffer) => void,
        err: (e: unknown) => void,
      ) => void).call(ctx, bytes.slice(0), resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}

async function decodeNative(
  buffer: ArrayBuffer,
  sampleRateHint: number | null,
): Promise<AudioBuffer> {
  // decodeAudioData detaches the buffer it is given, so hand it a copy and
  // only copy again if a retry is actually needed.
  const tryRate = (rate: number, bytes: ArrayBuffer) => {
    const ctx = new OfflineAudioContext(2, 128, rate);
    return decodeBuffer(ctx, bytes);
  };

  const candidates = [sampleRateHint, 44100, 48000].filter(
    (v, i, a): v is number => typeof v === "number" && v >= 8000 && a.indexOf(v) === i,
  );

  let lastErr: unknown = null;
  for (const rate of candidates) {
    try {
      return await tryRate(rate, buffer.slice(0));
    } catch (err) {
      lastErr = err;
    }
  }

  // Last resort: default output rate (webkit prefix for very old Safari).
  try {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) throw lastErr ?? new Error("No AudioContext available.");
    const ctx = new AC();
    try {
      return await decodeBuffer(ctx, buffer.slice(0));
    } finally {
      void ctx.close();
    }
  } catch {
    throw lastErr instanceof Error
      ? lastErr
      : new Error("This browser could not decode that audio file.");
  }
}

export type DspSpans = {
  regions: Region[];
  excerpt: Region;
  /**
   * True excerpt position/duration in the ORIGINAL file. The lite path feeds
   * a concatenated slice buffer, so local offsets would place the
   * spectrogram's time axis at the wrong wall-clock position.
   */
  excerptStartSec?: number;
  excerptDurSec?: number;
};

export type DspResult = {
  meanDb: Float32Array;
  meanDbHzPerBin: number;
  spectrogram: SpectrogramData;
  cutoffHz: number;
  nyquistHz: number;
  rolloff: RolloffKind;
  brickwallHz: number | null;
  qualityClass: QualityClass;
  score: number;
  scoreParts: ScoreParts;
  sourceLimited: boolean;
  hfOccupancy: number;
  hfSlope: number;
};

/**
 * The pure DSP core: regions → STFT → cutoff → class → score → display
 * spectrogram. Runs on the main thread (legacy/fallback) or inside
 * dsp.worker.ts — same function, same numbers, via runDspParallel.
 */
export async function runDsp(
  mono: Float32Array,
  sampleRate: number,
  clipFraction: number,
  onProgress?: (phase: string, amount: number) => void,
  spans?: DspSpans,
  signal?: AbortSignal,
): Promise<DspResult> {
  throwIfAborted(signal);
  const regions = spans?.regions ?? pickRegions(mono, sampleRate);

  const allFrames: Float32Array[] = [];
  const allRmsDb: number[] = [];
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i]!;
    const { magDb, frameRmsDb } = await stftPower(
      mono,
      region.start,
      region.end,
      (p) => {
        onProgress?.("Spectrum", 0.3 + (0.4 * (i + p)) / regions.length);
      },
      signal,
    );
    allFrames.push(...magDb);
    for (let k = 0; k < frameRmsDb.length; k++) allRmsDb.push(frameRmsDb[k]!);
  }

  const excerpt = spans?.excerpt ?? excerptRegion(mono.length, sampleRate);
  onProgress?.("Spectrogram", 0.74);
  const { magDb: excerptFrames } = await stftPower(
    mono,
    excerpt.start,
    excerpt.end,
    (p) => onProgress?.("Spectrogram", 0.74 + 0.2 * p),
    signal,
  );
  const nBins = FFT_SIZE / 2;
  const frameRms = Float32Array.from(allRmsDb);
  const keep = loudFrameMask(frameRms, allFrames.length);
  const meanDb = await meanSpectrum(allFrames, nBins, keep, signal);
  const cutoff = await detectCutoff(
    allFrames,
    sampleRate,
    meanDb,
    frameRms,
  );
  const hfOcc = cutoff.hfOccupancy;
  const nyquistHz = sampleRate / 2;
  const qualityClass = classifyQuality(
    cutoff.cutoffHz,
    nyquistHz,
    cutoff.rolloff,
    hfOcc,
    { bbFlatness: cutoff.bbFlatness, sourceLimited: cutoff.sourceLimited },
  );

  const spectrogram = resampleFramesToDisplay(
    excerptFrames,
    sampleRate,
    // Lite path: the local offset is meaningless wall-clock-wise — the spans
    // carry the true position in the original file.
    spans?.excerptStartSec ?? excerpt.start / sampleRate,
    spans?.excerptDurSec ?? (excerpt.end - excerpt.start) / sampleRate,
  );

  const { total: score, parts: scoreParts } = scoreOf({
    cutoffHz: cutoff.cutoffHz,
    nyquistHz,
    rolloff: cutoff.rolloff,
    hfOccupancy: hfOcc,
    clipFraction,
    bbFlatness: cutoff.bbFlatness,
  });

  return {
    meanDb,
    meanDbHzPerBin: sampleRate / FFT_SIZE,
    spectrogram,
    cutoffHz: cutoff.cutoffHz,
    nyquistHz,
    rolloff: cutoff.rolloff,
    brickwallHz: cutoff.brickwallHz,
    qualityClass,
    score,
    scoreParts,
    sourceLimited: cutoff.sourceLimited,
    hfOccupancy: hfOcc,
    hfSlope: cutoff.hfSlope,
  };
}

export async function analyzeFile(
  file: File,
  onProgress?: (phase: string, amount: number) => void,
  signal?: AbortSignal,
): Promise<Analysis> {
  throwIfAborted(signal);
  onProgress?.("Reading file", 0.05);

  // decodeAudioData materializes the whole PCM buffer in memory — a huge
  // file is not a slow analysis but a dead tab (especially on ≤4 GB
  // devices, which OOM on far less). Fail loudly instead.
  // Memory-constrained devices get a tighter bound: a 200 MB compressed
  // file is already >1 GB of decoded float on lossless input.
  const lowMemory =
    typeof navigator !== "undefined" &&
    typeof (navigator as Navigator & { deviceMemory?: number }).deviceMemory === "number" &&
    (navigator as Navigator & { deviceMemory?: number }).deviceMemory! <= 4;
  const maxBytes = lowMemory ? 200 * 1024 * 1024 : 600 * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new Error(
      "That file is too large to analyze in a browser. Try a smaller copy (e.g. FLAC instead of WAV).",
    );
  }

  // Result cache: identical bytes skip decode + DSP entirely.
  const key = await cacheKeyForFile(file);
  throwIfAborted(signal);
  if (key) {
    const hit = await cacheGet(key);
    if (hit) {
      onProgress?.("Done", 1);
      return {
        ...hit,
        id: `${file.name}-${file.size}-${file.lastModified}`,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        objectUrl: URL.createObjectURL(file),
        cacheKey: key,
      };
    }
  }

  const arrayBuffer = await file.arrayBuffer();
  throwIfAborted(signal);
  const container = sniffContainer(arrayBuffer, file.name, file.type);

  onProgress?.("Decoding", 0.12);
  let audio: AudioBuffer;
  try {
    audio = await decodeNative(arrayBuffer, container.sampleRate);
  } catch {
    throw new Error(decodeErrorMessage(file.name, container.codec));
  }

  if (audio.length < 256 || audio.duration < 0.15) {
    throw new Error("That file is too short to analyze.");
  }

  // Corrupt-but-decodable files can carry NaN/Infinity samples, which
  // poison every downstream number into confident-looking "NaN" verdicts.
  // Zero them once here so tally, stereoWidth and the DSP all agree.
  await sanitizeNonFinite(audio, signal);

  onProgress?.("Measuring", 0.28);
  throwIfAborted(signal);
  const width = stereoWidth(audio);

  // Files over ~15 min would need 600 MB+ of float buffers; analyze slices
  // (loudest windows + display excerpt) instead and say so in the UI.
  const LONG_SEC = 15 * 60;
  let mono: Float32Array;
  let loud: { peakDb: number; rmsDb: number; crestDb: number; clipFraction: number };
  let spans: DspSpans | undefined;
  let liteAnalysis = false;
  if (audio.duration > LONG_SEC) {
    liteAnalysis = true;
    const stats = await mixDownWithStats(audio, false, signal);
    loud = stats;
    throwIfAborted(signal);
    const regions = pickRegionsFromBuffer(audio);
    const excerpt = excerptRegion(audio.length, audio.sampleRate);
    const chs: Float32Array[] = [];
    for (let c = 0; c < audio.numberOfChannels; c++) chs.push(audio.getChannelData(c));
    const scale = 1 / Math.max(1, chs.length);
    const mixSlice = (s: number, e: number): Float32Array => {
      const m = new Float32Array(Math.max(0, e - s));
      for (let i = 0; i < m.length; i++) {
        let v = 0;
        for (let c = 0; c < chs.length; c++) v += chs[c]![s + i]!;
        m[i] = v * scale;
      }
      return m;
    };
    const parts: Float32Array[] = [];
    const localRegions: Region[] = [];
    let off = 0;
    for (const r of regions) {
      const m = mixSlice(r.start, r.end);
      localRegions.push({ start: off, end: off + m.length });
      parts.push(m);
      off += m.length;
    }
    const em = mixSlice(excerpt.start, excerpt.end);
    const localExcerpt = { start: off, end: off + em.length };
    parts.push(em);
    off += em.length;
    mono = new Float32Array(off);
    let p = 0;
    for (const part of parts) {
      mono.set(part, p);
      p += part.length;
    }
    // The display buffer is a concatenation, so its local offsets say nothing
    // about where the spectrogram excerpt lives in the song — pass the true
    // wall-clock position for the time axis.
    spans = {
      regions: localRegions,
      excerpt: localExcerpt,
      excerptStartSec: excerpt.start / audio.sampleRate,
      excerptDurSec: (excerpt.end - excerpt.start) / audio.sampleRate,
    };
  } else {
    const full = await mixDownWithStats(audio, true, signal);
    mono = full.mono;
    loud = full;
  }
  throwIfAborted(signal);

  const dsp = await runDspParallel(
    mono,
    audio.sampleRate,
    loud.clipFraction,
    onProgress,
    spans,
    signal,
  );

  const containerKbps = audio.duration > 0 ? (file.size * 8) / audio.duration / 1000 : 0;

  onProgress?.("Done", 1);

  const analysis: Analysis = {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type,
    objectUrl: URL.createObjectURL(file),
    durationSec: audio.duration,
    sampleRate: audio.sampleRate,
    channels: audio.numberOfChannels,
    container: {
      ...container,
      sampleRate: container.sampleRate ?? audio.sampleRate,
      channels: container.channels ?? audio.numberOfChannels,
    },
    containerKbps,
    cutoffHz: dsp.cutoffHz,
    nyquistHz: dsp.nyquistHz,
    rolloff: dsp.rolloff,
    brickwallHz: dsp.brickwallHz,
    qualityClass: dsp.qualityClass,
    score: dsp.score,
    scoreParts: dsp.scoreParts,
    sourceLimited: dsp.sourceLimited,
    liteAnalysis,
    cacheKey: key,
    peakDb: loud.peakDb,
    rmsDb: loud.rmsDb,
    crestDb: loud.crestDb,
    clipFraction: loud.clipFraction,
    stereoWidth: width,
    hfOccupancy: dsp.hfOccupancy,
    hfSlope: dsp.hfSlope,
    meanDb: dsp.meanDb,
    meanDbHzPerBin: dsp.meanDbHzPerBin,
    spectrogram: dsp.spectrogram,
  };

  if (key) void cachePut(key, analysis);
  return analysis;
}

export function compareAnalyses(a: Analysis, b: Analysis): Comparison {
  const cutoffDeltaHz = a.cutoffHz - b.cutoffHz;
  const absDelta = Math.abs(cutoffDeltaHz);
  const scoreDelta = a.score - b.score;
  const sameLength = Math.abs(a.durationSec - b.durationSec) < 2.5;

  let winner: SlotId | "tie" = "tie";
  // A win needs real bandwidth separation (~900 Hz — above the ~250 Hz
  // smoothing width and measurement jitter). The composite score can veto
  // it, but only by disagreeing with a real margin (≥4 pts): a 1–3 point
  // gap is scoring noise and must not overrule kilohertz of bandwidth.
  // A decisive score gap wins on its own.
  const scoreOpposes =
    cutoffDeltaHz !== 0 &&
    Math.sign(scoreDelta) !== Math.sign(cutoffDeltaHz) &&
    Math.abs(scoreDelta) >= 4;
  if (absDelta >= 900 && !scoreOpposes) {
    winner = cutoffDeltaHz > 0 ? "a" : "b";
  } else if (Math.abs(scoreDelta) >= 8) {
    winner = scoreDelta > 0 ? "a" : "b";
  }

  let confidence: Comparison["confidence"] = "low";
  if (absDelta >= 2500 || Math.abs(scoreDelta) >= 15) confidence = "high";
  else if (absDelta >= 800 || Math.abs(scoreDelta) >= 6) confidence = "medium";
  // Strongly contradictory evidence caps confidence: a big bandwidth gap
  // means less when the composite score firmly disagrees, and vice versa.
  if (scoreOpposes && confidence === "high") confidence = "medium";

  const better = winner === "tie" ? a : winner === "a" ? a : b;
  const worse = winner === "tie" ? b : winner === "a" ? b : a;
  const betterSlot = winner === "b" ? "B" : "A";
  const worseSlot = winner === "b" ? "A" : "B";

  const fmtK = (hz: number) =>
    hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;

  if (winner === "tie") {
    const sourceNote =
      a.sourceLimited && b.sourceLimited
        ? " Both carry little high-frequency content, so this ceiling reflects the music itself — not the encodes."
        : "";
    // When the ceilings visibly differ, say so with both numbers — "both
    // reach about X" is a lie the spectrogram immediately contradicts.
    const detail =
      absDelta >= 500
        ? `File A reaches ${fmtK(a.cutoffHz)} and File B ${fmtK(b.cutoffHz)}, but the quality scores land together (${a.score.toFixed(0)} vs ${b.score.toFixed(0)}) — so neither copy is clearly better overall. Trust the A/B preview below over either number.${sourceNote}`
        : `Both reach about ${fmtK(a.cutoffHz)}. If they sound different, it is more likely loudness or stereo width than bandwidth.${sourceNote}`;
    return {
      winner,
      confidence,
      headline: "No winner — these copies are essentially the same quality",
      detail,
      cutoffDeltaHz,
      sameLength,
    };
  }

  const wall =
    worse.rolloff === "brickwall"
      ? ` File ${worseSlot} is brickwalled — a hard encoder low-pass, not a quiet mix.`
      : "";

  const claimed = worse.container.claimedKbps;
  // CAF belongs here with FLAC/WAV: sniff.ts parses it and it is lossless.
  const losslessWrap = /FLAC|PCM|ALAC|WAV|AIFF|CAF/i.test(worse.container.codec);
  // A lossless wrapper around band-limited audio is always worth flagging;
  // a lossy header only when it claims high bitrate for low measured class.
  const mismatch = losslessWrap
    ? worse.qualityClass !== "lossless"
      ? ` File ${worseSlot} is wrapped as ${worse.container.codec} (${Math.round(claimed ?? worse.containerKbps)} kbps), but the audio inside is band-limited.`
      : ""
    : claimed &&
        worse.qualityClass !== "high" &&
        worse.qualityClass !== "lossless" &&
        claimed >= 256
      ? ` The header says ${claimed} kbps, but the spectrum behaves like a much lower-rate encode.`
      : "";

  const lengthNote = sameLength
    ? ""
    : " Lengths differ, so double-check these are the same song.";

  return {
    winner,
    confidence,
    headline: `Winner: File ${betterSlot} — the higher-quality copy`,
    detail: `${fmtK(better.cutoffHz)} of real bandwidth versus ${fmtK(worse.cutoffHz)} — ${fmtK(Math.abs(cutoffDeltaHz))} more air kept.${wall}${mismatch}${lengthNote}`,
    cutoffDeltaHz,
    sameLength,
  };
}

export const QUALITY_LABEL: Record<QualityClass, string> = {
  lossless: "Lossless class",
  high: "High · ≈256–320 kbps",
  medium: "Medium · ≈160–192 kbps",
  standard: "Standard · ≈128 kbps",
  low: "Low · ≈64–96 kbps",
  telephone: "Band-limited · ≪64 kbps",
};

export const ROLLOFF_LABEL: Record<RolloffKind, string> = {
  natural: "Natural rolloff",
  steep: "Steep rolloff",
  brickwall: "Brickwall low-pass",
};
