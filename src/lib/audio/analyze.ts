import { fft, hann } from "./fft";
import { sniffContainer } from "./sniff";
import { cacheGet, cacheKeyForFile, cachePut } from "./cache";
import { runDspParallel } from "./dsp-client";
import {
  ENVELOPE_BLOCK_SEC,
  envelopeFromTaps,
  songMatchOf,
  type Envelope,
  type SongMatch,
} from "./align";
import { bufferSource, type SliceSource } from "./source";
import { WavPcmSource, wavContainerInfo, wavMetaFromBlob, type WavPcmMeta } from "./wav-source";
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

/** Inline slice sanitize for mono mixes built outside decodeAudioData. */
function sanitizeMonoSlice(mono: Float32Array): void {
  for (let i = 0; i < mono.length; i++) {
    if (!Number.isFinite(mono[i]!)) mono[i] = 0;
  }
}

function concatFloat32(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function stereoWidth(buffer: AudioBuffer): number {
  if (buffer.numberOfChannels < 2) return 0;
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

/** Non-zero samples a grid verdict needs; fewer reads as "can't tell". */
const GRID_MIN_SAMPLES = 4096;

/**
 * Effective bit depth: the integer grid the samples actually live on. A 24-bit
 * container whose audio fits the 16-bit grid EXACTLY (zero-padding upconvert,
 * the classic storefront repack) reads 16. Deliberately strict: dithered
 * masters (residual ~±0.5 LSB) report null rather than a false flag, so this
 * can miss a dithered pad but never flags honest audio.
 *
 * Exact zeros sit on every grid and prove nothing, so only non-zero samples
 * count — digital silence or a near-silent probe returns null instead of a
 * confident (and false) "16-bit". Every channel must fit: a pad applies to
 * the whole file, and one honest 24-bit channel disproves it.
 */
export function bitGridCheck(channels: Float32Array[]): number | null {
  const onGrid = (v: number, bits: number) => {
    const x = v * 2 ** (bits - 1);
    return Math.abs(x - Math.round(x)) <= 0.03;
  };
  // Grids nest (16 ⊂ 20 ⊂ 24), so one sample off a grid rules out every
  // coarser one too; `fits` is the coarsest grid still standing.
  const GRIDS = [16, 20, 24];
  let fits = 0;
  let nonZero = 0;
  for (const samples of channels) {
    const step = Math.max(1, Math.floor(samples.length / 500_000));
    for (let i = 0; i < samples.length && fits < GRIDS.length; i += step) {
      const v = samples[i]!;
      if (v === 0 || !Number.isFinite(v)) continue;
      nonZero++;
      while (fits < GRIDS.length && !onGrid(v, GRIDS[fits]!)) fits++;
    }
  }
  if (nonZero < GRID_MIN_SAMPLES) return null;
  return GRIDS[fits] ?? null;
}

function effectiveBitDepth(buffer: AudioBuffer): number | null {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return bitGridCheck(channels);
}

type Region = { start: number; end: number };

/** Loudness-ranked analysis windows on top of an envelope. */
export function rankWindowsByEnvelope(
  env: { power: Float32Array; blockSec: number } | Envelope,
  length: number,
  sampleRate: number,
  win: number,
  keep: number,
): Region[] {
  const power = (env as Envelope).power;
  const block = Math.max(1, Math.floor(env.blockSec * sampleRate));
  const candidates = [0.08, 0.24, 0.4, 0.56, 0.72, 0.86].map((f) => {
    const s = Math.max(0, Math.min(Math.floor(f * length), length - win));
    return { start: s, end: s + win };
  });
  const windowScore = (start: number): number => {
    const end = Math.min(power.length, Math.ceil((start + win) / block));
    let sum = 0;
    let n = 0;
    for (let b = Math.floor(start / block); b < Math.max(0, end); b++) {
      sum += power[b] ?? 0;
      n++;
    }
    return n ? sum / n : 0;
  };
  candidates.sort((x, y) => windowScore(y.start) - windowScore(x.start));
  const picked = candidates.slice(0, keep);
  picked.sort((x, y) => x.start - y.start);
  return picked;
}

/** Long-file (and streaming WAV) window pick: loudest 4 of 6 candidates. */
export function longRegions(env: Envelope, length: number, sampleRate: number): Region[] {
  const totalSec = length / sampleRate;
  const windowSec = Math.min(4, totalSec / 3);
  const win = Math.floor(windowSec * sampleRate);
  return rankWindowsByEnvelope(env, length, sampleRate, win, 4);
}

export function scanRegions(
  samples: Float32Array,
  sampleRate: number,
): { regions: Region[]; envelope: Envelope } {
  const length = samples.length;
  const totalSec = length / sampleRate;
  const envelope = envelopeFromTaps(length, sampleRate, (i) => samples[i]!);
  if (totalSec <= 8) return { regions: [{ start: 0, end: length }], envelope };
  const win = windowLength(totalSec, sampleRate);
  if (totalSec < 20) {
    const clamp = (f: number) => Math.max(0, Math.min(Math.floor(f * length), length - win));
    return {
      regions: [0.15, 0.5, 0.75].map((f) => ({ start: clamp(f), end: clamp(f) + win })),
      envelope,
    };
  }
  return { regions: longRegions(envelope, length, sampleRate), envelope };
}

export function pickRegions(samples: Float32Array, sampleRate: number): Region[] {
  return scanRegions(samples, sampleRate).regions;
}

export function scanRegionsFromBuffer(buffer: AudioBuffer): {
  regions: Region[];
  envelope: Envelope;
} {
  const length = buffer.length;
  const sampleRate = buffer.sampleRate;
  const totalSec = length / sampleRate;
  // Tap the channel mean, matching the mono pickRegions path exactly: ranking
  // on channel 0 alone misranks windows over hard-panned material whose left
  // channel goes quiet where the mix is loud.
  const chs: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c));
  const scale = 1 / Math.max(1, chs.length);
  const envelope = envelopeFromTaps(length, sampleRate, (i) => {
    if (chs.length === 1) return chs[0]![i]!;
    let v = 0;
    for (let c = 0; c < chs.length; c++) v += chs[c]![i]!;
    return v * scale;
  });
  if (totalSec <= 8) return { regions: [{ start: 0, end: length }], envelope };
  const win = windowLength(totalSec, sampleRate);
  if (totalSec < 20) {
    const clamp = (f: number) => Math.max(0, Math.min(Math.floor(f * length), length - win));
    return {
      regions: [0.15, 0.5, 0.75].map((f) => ({ start: clamp(f), end: clamp(f) + win })),
      envelope,
    };
  }
  return { regions: longRegions(envelope, length, sampleRate), envelope };
}

