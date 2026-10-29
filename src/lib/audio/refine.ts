// Fair-comparison refinement. The base analysis judges each file over windows
// placed at fixed fractions of ITS OWN length. with differently-trimmed
// copies (an extra 6 s lead-in, a radio edit, a 30 s preview) the two files
// get judged on different musical material, and the bandwidth verdict reflects
// placement luck. Once every file is analyzed, this pass re-measures the group
// over the same musical windows: picked once on a reference file's envelope,
// inside the stretch every copy shares, then mapped into each file's own
// timeline through the envelope alignment.
//
// The re-measurement goes through the exact base DSP (runDspParallel over
// sliced spans, workers included), so refined and base numbers can only differ
// by WHICH audio was measured, never by how. Pure per-file DSP, no UI.
import {
  CancelledError,
  decodeNative,
  sliceMono,
  throwIfAborted,
  type DspOptions,
} from "./analyze";
import { runDspParallel } from "./dsp-client";
import { songMatchOf, type SongMatch } from "./align";
import { bufferSource, type SliceSource } from "./source";
import { WavPcmSource, wavMetaFromBlob } from "./wav-source";
import type { Analysis, QualityClass, RolloffKind, ScoreParts } from "./types";

/** A file's re-measured verdict over the shared comparison windows. */
export type RefinedMetrics = {
  id: string;
  coverage?: Analysis["comparisonCoverage"];
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

/**
 * Time alignment of a group of files against one reference. Cheap (envelope
 * math only) and independent of refinement, so A/B previews stay
 * pair-aligned even when re-measuring is skipped or fails.
 */
export type GroupAlignment = {
  refId: string;
  /**
   * A musical moment at reference time t sits at `t + offsetById[id]` in
   * that file (0 for the reference itself).
   */
  offsetById: Record<string, number>;
  /** Same-song verification of each file against the reference. */
  matchById: Record<string, SongMatch>;
};

export type Refinement = {
  refId: string;
  /** Number of shared windows measured, and their total length in seconds. */
  windows: number;
  measuredSec: number;
  overlapSec: number;
  /** Refined verdicts keyed by analysis id (files that could not be refined absent). */
  refined: Record<string, RefinedMetrics>;
};

/**
 * Choose the reference with the most confirmed ("same") matches. ties go to
 * the longest copy, whose timeline covers everyone else's. then express
 * every file's offset in its time base. With slot A holding the odd song
 * out, the other copies still align with each other instead of all being
 * dropped. Only confirmed matches count: a short excerpt can sit "uncertain"
 * against an unrelated song, and must not pull it into the group by
 * becoming the reference.
 */
export function alignGroup(analyses: Analysis[]): GroupAlignment | null {
  const withEnv = analyses.filter((x) => x.envelope && x.durationSec > 0);
  if (withEnv.length < 2) return null;
  let ref = withEnv[0]!;
  let refScore = -1;
  for (const cand of withEnv) {
    const verified = withEnv.filter(
      (o) => o !== cand && songMatchOf(cand.envelope!, o.envelope!).status === "same",
    ).length;
    if (verified > refScore || (verified === refScore && cand.durationSec > ref.durationSec)) {
      ref = cand;
      refScore = verified;
    }
  }
  const offsetById: Record<string, number> = { [ref.id]: 0 };
  const matchById: Record<string, SongMatch> = {};
  for (const x of withEnv) {
    if (x === ref) continue;
    const m = songMatchOf(ref.envelope!, x.envelope!);
    matchById[x.id] = m;
    // songMatch maps ref time → file time as t − lagSec.
    offsetById[x.id] = -m.lagSec;
  }
  return { refId: ref.id, offsetById, matchById };
}

type Span = { start: number; end: number };

/** Mirrors the base window layout (analyze.ts scanRegions), in seconds. */
function sharedWindows(
  env: { blockSec: number; power: Float32Array },
  lo: number,
  hi: number,
): Span[] {
  const span = hi - lo;
  if (span <= 8) return [{ start: lo, end: hi }];
  const win = Math.min(4, span / 3);
  const at = (f: number): Span => {
    const s = lo + Math.min(f * span, span - win);
    return { start: s, end: s + win };
  };
  if (span < 20) return [0.15, 0.5, 0.75].map(at);
  const loudness = (w: Span) => {
    const from = Math.floor(w.start / env.blockSec);
    const to = Math.min(env.power.length, Math.ceil(w.end / env.blockSec));
    let sum = 0;
    for (let b = from; b < to; b++) sum += env.power[b]!;
    return to > from ? sum / (to - from) : 0;
  };
  return [0.08, 0.24, 0.4, 0.56, 0.72, 0.86]
    .map(at)
    .sort((x, y) => loudness(y) - loudness(x))
    .slice(0, 4)
    .sort((x, y) => x.start - y.start);
}

/** Bytes → a slice source: WAV streams frames off disk, anything else decodes. */
async function openSource(analysis: Analysis, signal?: AbortSignal): Promise<SliceSource> {
  const res = await fetch(analysis.objectUrl);
  if (!res.ok) throw new Error("File no longer available.");
  const blob = await res.blob();
  throwIfAborted(signal);
  const wav = await wavMetaFromBlob(blob).catch(() => null);
  if (wav) return new WavPcmSource(blob, wav);
  // Same decode (and fallback-rate) semantics as analyzeFile; sliceMono
  // zeroes any non-finite samples a corrupt decode leaves behind.
  const buffer = await decodeNative(await blob.arrayBuffer(), analysis.container.sampleRate);
  throwIfAborted(signal);
  return bufferSource(buffer);
}

async function remeasure(
  analysis: Analysis,
  windows: Span[],
  offset: number,
  signal?: AbortSignal,
): Promise<RefinedMetrics | null> {
  const source = await openSource(analysis, signal);
  const sr = source.sampleRate;
  const regions = windows.map((w) => {
    const len = Math.round((w.end - w.start) * sr);
    const start = Math.max(0, Math.min(Math.round((w.start + offset) * sr), source.length - len));
    return { start, end: Math.min(source.length, start + len) };
  });
  if (regions.some((r) => r.end - r.start < 2048)) return null;
  const { mono, spans } = await sliceMono(source, regions, undefined, signal);
  const decode = analysis.decode ?? { rateConfirmed: true, sourceRateHint: null };
  const options: DspOptions = decode.rateConfirmed
    ? { rateConfirmed: true }
    : { rateConfirmed: false, sourceRate: decode.sourceRateHint };
  const dsp = await runDspParallel(
    mono,
    sr,
    analysis.clipFraction,
    undefined,
    spans,
    signal,
    options,
  );
  return {
    id: analysis.id,
    cutoffHz: dsp.cutoffHz,
    rolloff: dsp.rolloff,
    brickwallHz: dsp.brickwallHz,
    hfOccupancy: dsp.hfOccupancy,
    hfSlope: dsp.hfSlope,
    qualityClass: dsp.qualityClass,
    score: dsp.score,
    scoreParts: dsp.scoreParts,
    sourceLimited: dsp.sourceLimited,
  };
}

/**
 * Comparable copies need common windows: even equal-duration copies can
 * select different regions through independent loudness ranking.
 */
export function needsRefinement(analyses: Analysis[], alignment: GroupAlignment): boolean {
  return analyses.length >= 2 && analyses.some((x) => x.id === alignment.refId);
}

/**
 * Shared-window refinement for the files in `alignment` that verified as the same song. One unreadable file is skipped
 * without killing the rest. Returns null when there is nothing to gain or
 * nothing could be refined. callers must withhold a preference when common measurement is unavailable.
 */
export async function refineAnalyses(
  analyses: Analysis[],
  alignment: GroupAlignment,
  onProgress?: (phase: string, amount: number) => void,
  signal?: AbortSignal,
): Promise<Refinement | null> {
  const ref = analyses.find((x) => x.id === alignment.refId);
  if (!ref?.envelope) return null;
  const group = analyses.filter(
    (x) => x === ref || (alignment.matchById[x.id] && alignment.matchById[x.id]!.status === "same"),
  );
  if (group.length < 2 || !needsRefinement(group, alignment)) return null;
  throwIfAborted(signal);

  // The stretch of reference time every copy covers.
  let lo = 0;
  let hi = ref.durationSec;
  for (const x of group) {
    const off = alignment.offsetById[x.id] ?? 0;
    lo = Math.max(lo, -off);
    hi = Math.min(hi, x.durationSec - off);
  }
  if (hi - lo < 2) return null;
  const windows = sharedWindows(ref.envelope, lo, hi);

  const refined: Record<string, RefinedMetrics> = {};
  for (let i = 0; i < group.length; i++) {
    const x = group[i]!;
    throwIfAborted(signal);
    onProgress?.(`re-measuring ${x.fileName}`, 0.05 + (0.9 * i) / group.length);
    try {
      const metrics = await remeasure(x, windows, alignment.offsetById[x.id] ?? 0, signal);
      if (metrics)
        refined[x.id] = {
          ...metrics,
          coverage: {
            status: "shared",
            key: JSON.stringify([ref.id, group.map((f) => f.id).sort(), windows]),
            windows: windows.length,
            measuredSec: windows.reduce((n, w) => n + (w.end - w.start), 0),
            overlapSec: hi - lo,
          },
        };
    } catch (err) {
      // A slot cleared mid-run (or one unreadable file) must not take the
      // group down with it. a cancellation aborts everything, the rest skip.
      if (err instanceof CancelledError) throw err;
      throwIfAborted(signal);
    }
  }
  if (Object.keys(refined).length < 2) return null;
  onProgress?.("done", 1);
  return {
    refId: ref.id,
    windows: windows.length,
    overlapSec: hi - lo,
    measuredSec: windows.reduce((n, w) => n + (w.end - w.start), 0),
    refined,
  };
}
