// Multi-file ranking (2–4 slots): the head-to-head verdict machinery of
// compareAnalyses powers a points table. Refined (shared-window) results
// patch the metrics they re-measured, so the leaderboard and the verdict
// panel always describe the same evidence.
import { compareAnalyses } from "./analyze";
import type { Analysis, Comparison } from "./types";
import type { RefinedMetrics } from "./refine";

/**
 * An analysis with its refined metrics substituted where available. The
 * object identity changes, so memo callers key on the analysis, not this.
 */
export function analysisWithRefined(
  a: Analysis,
  ref?: RefinedMetrics,
): Analysis {
  if (!ref) return a;
  return {
    ...a,
    cutoffHz: ref.cutoffHz,
    rolloff: ref.rolloff,
    brickwallHz: ref.brickwallHz,
    qualityClass: ref.qualityClass,
    score: ref.score,
    scoreParts: ref.scoreParts,
    sourceLimited: ref.sourceLimited,
    hfOccupancy: ref.hfOccupancy,
    hfSlope: ref.hfSlope,
  };
}

export type Ranking = {
  /** Analysis ids, best first. */
  order: string[];
  /** Head-to-head points per id (win +1, tie +0.5 each). */
  pointsById: Record<string, number>;
  /** Pair verdicts keyed `idA|idb` in the arguments' order. */
  pairwise: Record<string, Comparison>;
};

/**
 * Round-robin ranking of up to 4 files. Every pair is judged with the same
 * compareAnalyses verdict rules as the two-file headline (bandwidth margin
 * with the score veto, same-song guard), so leaderboard arithmetic never
 * disagrees with a pairwise verdict.
 */
export function rankedIds(
  files: Analysis[],
  refined?: Record<string, RefinedMetrics>,
): Ranking {
  const patched = files.map((f) => ({
    f,
    v: analysisWithRefined(f, refined?.[f.id]),
  }));
  const pairwise: Record<string, Comparison> = {};
  const pointsById: Record<string, number> = {};
  for (const p of patched) pointsById[p.f.id] = 0;
  for (let i = 0; i < patched.length; i++) {
    for (let j = i + 1; j < patched.length; j++) {
      const ci = patched[i]!;
      const cj = patched[j]!;
      const c = compareAnalyses(ci.v, cj.v);
      pairwise[`${ci.f.id}|${cj.f.id}`] = c;
      if (c.winner === "a") pointsById[ci.f.id]! += 1;
      else if (c.winner === "b") pointsById[cj.f.id]! += 1;
      else {
        pointsById[ci.f.id]! += 0.5;
        pointsById[cj.f.id]! += 0.5;
      }
    }
  }
  const order = [...patched]
    .sort(
      (x, y) =>
        pointsById[y.f.id]! - pointsById[x.f.id]! ||
        y.f.score - x.f.score ||
        y.f.cutoffHz - x.f.cutoffHz ||
        x.f.fileName.localeCompare(y.f.fileName),
    )
    .map((p) => p.f.id);
  return { order, pointsById, pairwise };
}

/**
 * The verdict for a pair in the (a, b) argument order the caller cares
 * about, from the ranking's pairwise table (which ran each pair once).
 */
export function pairComparison(
  ranking: Ranking,
  idA: string,
  idB: string,
): Comparison | null {
  if (idA === idB) return null;
  const straight = ranking.pairwise[`${idA}|${idB}`];
  if (straight) return straight;
  const flipped = ranking.pairwise[`${idB}|${idA}`];
  if (!flipped) return null;
  // Re-express the flipped verdict in the caller's orientation.
  const winner =
    flipped.winner === "a" ? "b" : flipped.winner === "b" ? "a" : "tie";
  return { ...flipped, winner };
}
