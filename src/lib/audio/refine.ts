// Fair-comparison refinement: the base analysis judges each file over its
// own windows — with differently-trimmed copies, one file may be judged over
// its quiet lead-in while the other is judged over the loud chorus, and the
// bandwidth verdict reflects placement luck. Once every file is analyzed, this
// pass re-measures all of them over ONE shared, envelope-aligned window of the
// song: identical musical material, identical evaluation conditions.
//
// Inputs are full ready analyses; their `objectUrl` provides the bytes again
// (blob URLs live as long as the slot). Keys are analysis ids, so re-runs and
// slot swaps never invalidate a refinement. Pure per-file DSP, no UI.
import {
  CancelledError,
  classifyQuality,
  decodeNative,
  detectCutoff,
  loudFrameMask,
  meanSpectrum,
  scoreOf,
  stftPower,
  throwIfAborted,
  type DspOptions,
} from "./analyze";
import { songMatchOf, type SongMatchStatus } from "./align";
import { WavPcmSource, wavMetaFromBlob } from "./wav-source";
import type { Analysis, QualityClass, RolloffKind, ScoreParts } from "./types";

/** A file's re-measured verdict over the shared comparison window. */
export type RefinedMetrics = {
  id: string;
  cutoffHz: number;
  rolloff: RolloffKind;
  brickwallHz: number | null;
  hfOccupancy: number;
  hfSlope: number;
  qualityClass: QualityClass;
  score: number;
  scoreParts: ScoreParts;
  sourceLimited: boolean;
};

export type Refinement = {
  /** Reference file: the shared window is expressed in its time base. */
  refId: string;
  /** Window start, in reference-file seconds. */
  windowStartSec: number;
  windowSec: number;
  /** Refined verdicts keyed by analysis id (files that could not be refined absent). */
  refined: Record<string, RefinedMetrics>;
  /**
   * Per-file time offset: a musical moment at reference time t sits at
   * `t + offsetByKey[file]` in that file (0 for the reference).
   */
  offsetByKey: Record<string, number>;
  /** Envelope verification per file vs the reference. */
  alignByKey: Record<
    string,
    { status: SongMatchStatus; correlation: number; overlapSec: number }
  >;
};

/** Longest shared window worth decoding — 8 s is plenty for a stable mean. */
const WINDOW_LENGTHS = [8, 4, 2];

/**
 * Decode exactly one window of `blob` and mix to mono. WAV (any size) reads
 * only the requested frames off disk; everything else decodes the whole file
 * the same way analyze.ts does (same fallback-rate semantics, so refined and
 * base cutoffs are judged on identical terms).
 */
async function monoWindow(
  blob: Blob,
  analysis: Analysis,
  refStartSec: number,
  offset: number,
  winSec: number,
  signal?: AbortSignal,
): Promise<{ mono: Float32Array; sampleRate: number } | null> {
  const fileStart0 = refStartSec + offset;
  const wav = await wavMetaFromBlob(blob).catch(() => null);
  if (wav) {
    const source = new WavPcmSource(blob, wav);
    const totalSec = wav.frameCount / wav.sampleRate;
    const span = Math.min(winSec, totalSec);
    let start = Math.max(0, fileStart0);
    if (start + span > totalSec) start = Math.max(0, totalSec - span);
    if (totalSec - span < 1) return null;
    const sr = wav.sampleRate;
    let startFrame = Math.floor(start * sr);
    const endFrame = Math.min(
      wav.frameCount,
      Math.max(startFrame + 256, Math.floor((start + span) * sr)),
    );
    startFrame = Math.min(startFrame, endFrame - 256);
    if (startFrame < 0) return null;
    const channels = await source.sliceChannels(startFrame, endFrame);
    const len = Math.min(...channels.map((c) => c.length));
    if (len <= 0) return null;
    const mono = new Float32Array(len);
    const scale = 1 / Math.max(1, channels.length);
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (let c = 0; c < channels.length; c++) v += channels[c]![i]!;
      mono[i] = Number.isFinite(v * scale) ? v * scale : 0;
    }
    return { mono, sampleRate: sr };
  }

  // Non-WAV: decodeAudioData over the whole container (bounded by analyze.ts
  // at drop time — nothing here can exceed the decode cap).
  const bytes = await blob.arrayBuffer();
  throwIfAborted(signal);
  let buffer: AudioBuffer;
  try {
    buffer = await decodeNative(bytes, analysis.container.sampleRate);
  } catch {
    return null;
  }
  const totalSec = buffer.duration;
  const span = Math.min(winSec, totalSec);
  let start = Math.max(0, fileStart0);
  if (start + span > totalSec) start = Math.max(0, totalSec - span);
  const sr = buffer.sampleRate;
  let startFrame = Math.floor(start * sr);
  const endFrame = Math.min(
    buffer.length,
    Math.max(startFrame + 256, Math.floor((start + span) * sr)),
  );
  startFrame = Math.min(startFrame, endFrame - 256);
  if (startFrame < 0 || endFrame - startFrame < 256) return null;
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const mono = new Float32Array(endFrame - startFrame);
  const scale = 1 / Math.max(1, channels.length);
  for (let i = 0; i < mono.length; i++) {
    let v = 0;
    for (let c = 0; c < channels.length; c++) v += channels[c]![startFrame + i]!;
    mono[i] = Number.isFinite(v * scale) ? v * scale : 0;
  }
  return { mono, sampleRate: sr };
}

