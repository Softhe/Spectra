// Same-song verification: a loudness envelope is kept for every analysis so a
// pair of files can be (1) aligned in time when one copy trims the intro and
// (2) checked for actually being the same recording before a verdict is
// rendered. Both jobs run on the envelope, never on the samples themselves, so
// this module is pure and browser-agnostic (unit-tested in align.test.ts).

export const ENVELOPE_BLOCK_SEC = 0.125;
/** dB-safe floor: blocks below this power are silence, excluded from scores. */
const EPS = 1e-12;

export type Envelope = {
  /** Seconds per block — identical for every envelope we produce. */
  blockSec: number;
  /** Mean-square (power) per block along the whole file timeline. */
  power: Float32Array;
};

/** Built from an already-materialized mono mixdown. */
export function envelopeFromMono(
  mono: Float32Array,
  sampleRate: number,
  blockSec = ENVELOPE_BLOCK_SEC,
): Envelope {
  const block = Math.max(1, Math.floor(blockSec * sampleRate));
  const nBlocks = Math.max(1, Math.ceil(mono.length / block));
  const power = new Float32Array(nBlocks);
  for (let b = 0; b < nBlocks; b++) {
    const s = b * block;
    const e = Math.min(mono.length, s + block);
    let sum = 0;
    for (let i = s; i < e; i++) sum += mono[i]! * mono[i]!;
    power[b] = sum / Math.max(1, e - s);
  }
  return { blockSec, power };
}

/** Built from a strided tap over a big buffer (≤4 samples never touched at once). */
export function envelopeFromTaps(
  length: number,
  sampleRate: number,
  tap: (i: number) => number,
  blockSec = ENVELOPE_BLOCK_SEC,
): Envelope {
  const block = Math.max(1, Math.floor(blockSec * sampleRate));
  const nBlocks = Math.max(1, Math.ceil(length / block));
  const power = new Float32Array(nBlocks);
  const stride = Math.max(1, Math.floor(sampleRate / 4000)); // ~4000 taps/sec
  for (let b = 0; b < nBlocks; b++) {
    const s = b * block;
    const e = Math.min(length, s + block);
    let sum = 0;
    let taps = 0;
    for (let i = s; i < e; i += stride) {
      const v = tap(i);
      sum += v * v;
      taps++;
    }
    power[b] = sum / Math.max(1, taps);
  }
  return { blockSec, power };
}

/**
 * Pearson correlation of two (mean-removed, non-silence-masked) amplitude
 * envelopes over every block lag in `±maxLagSec` (both envelopes must share
 * `blockSec`). Returns the best correlation and the lag that produced it.
 *
 * The scan is exhaustive at block resolution: a coarse pre-scan can step
 * over the narrow correlation peak of percussive material and settle on a
 * wrong neighbourhood. Envelopes are tiny (8 blocks/s), so this stays cheap.
 */
export function alignEnvelopes(
  a: Envelope,
  b: Envelope,
  maxLagSec = 30,
): { lagSec: number; correlation: number; overlapSec: number } {
  const bs = a.blockSec;
  const range = Math.max(1, Math.ceil(maxLagSec / bs));
  // Any true alignment of two copies keeps most of the shorter one inside
  // the longer (a trim loses seconds, an excerpt sits wholly inside). Lags
  // with a sliver of overlap only add noisy correlations that win the max
  // by chance, so they are not candidates.
  const minOverlap = Math.max(
    Math.ceil(10 / bs),
    Math.floor(0.6 * Math.min(a.power.length, b.power.length)),
  );
  let bestLag = 0;
  let best = testLag(a, b, 0, minOverlap).corr;
  for (let c = -range; c <= range; c++) {
    if (c === 0) continue;
    const r = testLag(a, b, c, minOverlap).corr;
    if (r > best) {
      best = r;
      bestLag = c;
    }
  }
  const { overlapSec } = testLag(a, b, bestLag, minOverlap);
  return { lagSec: bestLag * bs, correlation: best, overlapSec };
}

/**
 * testLag: Pearson correlation of A shifted by `lagBlocks` against B — A block
 * i lines up with B block (i - lagBlocks), so a moment at A-time t sits at
 * B-time t − lagBlocks·blockSec: lag > 0 means B starts EARLIER (B lost
 * lead-in), lag < 0 means B starts later (extra lead-in in front of it).
 * Returns the squared correlation (`corr²`) plus the overlap used; lags
 * sharing fewer than `minOverlap` blocks (default 10 s) score −1.
 */