export function pickRegionsFromBuffer(buffer: AudioBuffer): Region[] {
  return scanRegionsFromBuffer(buffer).regions;
}

function windowLength(totalSec: number, sampleRate: number): number {
  return Math.floor(Math.min(4, totalSec / 3) * sampleRate);
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

export type DspOptions = {
  /**
   * False when the decode rate was NOT confirmed by the container (no sniffed
   * rate, or the hinted rate failed and a fallback rate was used — then pass
   * it as `sourceRate`). A 44.1 kHz source decoded at 48 kHz keeps its own
   * band edge near 22 kHz, far below the new Nyquist — that edge must not
   * read as an encoder low-pass. Omitted/true keeps the calibrated behavior
   * exactly.
   */
  rateConfirmed?: boolean;
  /**
   * Container-reported sample rate when it is known but the decode had to
   * run at another rate (native decode failed). Pins the only plausible
   * source band edge to sourceRate / 2. Ignored unless rateConfirmed is false.
   */
  sourceRate?: number | null;
};

// Widest 10→90% transition still read as a source band edge (occupancy /
// mean-spectrum curves). Hard cuts measure ~200 Hz (the smoothing floor),
// windowed-sinc 44.1→48 kHz resamplers 260–440 Hz; wider is a fade.
const OCC_EDGE_MAX_WIDTH = 500;
const MEAN_EDGE_MAX_WIDTH = 600;

export async function detectCutoff(
  frames: Float32Array[],
  sampleRate: number,
  meanDb: Float32Array,
  frameRmsDb?: Float32Array | null,
  opts?: DspOptions,
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
  /**
   * Nyquist the ceiling is judged against: the decode Nyquist, or the
   * inferred original one when an unconfirmed-rate decode shows the source's
   * band edge (22.05 / 24 kHz) below it.
   */
  sourceNyquistHz: number;
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

  // Source band edge — only when the decode rate is a guess. A 44.1 kHz
  // source decoded at 48 kHz carries its own band edge near 22.05 kHz, far
  // below the decode Nyquist; that edge must not read as an encoder
  // low-pass. With a known container rate whose native decode failed, the
  // only candidate is that rate's Nyquist; with no container rate, the
  // common 44.1 / 48 kHz originals are tried.
  const sourceEdges =
    opts?.rateConfirmed === false
      ? (opts.sourceRate ? [opts.sourceRate / 2] : [22050, 24000]).filter((e) => e < nyquist - 400)
      : [];
  let sourceEdge: number | null = null;
  // Lightly smoothed occupancy for the resumed-content check.
  const occFine = sourceEdges.length > 0 ? smooth(occ, 1) : occ;
  /**
   * Falling transition of `curve` between bins `from` (before) and `to`
   * (after): position of the halfway crossing and the 10→90% width, in Hz.
   * The scan windows only bracket a cliff to within ~their span; this pins it.
   */
  const transition = (curve: Float32Array, from: number, to: number) => {
    const hi = curve[from]!;
    const d = hi - curve[to]!;
    let k10 = -1;
    let k50 = -1;
    let k90 = -1;
    for (let k = from; k <= to; k++) {
      const v = curve[k]!;
      if (k10 < 0 && v < hi - 0.1 * d) k10 = k;
      if (k50 < 0 && v < hi - 0.5 * d) k50 = k;
      if (k90 < 0 && v < hi - 0.9 * d) k90 = k;
    }
    if (k90 < 0) k90 = to;
    if (k50 < 0) k50 = to;
    if (k10 < 0) k10 = from;
    return { posHz: k50 * binHz, widthHz: (k90 - k10) * binHz };
  };
  /**
   * The candidate source Nyquist a falling transition at `posHz` is, or null.
   *
   * Window on the precise halfway crossing: [edge − 700, edge + max(40 Hz,
   * 1.5 bins)]. Above: a cliff past the edge proves content the source can't
   * have had (a 22.1 kHz cut is not a 44.1 kHz source), so the tolerance is
   * just bin quantization.Below: measured on full-band 44.1 kHz noise put
   * through Kaiser windowed-sinc 44.1→48 kHz resamplers, the crossing lands
   * at 21.49–22.08 kHz for cutoffs 0.95–0.99·Nyquist (32–128 taps/side);
   * softer resamplers (≤ 0.94·Nyquist, e.g. 0.9 with 16 taps) land at
   * 21.0–21.2 kHz and read as a low-pass regardless.
   *
   * RESIDUAL AMBIGUITY: a genuine encoder low-pass whose cliff crosses in
   * [edge − 700, edge] (≈ 21.35–22.09 kHz for 44.1 kHz) is indistinguishable
   * from that band edge — neither position nor steepness separates them —
   * and is read as the source's. Common encoders top out near 20–20.5 kHz,
   * so this band is nearly empty in practice, and it only applies to
   * unconfirmed-rate decodes. A soft fade (wider than `maxWidthHz`)
   * or content resuming above the transition is never a band edge.
   */
  const EDGE_BELOW = 700;
  const EDGE_ABOVE = Math.max(40, 1.5 * binHz);
  const edgeFor = (posHz: number, widthHz: number, maxWidthHz: number): number | null => {
    const edge = sourceEdges.find((e) => posHz >= e - EDGE_BELOW && posHz <= e + EDGE_ABOVE);
    if (edge === undefined || widthHz > maxWidthHz) return null;
    // Content resuming beyond the transition is not a band edge either.
    for (let k = Math.max(binAt(edge) + 3, binAt(posHz + widthHz)); k < nBins; k++) {
      if (occFine[k]! >= OCC_ON) return null;
    }
    return edge;
  };

  const span = Math.max(2, Math.round(600 / binHz));
  const scanDrop = (limit: number) => {
    let steepest = 0;
    let dropBin = binAt(8000);
    for (let k = binAt(7000); k + span < limit; k++) {
      const drop = sm[k]! - sm[k + span]!;
      if (drop > steepest) {
        steepest = drop;
        dropBin = k;
      }
    }
    return { steepest, dropBin };
  };
  let { steepest, dropBin } = scanDrop(nBins);
  if (sourceEdges.length > 0 && steepest > 0.32 && dropBin * binHz < nyquist - 400) {
    const t = transition(sm, dropBin, dropBin + span);
    const edge = edgeFor(t.posHz, t.widthHz, OCC_EDGE_MAX_WIDTH);
    if (edge !== null) {
      // The steepest drop is the source's band edge: judge only what lies
      // below the transition, as a native-rate decode would have seen it.
      sourceEdge = edge;
      ({ steepest, dropBin } = scanDrop(binAt(t.posHz - t.widthHz - 100)));
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
      if (sourceEdges.length > 0) {
        const t = transition(meanSm, k, k + cliffSpan);
        const edge = edgeFor(t.posHz, t.widthHz, MEAN_EDGE_MAX_WIDTH);
        if (edge !== null) {
          // The source's band edge, not an encoder cut — and nothing above
          // it belongs to the source, so stop scanning here.
          sourceEdge ??= edge;
          break;
        }
      }
      rolloff = "brickwall";
      brickwallHz = (k + cliffSpan / 2) * binHz;
      cutoffHz = brickwallHz;
      break;
    }
  }

  // A brickwall above where the edge was inferred proves content past it:
  // the inference was wrong, so judge against the decode Nyquist again.
  if (sourceEdge !== null && brickwallHz !== null && brickwallHz > sourceEdge - EDGE_BELOW) {
    sourceEdge = null;
  }
  // Only a cliff establishes a source edge — a natural fade near 22 kHz is
  // the music running out and is judged against the decode Nyquist.
  const sourceNyquistHz = sourceEdge ?? nyquist;
  cutoffHz = Math.min(cutoffHz, sourceNyquistHz);

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
    rolloff === "natural" && cutoffHz >= sourceNyquistHz * 0.985 && hfOccupancy < 0.35;

  return {
    cutoffHz,
    rolloff,
    brickwallHz,
    hfSlope,
    hfOccupancy,
    hfFlatness,
    bbFlatness,
    sourceLimited,
    sourceNyquistHz,
  };
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

  // The lossless bar caps at 24 kHz — content above that is mic/air, and
  // demanding cutoff ≥ nyquist·0.9 would make 96 kHz lossless unreachable.
  const ref = Math.min(nyquist, 24000);
  if (cutoffHz >= Math.max(20000, ref * 0.9) && rolloff === "natural" && hfOccupancy >= 0.3) {
    return "lossless";
  }
  // Encoder low-passes are absolute frequencies (LAME 320k cuts ~20 kHz at
  // any rate), so the lossy ladder must not scale with the sample rate.
  if (cutoffHz >= 18500) return "high";
  if (cutoffHz >= 17000) return "medium";
  if (cutoffHz >= 14000) return "standard";
  if (cutoffHz >= 10000) return "low";
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
    clip: input.clipFraction > 0.002 ? -14 : input.clipFraction > 0.0003 ? -6 : 0,
  };
  let total = parts.ceiling + parts.rolloff + parts.air + parts.clarity + parts.clip;
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
 * decode Vorbis/Opus at all, and only Safari decodes Apple Lossless (ALAC),
 * so those files get a targeted message instead of the generic format list.
 */
export function decodeErrorMessage(fileName: string, codec: string): string {
  if (/^alac$/i.test(codec)) {
    return (
      `Could not decode “${fileName}”. This browser can't decode Apple Lossless (ALAC) — ` +
      `open this page in Safari, or convert the song to FLAC or WAV.`
    );
  }
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
    const maybe = (ctx.decodeAudioData as unknown as (buf: ArrayBuffer) => unknown)(bytes);
    if (maybe && typeof (maybe as Promise<AudioBuffer>).then === "function") {
      return maybe as Promise<AudioBuffer>;
    }
  } catch {
    // Fall through to callbacks below.
  }
  return new Promise<AudioBuffer>((resolve, reject) => {
    try {
      (
        ctx.decodeAudioData as unknown as (
          buf: ArrayBuffer,
          ok: (b: AudioBuffer) => void,
          err: (e: unknown) => void,
        ) => void
      ).call(ctx, bytes.slice(0), resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}

export async function decodeNative(
  buffer: ArrayBuffer,
  sampleRateHint: number | null,
): Promise<AudioBuffer> {
  // decodeAudioData detaches the buffer it is given, so hand it a copy and
  // only copy again if a retry is actually needed.
  const tryRate = (rate: number, bytes: ArrayBuffer) => {
    const ctx = new OfflineAudioContext(2, 128, rate);
    return decodeBuffer(ctx, bytes);
  };

  // Fallback rates are tried highest-first: if the container's reported rate
  // can't be honored and a resample is unavoidable, 48 kHz keeps everything
  // the file had up to 24 kHz, while decoding a wide file at 44.1 kHz would
  // silently discard content above 22 kHz. Upsampling 44.1→48 costs only CPU.
  const candidates = [sampleRateHint, 48000, 44100].filter(
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
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
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
  options?: DspOptions,
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
  const cutoff = await detectCutoff(allFrames, sampleRate, meanDb, frameRms, options);
  const hfOcc = cutoff.hfOccupancy;
  const nyquistHz = sampleRate / 2;
  const qualityClass = classifyQuality(
    cutoff.cutoffHz,
    cutoff.sourceNyquistHz,
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

/**
 * Mix the analysis windows + display excerpt of any SliceSource into one
 * concatenated mono buffer with local spans, exactly the layout runDsp's Lite
 * path consumes. The excerpt's true wall-clock position travels through
 * `excerptStartSec` so the spectrogram axis lands on real song positions.
 */
export async function sliceMono(
  source: SliceSource,
  regions: Region[],
  excerpt?: Region,
  signal?: AbortSignal,
): Promise<{ mono: Float32Array; spans: DspSpans }> {
  const parts: Float32Array[] = [];
  const localRegions: Region[] = [];
  let off = 0;
  for (let i = 0; i < regions.length; i++) {
    const slice = await mixSlice(source, regions[i]!, signal);
    localRegions.push({ start: off, end: off + slice.length });
    parts.push(slice);
    off += slice.length;
    await yieldToMain();
    throwIfAborted(signal);
  }
  // No excerpt asked for (measurement-only callers): the spectrogram pass
  // reuses the first window instead of slicing extra audio.
  let localExcerpt = localRegions[0] ?? { start: 0, end: 0 };
  if (excerpt) {
    const em = await mixSlice(source, excerpt, signal);
    localExcerpt = { start: off, end: off + em.length };
    parts.push(em);
    off += em.length;
  }
  const mono = concatFloat32(parts);
  sanitizeMonoSlice(mono);
  return { mono, spans: { regions: localRegions, excerpt: localExcerpt } };
}

async function mixSlice(
  source: SliceSource,
  r: Region,
  signal?: AbortSignal,
): Promise<Float32Array> {
  throwIfAborted(signal);
  const channels = await source.sliceChannels(r.start, r.end);
  const len = Math.min(...channels.map((c) => c.length));
  if (len <= 0) return new Float32Array(0);
  if (channels.length === 1) {
    const out = new Float32Array(len);
    out.set(channels[0]!.subarray(0, len));
    return out;
  }
  const out = new Float32Array(len);
  const scale = 1 / channels.length;
  for (let i = 0; i < len; i++) {
    let v = 0;
    for (let c = 0; c < channels.length; c++) v += channels[c]![i]!;
    out[i] = v * scale;
  }
  return out;
}

export type SourceStats = {
  peakDb: number;
  rmsDb: number;
  crestDb: number;
  clipFraction: number;
  stereoWidth: number;
  envelope: Envelope;
};

/**
 * One sequential pass over any SliceSource measuring peak/RMS, sustained
 * clipping, stereo width (strided, global-anchored like stereoWidth()) and
 * the loudness envelope (block-anchored strided, like envelopeFromTaps).
 * This is the lite-path-equivalent of mixDownWithStats + pickRegionsFromBuffer
 * + stereoWidth, unified so WAV files too big for decodeAudioData still get
 * every measurement — bounded memory, never a materialized full mono.
 */
export async function scanSourceStats(
  source: SliceSource,
  onProgress?: (p: number) => void,
  signal?: AbortSignal,
): Promise<SourceStats> {
  throwIfAborted(signal);
  const { sampleRate, length } = source;
  if (length < 256) throw new Error("That file is too short to analyze.");
  const ch = source.numberOfChannels;
  const block = Math.max(1, Math.floor(ENVELOPE_BLOCK_SEC * sampleRate));
  const nBlocks = Math.max(1, Math.ceil(length / block));
  const power = new Float32Array(nBlocks);
  const blockTaps = new Uint32Array(nBlocks);
  const strideEnv = Math.max(1, Math.floor(sampleRate / 4000));
  const strideWidth = Math.max(1, Math.floor(length / 250_000));

  let peak = 0;
  let sumSq = 0;
  let run = 0;
  let clipRun = 0;
  let mid = 0;
  let side = 0;
  const CHUNK = 1 << 19; // ~2 MB per channel per chunk — small blob reads
  const scale = 1 / Math.max(1, ch);

  for (let s = 0; s < length; s += CHUNK) {
    const end = Math.min(length, s + CHUNK);
    const channels = await source.sliceChannels(s, end);
    const len = Math.max(0, end - s);
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (let c = 0; c < channels.length; c++) v += channels[c]![i]!;
      v *= scale;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sumSq += v * v;
      if (a >= 0.999) run++;
      else {
        if (run >= 16) clipRun += run;
        run = 0;
      }
      const gi = s + i;
      const b = Math.floor(gi / block);
      // Block-anchored stride, matching envelopeFromTaps' tap positions.
      if ((gi - b * block) % strideEnv === 0) {
        power[b]! += v * v;
        blockTaps[b]++;
      }
      if (ch >= 2 && gi % strideWidth === 0) {
        // Stereo width tap (strided like stereoWidth()).
        const L = channels[0]![i]!;
        const R = channels[1]![i]!;
        const m = 0.5 * (L + R);
        const sd = 0.5 * (L - R);
        mid += m * m;
        side += sd * sd;
      }
    }
    onProgress?.(end / length);
    await yieldToMain();
    throwIfAborted(signal);
  }
  if (run >= 16) clipRun += run;

  for (let b = 0; b < nBlocks; b++) {
    power[b] = blockTaps[b]! > 0 ? power[b]! / blockTaps[b]! : 0;
  }
  const envelope: Envelope = { blockSec: ENVELOPE_BLOCK_SEC, power };

  let stereoWidth = 0;
  if (ch >= 2) {
    // Count nothing when the whole file is DC silence.
    if (mid + side < EPS) stereoWidth = 0;
    else stereoWidth = Math.min(1, side / (mid + EPS));
  }

  const rms = Math.sqrt(sumSq / Math.max(1, length));
  const peakDb = 20 * Math.log10(peak + EPS);
  return {
    peakDb,
    rmsDb: 20 * Math.log10(rms + EPS),
    crestDb: peakDb - 20 * Math.log10(rms + EPS),
    clipFraction: clipRun / Math.max(1, length),
    stereoWidth,
    envelope,
  };
}

/**
 * Excerpt re-scan: decode (or slice, for WAV) only a ~12 s window at `seekSec`
 * and build a spectrogram from it. Heavy on big files, so it is strictly
 * user-initiated and wrapped in the serial queue by the caller.
 */
export async function scanExcerpt(
  blob: Blob,
  hintRate: number | null,
  seekSec: number,
  onProgress?: (status: string, amount: number) => void,
  signal?: AbortSignal,
): Promise<SpectrogramData> {
  throwIfAborted(signal);
  onProgress?.("Reading", 0.05);
  const wav = await wavMetaFromBlob(blob).catch(() => null);
  const startSec = Math.max(0, seekSec);
  const sanitize = (mono: Float32Array) => sanitizeMonoSlice(mono);

  if (wav) {
    // Bounded path: no full decode — the exact PCM frames are read from disk.
    onProgress?.("Scanning", 0.25);
    const source = new WavPcmSource(blob, wav);
    const span = Math.min(12, wav.frameCount / wav.sampleRate);
    const start = Math.max(
      0,
      Math.min(
        Math.floor(startSec * wav.sampleRate),
        wav.frameCount - Math.floor(span * wav.sampleRate),
      ),
    );
    const end = Math.min(wav.frameCount, start + Math.floor(span * wav.sampleRate));
    const channels = await source.sliceChannels(start, end);
    const len = Math.min(...channels.map((c) => c.length));
    const mono = new Float32Array(Math.max(0, len));
    const scale = 1 / Math.max(1, channels.length);
    for (let i = 0; i < mono.length; i++) {
      let v = 0;
      for (let c = 0; c < channels.length; c++) v += channels[c]![i]!;
      mono[i] = v * scale;
    }
    sanitize(mono);
    const { magDb } = await stftPower(
      mono,
      0,
      mono.length,
      (p) => onProgress?.("Scanning", 0.3 + 0.6 * p),
      signal,
    );
    onProgress?.("Done", 1);
    return resampleFramesToDisplay(
      magDb,
      wav.sampleRate,
      start / wav.sampleRate,
      mono.length / wav.sampleRate,
    );
  }

  const bytes = await blob.arrayBuffer();
  throwIfAborted(signal);
  onProgress?.("Decoding", 0.2);
  const buffer = await decodeNative(bytes, hintRate);
  throwIfAborted(signal);
  if (buffer.length < 256 || buffer.duration < 0.15) {
    throw new Error("That file is too short to scan.");
  }
  const durSec = Math.min(12, buffer.duration);
  const start = Math.max(
    0,
    Math.min(
      Math.floor(startSec * buffer.sampleRate),
      buffer.length - Math.floor(durSec * buffer.sampleRate),
    ),
  );
  const end = Math.min(buffer.length, start + Math.floor(durSec * buffer.sampleRate));
  if (end - start < 256) throw new Error("That position is past the end of the file.");
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const scale = 1 / Math.max(1, channels.length);
  const mono = new Float32Array(end - start);
  for (let i = 0; i < mono.length; i++) {
    let v = 0;
    for (let c = 0; c < channels.length; c++) v += channels[c]![start + i]!;
    mono[i] = v * scale;
  }
  sanitize(mono);
  onProgress?.("Scanning", 0.5);
  const { magDb } = await stftPower(
    mono,
    0,
    mono.length,
    (p) => onProgress?.("Scanning", 0.5 + 0.45 * p),
    signal,
  );
  onProgress?.("Done", 1);
  return resampleFramesToDisplay(
    magDb,
    buffer.sampleRate,
    start / buffer.sampleRate,
    mono.length / buffer.sampleRate,
  );
}

/**
 * File too big for decodeAudioData — name the right remedy by codec family.
 * (WAV never reaches this: over-cap WAVs stream through analyzeStreamingWav.)
 */
function oversizeMessage(codec: string): string {
  if (/MP3|AAC|Opus|Vorbis|FLAC|ALAC|CAF|AIFF|PCM/i.test(codec)) {
    return (
      "That file is too large to analyze in a browser in one piece. " +
      "Try a FLAC copy, lower sample-rate/bit-depth conversion, or split a long rip into parts."
    );
  }
  return "That file is too large to analyze in a browser. Try a smaller copy (e.g. FLAC instead of WAV).";
}

async function analyzeStreamingWav(
  file: File,
  meta: WavPcmMeta,
  key: string | null,
  onProgress?: (phase: string, amount: number) => void,
  signal?: AbortSignal,
): Promise<Analysis> {
  const source = new WavPcmSource(file, meta);
  const sampleRate = meta.sampleRate;
  const durationSec = meta.frameCount / sampleRate;
  if (durationSec < 0.15) throw new Error("That file is too short to analyze.");

  onProgress?.("Measuring", 0.1);
  const stats = await scanSourceStats(
    source,
    (p) => onProgress?.("Measuring", 0.1 + 0.2 * p),
    signal,
  );

  // Same pipeline as the >15 min Lite path: loudest windows from the
  // envelope + a display excerpt, sliced and concatenated, DSP over spans.
  const regions = longRegions(stats.envelope, source.length, sampleRate);
  const excerpt = excerptRegion(source.length, sampleRate);
  onProgress?.("Measuring", 0.32);
  const { mono, spans } = await sliceMono(source, regions, excerpt, signal);
  onProgress?.("Spectrum", 0.35);

  const dsp = await runDspParallel(
    mono,
    sampleRate,
    stats.clipFraction,
    onProgress,
    {
      ...spans,
      excerptStartSec: excerpt.start / sampleRate,
      excerptDurSec: (excerpt.end - excerpt.start) / sampleRate,
    },
    signal,
    { rateConfirmed: true },
  );

  // 16-bit-in-24-bit pad check from short probes spread across the song:
  // one probe can land in a fade or silence, five rarely all do. The probes
  // are concatenated per channel so the grid verdict sees them as one file.
  let effectiveBits: number | null = null;
  if (!meta.float && meta.bits > 16) {
    try {
      const probeLen = Math.min(48_000, Math.floor(meta.frameCount / 6));
      const perChannel: Float32Array[][] = Array.from({ length: meta.channels }, () => []);
      for (const f of [0.15, 0.3, 0.5, 0.7, 0.85]) {
        const at = Math.floor(meta.frameCount * f);
        const probe = await source.sliceChannels(at, at + probeLen);
        probe.forEach((ch, c) => perChannel[c]?.push(ch));
        throwIfAborted(signal);
      }
      effectiveBits = bitGridCheck(perChannel.map(concatFloat32));
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      effectiveBits = null; // best-effort
    }
  }

  const containerKbps = durationSec > 0 ? (meta.dataLen * 8) / durationSec / 1000 : 0;
  onProgress?.("Done", 1);

  const analysis: Analysis = {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type,
    objectUrl: URL.createObjectURL(file),
    durationSec,
    sampleRate,
    channels: meta.channels,
    container: wavContainerInfo(meta, durationSec),
    containerKbps,
    cutoffHz: dsp.cutoffHz,
    nyquistHz: dsp.nyquistHz,
    rolloff: dsp.rolloff,
    brickwallHz: dsp.brickwallHz,
    qualityClass: dsp.qualityClass,
    score: dsp.score,
    scoreParts: dsp.scoreParts,
    sourceLimited: dsp.sourceLimited,
    liteAnalysis: true,
    cacheKey: key,
    decode: { rateConfirmed: true, sourceRateHint: null },
    envelope: stats.envelope,
    effectiveBits,
    peakDb: stats.peakDb,
    rmsDb: stats.rmsDb,
    crestDb: stats.crestDb,
    clipFraction: stats.clipFraction,
    stereoWidth: stats.stereoWidth,
    hfOccupancy: dsp.hfOccupancy,
    hfSlope: dsp.hfSlope,
    meanDb: dsp.meanDb,
    meanDbHzPerBin: dsp.meanDbHzPerBin,
    spectrogram: dsp.spectrogram,
  };
  if (key) void cachePut(key, analysis);
  return analysis;
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
  // WAV is exempt: it streams through analyzeStreamingWav instead.
  const lowMemory =
    typeof navigator !== "undefined" &&
    typeof (navigator as Navigator & { deviceMemory?: number }).deviceMemory === "number" &&
    (navigator as Navigator & { deviceMemory?: number }).deviceMemory! <= 4;
  const maxBytes = lowMemory ? 200 * 1024 * 1024 : 600 * 1024 * 1024;

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

  // Structural WAV check (cheap header reads) decides the streaming path
  // before any full-file read. Failure/corruption falls straight through.
  let wavMeta: WavPcmMeta | null = null;
  if (file.size > maxBytes) {
    wavMeta = await wavMetaFromBlob(file).catch(() => null);
  }
  if (wavMeta) {
    return analyzeStreamingWav(file, wavMeta, key, onProgress, signal);
  }

  const arrayBuffer = await file.arrayBuffer();
  throwIfAborted(signal);
  const container = sniffContainer(arrayBuffer, file.name, file.type);
  if (file.size > maxBytes) {
    throw new Error(oversizeMessage(container.codec));
  }

  onProgress?.("Decoding", 0.12);
  let audio: AudioBuffer;
  try {
    audio = await decodeNative(arrayBuffer, container.sampleRate);
  } catch {
    throw new Error(decodeErrorMessage(file.name, container.codec));
  }
  // Only a decode at the container's own rate is native; anything else is a
  // fallback guess and may have resampled the source. When the container
  // did report a rate (its native decode just failed), that rate still pins
  // the source's band edge.
  const rateConfirmed = container.sampleRate !== null && audio.sampleRate === container.sampleRate;
  const dspOptions: DspOptions = rateConfirmed
    ? { rateConfirmed }
    : { rateConfirmed, sourceRate: container.sampleRate };

  if (audio.length < 256 || audio.duration < 0.15) {
    throw new Error("That file is too short to analyze.");
  }

  // Corrupt-but-decodable files can carry NaN/Infinity samples, which
  // poison every downstream number into confident-looking "NaN" verdicts.
  // Zero them once here so tally, stereoWidth and the DSP all agree.
  await sanitizeNonFinite(audio, signal);

  onProgress?.("Measuring", 0.28);
  throwIfAborted(signal);

  // Files over ~15 min would need 600 MB+ of float buffers; analyze slices
  // (loudest windows + display excerpt) instead and say so in the UI.
  const LONG_SEC = 15 * 60;
  let liteAnalysis = false;
  let loud: {
    peakDb: number;
    rmsDb: number;
    crestDb: number;
    clipFraction: number;
    stereoWidth: number;
    envelope?: Envelope;
  };
  let dsp: DspResult;
  if (audio.duration > LONG_SEC) {
    liteAnalysis = true;
    // One bounded pass: peak/RMS/clip/width + envelope (the old path did
    // this as three separate scans over the whole buffer).
    const stats = await scanSourceStats(
      bufferSource(audio),
      (p) => onProgress?.("Measuring", 0.28 + 0.04 * p),
      signal,
    );
    const regions = longRegions(stats.envelope, audio.length, audio.sampleRate);
    const excerpt = excerptRegion(audio.length, audio.sampleRate);
    onProgress?.("Measuring", 0.32);
    const sliced = await sliceMono(bufferSource(audio), regions, excerpt, signal);
    dsp = await runDspParallel(
      sliced.mono,
      audio.sampleRate,
      stats.clipFraction,
      onProgress,
      {
        ...sliced.spans,
        excerptStartSec: excerpt.start / audio.sampleRate,
        excerptDurSec: (excerpt.end - excerpt.start) / audio.sampleRate,
      },
      signal,
      dspOptions,
    );
    loud = { ...stats };
  } else {
    const full = await mixDownWithStats(audio, true, signal);
    dsp = await runDspParallel(
      full.mono,
      audio.sampleRate,
      full.clipFraction,
      onProgress,
      undefined,
      signal,
      dspOptions,
    );
    loud = {
      peakDb: full.peakDb,
      rmsDb: full.rmsDb,
      crestDb: full.crestDb,
      clipFraction: full.clipFraction,
      stereoWidth: stereoWidth(audio),
      // Verification envelope: block-anchored strided, same math as the
      // lite path's, over the already-materialized mono.
      envelope: envelopeFromTaps(audio.length, audio.sampleRate, (i) => full.mono[i]!),
    };
  }
  throwIfAborted(signal);

  const isFloatContainer = /PCM float/i.test(container.codec);
  const losslessContainer =
    /FLAC|ALAC|WAV|AIFF|CAF|PCM/i.test(container.codec) &&
    container.bitDepth !== null &&
    container.bitDepth > 16 &&
    !isFloatContainer;
  const effectiveBits = losslessContainer ? effectiveBitDepth(audio) : null;

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
    decode: { rateConfirmed, sourceRateHint: container.sampleRate },
    envelope: loud.envelope,
    effectiveBits,
    peakDb: loud.peakDb,
    rmsDb: loud.rmsDb,
    crestDb: loud.crestDb,
    clipFraction: loud.clipFraction,
    stereoWidth: loud.stereoWidth,
    hfOccupancy: dsp.hfOccupancy,
    hfSlope: dsp.hfSlope,
    meanDb: dsp.meanDb,
    meanDbHzPerBin: dsp.meanDbHzPerBin,
    spectrogram: dsp.spectrogram,
  };

  if (key) void cachePut(key, analysis);
  return analysis;
}

/**
 * Head-to-head verdict. `labels` are the slot letters the reader sees for
 * `a` and `b` (a C-vs-A pair must say "File C", not "File A"); they only
 * change the prose, never the decision.
 */
/** One result contract for the verdict, ranking, badges and exported report. */
export function compareAnalyses(
  a: ComparisonMetrics,
  b: ComparisonMetrics,
  labels: { a: string; b: string } = { a: "A", b: "B" },
): Comparison {
  const measured = compareQualityMeasurements(a, b, labels);
  const identityStatus = measured.songMatch?.status ?? "unverified";
  const result: Comparison = {
    ...measured,
    identityStatus,
    outcome: measured.winner === "tie" ? "inconclusive" : "preferred",
    reasons: [measured.winner === "tie" ? "insufficient-separation" : "bandwidth-or-score"],
  };
  if (
    identityStatus === "different" ||
    identityStatus === "uncertain" ||
    identityStatus === "unverified"
  ) {
    return {
      ...result,
      winner: "tie",
      confidence: "low",
      outcome: "not-comparable",
      reasons: [identityStatus === "different" ? "different-recording" : "identity-uncertain"],
      headline:
        identityStatus === "different"
          ? "These recordings may be different"
          : "Recording match is uncertain",
      detail:
        identityStatus === "different"
          ? measured.detail
          : "There is not enough reliable matching audio to recommend a copy. Try longer excerpts of the same recording. You can still listen to both files.",
    };
  }
  const ac = a.comparisonCoverage;
  const bc = b.comparisonCoverage;
  if (
    (ac || bc) &&
    (ac?.status !== "shared" || bc?.status !== "shared" || !ac.key || ac.key !== bc.key)
  ) {
    return {
      ...result,
      winner: "tie",
      confidence: "low",
      outcome: "inconclusive",
      reasons: ["shared-measurement-unavailable"],
      headline: "Shared-passage comparison is unavailable",
      detail:
        "The files have not both been measured over the same passages. No quality preference is shown. You can still listen to the aligned copies or reload the files to retry.",
    };
  }
  result.coverage = ac;
  // Evidence levels describe heuristics, not calibrated probabilities.
  if (result.winner === "tie") {
    result.headline = "No clear quality difference detected";
    result.detail +=
      " These measurements do not establish equal fidelity or whether a difference is audible.";
  } else {
    const slot = result.winner === "a" ? labels.a : labels.b;
    result.headline = "File " + slot + " likely preserves more of this recording";
  }
  return result;
}

/** Measurement-only calibration seam. Product recommendations must use compareAnalyses. */
export function compareQualityMeasurements(
  a: ComparisonMetrics,
  b: ComparisonMetrics,
  labels: { a: string; b: string } = { a: "A", b: "B" },
): Omit<Comparison, "outcome" | "reasons" | "identityStatus"> {
  const cutoffDeltaHz = a.cutoffHz - b.cutoffHz;
  const absDelta = Math.abs(cutoffDeltaHz);
  const scoreDelta = a.score - b.score;
  const sameLength = Math.abs(a.durationSec - b.durationSec) < 2.5;

  // Same-song verification: cheap, done on the loudness envelopes.
  const songMatch: SongMatch | null =
    a.envelope && b.envelope ? songMatchOf(a.envelope, b.envelope) : null;
  const different = songMatch?.status === "different";
  const uncertain = songMatch?.status === "uncertain";

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
  // Two different recordings fighting for a winner is meaningless: the
  // verdict becomes a guarded tie and the copy explains why.
  if (different) winner = "tie";

  let confidence: Comparison["confidence"] = "low";
  if (absDelta >= 2500 || Math.abs(scoreDelta) >= 15) confidence = "high";
  else if (absDelta >= 800 || Math.abs(scoreDelta) >= 6) confidence = "medium";
  // Strongly contradictory evidence caps confidence: a big bandwidth gap
  // means less when the composite score firmly disagrees, and vice versa.
  if (scoreOpposes && confidence === "high") confidence = "medium";
  // Unverified identity can't be "high" confidence about *which copy* wins —
  // the user may be comparing two different songs entirely.
  if (uncertain && confidence === "high") confidence = "medium";

  const better = winner === "tie" ? a : winner === "a" ? a : b;
  const worse = winner === "tie" ? b : winner === "a" ? b : a;
  const betterSlot = winner === "b" ? labels.b : labels.a;
  const worseSlot = winner === "b" ? labels.a : labels.b;

  const fmtK = (hz: number) =>
    hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;
  const truncName = (name: string) => (name.length > 44 ? `${name.slice(0, 41)}…` : name);

  // 16-bit audio padded into a bigger lossless container: the header's bit
  // depth is real, the content is not. Only strict grid fits get flagged
  // (dithered masters read null — see bitGridCheck). Reported for both
  // sides in every verdict, tie or not: it is a fact about the file.
  const padNote = (side: ComparisonMetrics, slot: string): string => {
    const bits = side.container.bitDepth;
    const eff = side.effectiveBits;
    if (bits === null || typeof eff !== "number" || bits <= eff) return "";
    return ` File ${slot} stores ${eff}-bit audio in a ${bits}-bit ${side.container.codec} container — the extra bits carry nothing.`;
  };
  const padNotes = () => padNote(a, labels.a) + padNote(b, labels.b);

  // An unverified pairing is said out loud wherever a verdict is given.
  const identityNote = uncertain
    ? songMatch!.overlapSec < 12
      ? " The files share too little audio to confirm they are the same recording."
      : ` Their loudness contours only partly line up (${Math.round(songMatch!.correlation * 100)}%) — double-check these are the same recording.`
    : "";

  if (different) {
    const detail =
      `The loudness contours of the two files don't line up at any offset ` +
      `(best match ${Math.max(0, songMatch!.correlation * 100).toFixed(0)}%; two copies of one ` +
      `recording typically match 90%+). These are most likely different songs — or ` +
      `versions so different (live take, remix) that their quality can't be compared ` +
      `like for like — so no winner is declared.`;
    return {
      winner: "tie",
      confidence: "low",
      headline: "Hold on — these may not be the same song",
      detail,
      cutoffDeltaHz,
      sameLength,
      songMatch: songMatch!,
    };
  }

  if (winner === "tie") {
    const sourceNote =
      a.sourceLimited && b.sourceLimited
        ? " Both are flagged as source-limited by the detector; that is an estimate, not proof of their encoding history."
        : "";
    // When the ceilings visibly differ, say so with both numbers — "both
    // reach about X" is a lie the spectrogram immediately contradicts.
    let detail =
      absDelta >= 500
        ? `File ${labels.a} reaches ${fmtK(a.cutoffHz)} and File ${labels.b} ${fmtK(b.cutoffHz)}, but the experimental scores are close (${a.score.toFixed(0)} vs ${b.score.toFixed(0)}) — so these measurements do not support a preference. Trust the A/B preview below over either number.${sourceNote}`
        : `Both reach about ${fmtK(a.cutoffHz)}. Other differences may remain undetected.${sourceNote}`;
    detail += padNotes();
    detail += identityNote;
    return {
      winner,
      confidence,
      headline: "No winner — these copies are essentially the same quality",
      detail,
      cutoffDeltaHz,
      sameLength,
      songMatch: songMatch ?? undefined,
    };
  }

  // "More air kept" is only true when the winner's ceiling is meaningfully
  // higher (same 500 Hz bar as the tie text). A score-driven win over an
  // equal or higher ceiling must say why it won instead — and still name
  // both ceilings truthfully.
  const airLead = better.cutoffHz - worse.cutoffHz;
  const bandwidth =
    airLead >= 500
      ? `${fmtK(better.cutoffHz)} of estimated bandwidth versus ${fmtK(worse.cutoffHz)} — ${fmtK(airLead)} more measured high-frequency reach.`
      : `File ${betterSlot} reaches ${fmtK(better.cutoffHz)} and File ${worseSlot} ${fmtK(worse.cutoffHz)}, so bandwidth alone doesn't decide this — ` +
        (better.rolloff === "natural" && worse.rolloff !== "natural"
          ? `File ${betterSlot} ends in a clean natural rolloff where File ${worseSlot} hits ${worse.rolloff === "brickwall" ? "a brickwall low-pass" : "a steep rolloff"}, and it scores higher overall (${better.score.toFixed(0)} vs ${worse.score.toFixed(0)}).`
          : `File ${betterSlot} scores clearly higher overall (${better.score.toFixed(0)} vs ${worse.score.toFixed(0)}).`);

  const wall =
    worse.rolloff === "brickwall" && !(airLead < 500 && better.rolloff === "natural")
      ? ` File ${worseSlot} has a sharp spectral cutoff. Filtering or encoding can cause this; it does not establish source history.`
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
      ? ` The header reports ${claimed} kbps, while measured bandwidth is limited; this alone cannot establish an earlier encoding bitrate.`
      : "";

  // With verified alignment, differing lengths are just trims/different
  // masters — the offset is measured and handled, not a same-song doubt.
  const lengthNote =
    songMatch?.status === "same" && Math.abs(songMatch.lagSec) >= 1
      ? ` The copies line up ~${Math.abs(songMatch.lagSec).toFixed(1)} s apart (trimmed differently); previews and the comparison follow the same musical position.`
      : sameLength
        ? ""
        : " Lengths differ, so double-check these are the same song.";

  return {
    winner,
    confidence,
    headline: `Winner: File ${betterSlot} — “${truncName(better.fileName)}”`,
    detail: `${bandwidth}${wall}${mismatch}${padNotes()}${uncertain ? identityNote : lengthNote}`,
    cutoffDeltaHz,
    sameLength,
    songMatch: songMatch ?? undefined,
  };
}

/** The fields compareAnalyses reads. Full Analysis satisfies it; refined
 *  comparison views also pass (they patch the measured subset). */
export type ComparisonMetrics = Pick<
  Analysis,
  | "fileName"
  | "durationSec"
  | "cutoffHz"
  | "rolloff"
  | "qualityClass"
  | "score"
  | "sourceLimited"
  | "container"
  | "containerKbps"
  | "envelope"
  | "effectiveBits"
  | "comparisonCoverage"
>;

export const QUALITY_LABEL: Record<QualityClass, string> = {
  lossless: "Broad bandwidth",
  high: "Wide bandwidth",
  medium: "Moderate bandwidth",
  standard: "Limited bandwidth",
  low: "Narrow bandwidth",
  telephone: "Very narrow bandwidth",
};

export const ROLLOFF_LABEL: Record<RolloffKind, string> = {
  natural: "Natural rolloff",
  steep: "Steep rolloff",
  brickwall: "Brickwall low-pass",
};