/** Refined verdict over one shared window, using analyze.ts's own detectors. */
async function refinedWindowMetrics(
  analysis: Analysis,
  blob: Blob,
  startSec: number,
  offset: number,
  winSec: number,
  signal?: AbortSignal,
): Promise<RefinedMetrics | null> {
  const win = await monoWindow(
    blob, analysis, startSec, offset, winSec, signal,
  );
  throwIfAborted(signal);
  if (!win || win.mono.length < 1024) return null;
  const { mono, sampleRate } = win;
  const { magDb, frameRmsDb } = await stftPower(mono, 0, mono.length, undefined, signal);
  const nBins = magDb[0]?.length ?? 0;
  if (nBins === 0) return null;
  const frameRms = Float32Array.from(frameRmsDb);
  const keep = loudFrameMask(frameRms, magDb.length);
  const meanDb = await meanSpectrum(magDb, nBins, keep, signal);
  // Rate semantics ride along from the base analysis: an unconfirmed decode
  // rate must not let a source band edge read as an encoder low-pass here
  // either (mirrors analyzeFile's dspOptions mapping).
  const decodeInfo = analysis.decode ?? { rateConfirmed: true, sourceRateHint: null };
  const options: DspOptions = decodeInfo.rateConfirmed
    ? { rateConfirmed: true }
    : { rateConfirmed: false, sourceRate: decodeInfo.sourceRateHint };
  const cut = await detectCutoff(magDb, sampleRate, meanDb, frameRms, options);
  const qualityClass = classifyQuality(
    cut.cutoffHz,
    cut.sourceNyquistHz,
    cut.rolloff,
    cut.hfOccupancy,
    { bbFlatness: cut.bbFlatness, sourceLimited: cut.sourceLimited },
  );
  const { total: score, parts: scoreParts } = scoreOf({
    cutoffHz: cut.cutoffHz,
    nyquistHz: sampleRate / 2,
    rolloff: cut.rolloff,
    hfOccupancy: cut.hfOccupancy,
    clipFraction: analysis.clipFraction,
    bbFlatness: cut.bbFlatness,
  });
  return {
    id: analysis.id,
    cutoffHz: cut.cutoffHz,
    rolloff: cut.rolloff,
    brickwallHz: cut.brickwallHz,
    hfOccupancy: cut.hfOccupancy,
    hfSlope: cut.hfSlope,
    qualityClass,
    score,
    scoreParts,
    sourceLimited: cut.sourceLimited,
  };
}

/**
 * Pick the loudest reference window that ALL files can cover given their
 * offsets: with per-file bounds [t0 + offset ≥ 0, t0 + offset + win ≤ dur],
 * the loudest surviving window wins. Returns null when no window length
 * fits every file.
 */
function pickSharedWindow(
  refEnvelope: { blockSec: number; power: Float32Array },
  candidates: { id: string; durSec: number; offset: number }[],
): { startSec: number; windowSec: number } | null {
  const blockSec = refEnvelope.blockSec;
  const blocks = refEnvelope.power.length;
  const refDur = blocks * blockSec;
  // Bounded prefix scan; the loudest mean wins inside every placement bound.
  const prefix = new Float64Array(blocks + 1);
  for (let b = 0; b < blocks; b++) {
    prefix[b + 1] = prefix[b]! + refEnvelope.power[b]!;
  }
  for (const wantSec of WINDOW_LENGTHS) {
    const windowSec = Math.min(wantSec, Math.max(2, refDur / 4));
    const winBlocks = Math.max(1, Math.round(windowSec / blockSec));
    let lo = 0;
    let hi = refDur - winBlocks * blockSec;
    for (const c of candidates) {
      // Window [t0 + offset, t0 + offset + windowSec] must sit in the file.
      lo = Math.max(lo, -c.offset);
      hi = Math.min(hi, c.durSec - winBlocks * blockSec - c.offset);
    }
    if (hi < lo) continue;
    const loB = Math.max(0, Math.floor(lo / blockSec));
    const hiB = Math.min(blocks - winBlocks, Math.ceil(hi / blockSec));
    if (hiB < loB) continue;
    let bestB = loB;
    let bestMean = -Infinity;
    for (let b = loB; b <= hiB; b++) {
      const mean = (prefix[b + winBlocks]! - prefix[b]!) / winBlocks;
      if (mean > bestMean) {
        bestMean = mean;
        bestB = b;
      }
    }
    return { startSec: bestB * blockSec, windowSec: winBlocks * blockSec };
  }
  // Shrink to a single envelope block before giving up entirely.
  let lo = 0;
  for (const c of candidates) lo = Math.max(lo, -c.offset);
  if (lo + blockSec > Math.min(refDur, Math.min(...candidates.map((c) => c.durSec - c.offset)))) {
    return null;
  }
  const oneBlock = blockSec;
  const loB = Math.max(0, Math.floor(lo / blockSec));
  let bestB = loB;
  let bestMean = -Infinity;
  for (let b = loB; b < blocks; b++) {
    if (refEnvelope.power[b]! > bestMean) {
      bestMean = refEnvelope.power[b]!;
      bestB = b;
    }
  }
  if (!Number.isFinite(bestMean)) return null;
  return { startSec: bestB * blockSec, windowSec: oneBlock };
}