export function testLag(
  a: Envelope,
  b: Envelope,
  lagBlocks: number,
  minOverlap = Math.ceil(10 / a.blockSec),
): { corr2: number; corr: number; overlapSec: number } {
  const iStart = Math.max(0, lagBlocks);
  const iEnd = Math.min(a.power.length, b.power.length + lagBlocks);
  const iLen = iEnd - iStart;
  if (iLen < minOverlap) return { corr2: -1, corr: -1, overlapSec: iLen * a.blockSec };
  // Mean-removed amplitude Pearson: gain differences cancel, exact silences
  // are dropped so lead-in/out padding can't dominate the score.
  let meanA = 0;
  let meanB = 0;
  let n = 0;
  for (let i = 0; i < iLen; i++) {
    const va = a.power[iStart + i]!;
    const vb = b.power[iStart + i - lagBlocks]!;
    if (va < EPS || vb < EPS) continue;
    meanA += Math.sqrt(va);
    meanB += Math.sqrt(vb);
    n++;
  }
  if (n < minOverlap * 0.5) return { corr2: -1, corr: -1, overlapSec: iLen * a.blockSec };
  meanA /= n;
  meanB /= n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < iLen; i++) {
    const va = a.power[iStart + i]!;
    const vb = b.power[iStart + i - lagBlocks]!;
    if (va < EPS || vb < EPS) continue;
    const da = Math.sqrt(va) - meanA;
    const db = Math.sqrt(vb) - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  const denom = Math.sqrt(varA * varB);
  const usable = varA > n * meanA * meanA * 1e-20 && varB > n * meanB * meanB * 1e-20;
  if (!usable) return { corr2: -1, corr: -1, overlapSec: iLen * a.blockSec };
  const r = Math.max(-1, Math.min(1, cov / denom));
  return { corr2: r * r, corr: r, overlapSec: iLen * a.blockSec };
}

export type SongMatchStatus = "same" | "uncertain" | "different";

export type SongMatch = {
  status: SongMatchStatus;
  /**
   * Alignment lag in seconds. A musical moment that sits at time t in File A
   * sits at `t − lagSec` in File B — so lagSec < 0 means File B starts later
   * (extra lead-in in front of the music). Precision is the envelope block
   * size (0.125 s) — plenty for preview seek, coarse for waveform matching
   * by design.
   */
  lagSec: number;
  /** Alignment Pearson r (−1 when there is not enough envelope to align). */
  correlation: number;
  /** Shared timeline the correlation was computed over, seconds. */
  overlapSec: number;
};

/** Time of a musical moment at `aTime` in File B, given B's lag vs A. */
export function bTimeOf(lagSec: number, aTime: number): number {
  return aTime - lagSec;
}

const SAME_CUTOFF = 0.83;
const UNCERTAIN_CUTOFF = 0.55;
const MIN_OVERLAP_SEC = 12;
/** Lag search for similar-length copies (lead-in/out trims). */
const BASE_LAG_SEC = 30;

const matchCache = new WeakMap<Envelope, WeakMap<Envelope, SongMatch>>();

/**
 * Same-song verdict for two envelopes. The correlation over the shared
 * timeline is the evidence; duration alone never decides — a 30 s store
 * preview or a truncated download is the same recording, and the lag search
 * widens by the length difference so an excerpt from mid-song still finds
 * its place. Memoized per envelope pair (verdicts re-render constantly).
 */
export function songMatchOf(a: Envelope, b: Envelope): SongMatch {
  const cached = matchCache.get(a)?.get(b);
  if (cached) return cached;
  const durDiffSec = Math.abs(a.power.length - b.power.length) * a.blockSec;
  const { lagSec, correlation, overlapSec } = alignEnvelopes(
    a,
    b,
    Math.max(BASE_LAG_SEC, durDiffSec + 5),
  );
  let status: SongMatchStatus;
  if (overlapSec < MIN_OVERLAP_SEC || correlation === -1) {
    // Too little shared timeline to verify anything — say so, without
    // claiming two 4-second clips are different songs.
    status = "uncertain";
  } else if (correlation >= SAME_CUTOFF) {
    status = "same";
  } else if (correlation >= UNCERTAIN_CUTOFF) {
    status = "uncertain";
  } else {
    status = "different";
  }
  const match: SongMatch = { status, lagSec, correlation, overlapSec };
  let inner = matchCache.get(a);
  if (!inner) {
    inner = new WeakMap();
    matchCache.set(a, inner);
  }
  inner.set(b, match);
  return match;
}

/** Sample the envelope at a fractional block position (linear between blocks). */
export function sampleEnvelope(env: Envelope, indexFloat: number): number {
  if (indexFloat <= 0) return env.power[Math.max(0, Math.round(indexFloat))] ?? 0;
  if (indexFloat >= env.power.length - 1) return env.power[env.power.length - 1] ?? 0;
  const i = Math.floor(indexFloat);
  const frac = indexFloat - i;
  return env.power[i]! * (1 - frac) + env.power[i + 1]! * frac;
}