/**
 * Shared-window refinement for 2–4 ready analyses. Files failing the
 * same-song check against the reference are excluded from the group (their
 * pairwise verdicts are blocked separately); one file with a broken window
 * is skipped without killing the rest. Returns null when nothing can be
 * refined — callers keep the base comparison then.
 */
export async function refineAnalyses(
  analyses: Analysis[],
  onProgress?: (phase: string, amount: number) => void,
  signal?: AbortSignal,
): Promise<Refinement | null> {
  if (analyses.length < 2 || analyses.length > 4) return null;
  if (analyses.some((x) => !x.envelope || !(x.durationSec > 0))) return null;
  throwIfAborted(signal);

  const ref = analyses[0]!;
  const entries: {
    analysis: Analysis;
    offset: number;
    status: SongMatchStatus;
    correlation: number;
    overlapSec: number;
  }[] = [{ analysis: ref, offset: 0, status: "same", correlation: 1, overlapSec: ref.durationSec }];
  for (let i = 1; i < analyses.length; i++) {
    const x = analyses[i]!;
    throwIfAborted(signal);
    onProgress?.(`Same-song check · ${x.fileName}`, 0.03 + (0.07 * i) / analyses.length);
    const m = songMatchOf(ref.envelope!, x.envelope!);
    // Offset: file time of a moment at ref time t is t + offset here, and
    // lagSec is measured A-time → B-time as bTime = aTime − lagSec.
    entries.push({
      analysis: x,
      offset: -m.lagSec,
      status: m.status,
      correlation: m.correlation,
      overlapSec: m.overlapSec,
    });
  }

  const group = entries.filter((e) => e.status === "same" || e.status === "uncertain");
  if (group.length < 2) return null;
  const ids = group.map((e) => e.analysis.id);
  const alignByKey: Refinement["alignByKey"] = {};
  const offsetByKey: Refinement["offsetByKey"] = {};
  for (const e of entries) {
    alignByKey[e.analysis.id] = {
      status: e.status,
      correlation: e.correlation,
      overlapSec: e.overlapSec,
    };
    offsetByKey[e.analysis.id] = e.offset;
  }

  onProgress?.("Choosing a shared window", 0.12);
  const placement = pickSharedWindow(
    ref.envelope!,
    group.map((e) => ({ id: e.analysis.id, durSec: e.analysis.durationSec, offset: e.offset })),
  );
  if (!placement) return null;

  const refined: Record<string, RefinedMetrics> = {};
  for (let i = 0; i < group.length; i++) {
    const e = group[i]!;
    throwIfAborted(signal);
    onProgress?.(
      `Re-measuring ${e.analysis.fileName}`,
      0.15 + (0.8 * i) / group.length,
    );
    try {
      const res = await fetch(e.analysis.objectUrl);
      if (!res.ok) continue;
      const blob = await res.blob();
      const metrics = await refinedWindowMetrics(
        e.analysis,
        blob,
        placement.startSec,
        e.offset,
        placement.windowSec,
        signal,
      );
      if (metrics) refined[e.analysis.id] = metrics;
    } catch (err) {
      // A slot cleared mid-run (or one unreadable file) must not take the
      // group down with it — a cancellation aborts everything, the rest skip.
      if (err instanceof CancelledError) throw err;
      throwIfAborted(signal);
      continue;
    }
  }
  if (Object.keys(refined).length < 2) return null;
  onProgress?.("Done", 1);
  return {
    refId: ref.id,
    windowStartSec: placement.startSec,
    windowSec: placement.windowSec,
    refined,
    offsetByKey,
    alignByKey,
  };
}
