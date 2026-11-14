// Headless group comparison: the same analysis → alignment → shared-window
// refinement → ranking → verdict sequence the analyzer UI runs, for callers
// that already hold decoded PCM (the command-line tool and its HTTP server).
// No browser or Node APIs: the caller decodes and hashes.
import {
  analyzeDecodedAudio,
  CancelledError,
  compareAnalyses,
  throwIfAborted,
  type DecodedFileInfo,
} from "./analyze";
import { compareDecodedSources, type EquivalenceResult } from "./equivalence";
import { analysisWithRefined, pairComparison, rankedIds } from "./rank";
import { alignGroup, refineAnalyses, type RefinedMetrics } from "./refine";
import { bufferSource } from "./source";
import type { Analysis, Comparison, QualityClass, RolloffKind, SlotId } from "./types";

export const MAX_GROUP_FILES = 4;
const LABELS = ["A", "B", "C", "D"] as const;

export type GroupInput = {
  info: DecodedFileInfo;
  /** Decoded PCM; only AudioBuffer's read members are used. */
  audio: AudioBuffer;
  /** Full-file SHA-256 (hex) when the caller computed one. */
  sha256?: string | null;
};

export type Measurement = {
  qualityClass: QualityClass;
  cutoffHz: number;
  rolloff: RolloffKind;
  brickwallHz: number | null;
  score: number;
  sourceLimited: boolean;
  hfOccupancy: number;
};

export type FileReport = {
  label: string;
  fileName: string;
  bytes: number;
  sha256: string | null;
  codec: string;
  containerSampleRate: number | null;
  decodedSampleRate: number;
  /** False when the decode rate differs from the container's (resampled). */
  rateConfirmed: boolean;
  channels: number;
  bitDepth: number | null;
  effectiveBits: number | null;
  claimedKbps: number | null;
  averageKbps: number;
  vbr: boolean | null;
  durationSec: number;
  liteAnalysis: boolean;
  peakDb: number;
  rmsDb: number;
  crestDb: number;
  clipFraction: number;
  stereoWidth: number;
  /** Whole-file measurement over the file's own windows. */
  base: Measurement;
  /** Shared-passage re-measurement used for the verdict; null when unavailable. */
  shared: Measurement | null;
  /** 1-based rank among comparable copies; null for files that were not ranked. */
  rank: number | null;
  points: number;
  /** True when the file was excluded from ranking (different or unverified recording). */
  unranked: boolean;
};

export type IdentityCheck = {
  /** Byte-identical files (full SHA-256 match). */
  bytes: boolean;
  /** Complete decoded-sample comparison; null when it was skipped. */
  decoded: EquivalenceResult | null;
};

export type PairReport = {
  a: string;
  b: string;
  identity: IdentityCheck;
  outcome: Comparison["outcome"];
  reasons: Comparison["reasons"];
  recordingMatch: Comparison["identityStatus"];
  /** Label of the file that likely preserves more, or null. */
  preferred: string | null;
  evidence: Comparison["confidence"];
  headline: string;
  detail: string;
  cutoffDeltaHz: number;
  lagSec: number | null;
  correlation: number | null;
};

export type Recommendation = {
  /**
   * identical-bytes: every file has the same bytes.
   * identical-audio: every file decodes to the same samples (containers/tags differ).
   * preferred: one file likely preserves more than every other comparable copy.
   * inconclusive: comparable copies without a clear preference.
   * not-comparable: the recordings may differ or could not be verified.
   */
  status: "identical-bytes" | "identical-audio" | "preferred" | "inconclusive" | "not-comparable";
  /** Label of the file to keep for `preferred`; null otherwise (the caller's policy decides). */
  keep: string | null;
  summary: string;
};

export type GroupReport = {
  files: FileReport[];
  pairs: PairReport[];
  sharedPassages: { windows: number; measuredSec: number; overlapSec: number } | null;
  recommendation: Recommendation;
};

export type CompareGroupOptions = {
  onProgress?: (phase: string, amount: number) => void;
  signal?: AbortSignal;
  /** Compare every decoded sample of same-shaped pairs (default true). */
  checkDecodedEquivalence?: boolean;
};

function measurement(x: Analysis | RefinedMetrics): Measurement {
  return {
    qualityClass: x.qualityClass,
    cutoffHz: x.cutoffHz,
    rolloff: x.rolloff,
    brickwallHz: x.brickwallHz,
    score: x.score,
    sourceLimited: x.sourceLimited,
    hfOccupancy: x.hfOccupancy,
  };
}

function hasNonFinite(audio: AudioBuffer): boolean {
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i]!)) return true;
  }
  return false;
}

function slotLabel(slot: SlotId | "tie", a: string, b: string): string | null {
  return slot === "a" ? a : slot === "b" ? b : null;
}

/** Analyze 2–4 decoded copies and judge them with the analyzer's own rules. */
export async function compareGroup(
  inputs: GroupInput[],
  options: CompareGroupOptions = {},
): Promise<GroupReport> {
  const { onProgress, signal, checkDecodedEquivalence = true } = options;
  if (inputs.length < 2 || inputs.length > MAX_GROUP_FILES) {
    throw new Error(`Compare between 2 and ${MAX_GROUP_FILES} files.`);
  }

  // Analysis zeroes NaN/±Infinity samples in place, so check for them first:
  // a decoded-equality verdict on sanitized PCM could call different inputs exact.
  const hadNonFinite = inputs.map((input) => checkDecodedEquivalence && hasNonFinite(input.audio));

  const analyses: Analysis[] = [];
  for (let i = 0; i < inputs.length; i++) {
    throwIfAborted(signal);
    const input = inputs[i]!;
    analyses.push(
      await analyzeDecodedAudio(
        input.audio,
        input.info,
        (phase, amount) => onProgress?.(`${LABELS[i]}: ${phase}`, amount),
        signal,
      ),
    );
  }
  const audioById = new Map(analyses.map((a, i) => [a.id, inputs[i]!.audio]));
  const labelById = new Map(analyses.map((a, i) => [a.id, LABELS[i]!]));

  // Alignment, refinement and ranking exactly as the analyzer component runs them.
  const alignment = alignGroup(analyses);
  let refinement: Awaited<ReturnType<typeof refineAnalyses>> = null;
  if (alignment) {
    try {
      refinement = await refineAnalyses(
        analyses,
        alignment,
        (phase, amount) => onProgress?.(`refine: ${phase}`, amount),
        signal,
        async (analysis) => bufferSource(audioById.get(analysis.id)!),
      );
    } catch (err) {
      // The UI keeps going without shared measurements; preferences are then withheld.
      if (err instanceof CancelledError) throw err;
      refinement = null;
    }
  }
  const outsiders = new Set(
    Object.entries(alignment?.matchById ?? {})
      .filter(([, m]) => m.status !== "same")
      .map(([id]) => id),
  );
  const ranking = rankedIds(analyses, refinement?.refined, outsiders, true);
  const display = new Map(
    analyses.map((a) => [a.id, analysisWithRefined(a, refinement?.refined[a.id], true)]),
  );

  const pairs: PairReport[] = [];
  for (let i = 0; i < analyses.length; i++) {
    for (let j = i + 1; j < analyses.length; j++) {
      throwIfAborted(signal);
      const x = analyses[i]!;
      const y = analyses[j]!;
      const la = labelById.get(x.id)!;
      const lb = labelById.get(y.id)!;
      const verdict = compareAnalyses(display.get(x.id)!, display.get(y.id)!, { a: la, b: lb });
      const ha = inputs[i]!.sha256;
      const hb = inputs[j]!.sha256;
      const bytes = !!ha && !!hb && ha === hb;
      let decoded: EquivalenceResult | null = null;
      // Only meaningful for native-rate decodes: a resampled decode is not the file's own audio.
      const native = x.decode?.rateConfirmed !== false && y.decode?.rateConfirmed !== false;
      if (checkDecodedEquivalence && !bytes && native && (hadNonFinite[i] || hadNonFinite[j])) {
        decoded = {
          status: "unavailable",
          detail:
            "At least one file decoded to non-finite samples, so exact sample equality cannot be confirmed.",
          framesCompared: 0,
          totalFrames: 0,
        };
      } else if (checkDecodedEquivalence && !bytes && native) {
        decoded = await compareDecodedSources(
          bufferSource(audioById.get(x.id)!),
          bufferSource(audioById.get(y.id)!),
          undefined,
          signal,
        ).catch((err: unknown) => {
          // Cancellation must stop the comparison, not become an "unavailable" pair.
          throwIfAborted(signal);
          return {
            status: "unavailable" as const,
            detail: err instanceof Error ? err.message : "The decoded comparison failed.",
            framesCompared: 0,
            totalFrames: 0,
          };
        });
        // The shared messages are written for the browser; name the decoder generically.
        decoded = {
          ...decoded,
          detail: decoded.detail.replace("in this browser", "with this decoder"),
        };
      }
      pairs.push({
        a: la,
        b: lb,
        identity: { bytes, decoded },
        outcome: verdict.outcome,
        reasons: verdict.reasons,
        recordingMatch: verdict.identityStatus,
        preferred: verdict.outcome === "preferred" ? slotLabel(verdict.winner, la, lb) : null,
        evidence: verdict.confidence,
        headline: verdict.headline,
        detail: verdict.detail,
        cutoffDeltaHz: verdict.cutoffDeltaHz,
        lagSec: verdict.songMatch?.lagSec ?? null,
        correlation: verdict.songMatch?.correlation ?? null,
      });
    }
  }

  const files: FileReport[] = analyses.map((a, i) => {
    const refined = refinement?.refined[a.id];
    const unranked = ranking.outsiders.has(a.id);
    return {
      label: LABELS[i]!,
      fileName: a.fileName,
      bytes: a.fileSize,
      sha256: inputs[i]!.sha256 ?? null,
      codec: a.container.codec,
      containerSampleRate: a.decode?.sourceRateHint ?? null,
      decodedSampleRate: a.sampleRate,
      rateConfirmed: a.decode?.rateConfirmed ?? true,
      channels: a.channels,
      bitDepth: a.container.bitDepth,
      effectiveBits: a.effectiveBits ?? null,
      claimedKbps: a.container.claimedKbps,
      averageKbps: a.containerKbps,
      vbr: a.container.vbr,
      durationSec: a.durationSec,
      liteAnalysis: a.liteAnalysis,
      peakDb: a.peakDb,
      rmsDb: a.rmsDb,
      crestDb: a.crestDb,
      clipFraction: a.clipFraction,
      stereoWidth: a.stereoWidth,
      base: measurement(a),
      shared: refined ? measurement(refined) : null,
      rank: unranked
        ? null
        : ranking.order.filter((id) => !ranking.outsiders.has(id)).indexOf(a.id) + 1,
      points: ranking.pointsById[a.id] ?? 0,
      unranked,
    };
  });

  return {
    files,
    pairs,
    sharedPassages: refinement
      ? {
          windows: refinement.windows,
          measuredSec: refinement.measuredSec,
          overlapSec: refinement.overlapSec,
        }
      : null,
    recommendation: recommend(analyses, pairs, ranking, labelById),
  };
}

function recommend(
  analyses: Analysis[],
  pairs: PairReport[],
  ranking: ReturnType<typeof rankedIds>,
  labelById: Map<string, string>,
): Recommendation {
  if (pairs.every((p) => p.identity.bytes)) {
    return {
      status: "identical-bytes",
      keep: null,
      summary: "Every file has identical bytes. Keeping one copy loses nothing.",
    };
  }
  const sameAudio = (p: PairReport) => p.identity.bytes || p.identity.decoded?.status === "exact";
  if (pairs.every(sameAudio)) {
    return {
      status: "identical-audio",
      keep: null,
      summary:
        "Every file decodes to exactly the same samples. Containers, tags or metadata may differ, so choose by format or tags rather than audio quality.",
    };
  }
  const leader = ranking.order[0];
  if (!leader || ranking.outsiders.has(leader)) {
    // Ranking also marks verified copies as outsiders when their shared-passage
    // measurement failed; that is a missing measurement, not a different recording.
    // Any pair that is itself not comparable keeps the stricter verdict below.
    if (
      pairs.every((p) => p.outcome !== "not-comparable") &&
      pairs.some((p) => p.reasons.includes("shared-measurement-unavailable"))
    ) {
      return {
        status: "inconclusive",
        keep: null,
        summary:
          "The copies could not be measured over the same passages, so no copy is recommended. This does not establish equal fidelity.",
      };
    }
    return {
      status: "not-comparable",
      keep: null,
      summary:
        "The files could not be verified as copies of the same recording, so no copy is recommended.",
    };
  }
  const leaderLabel = labelById.get(leader)!;
  const others = analyses.filter((a) => a.id !== leader && !ranking.outsiders.has(a.id));
  const beatsAll =
    others.length > 0 &&
    others.length === analyses.length - 1 &&
    others.every((o) => {
      const c = pairComparison(ranking, leader, o.id);
      return c?.outcome === "preferred" && c.winner === "a";
    });
  if (beatsAll) {
    return {
      status: "preferred",
      keep: leaderLabel,
      summary: `File ${leaderLabel} likely preserves more of this recording than every other copy.`,
    };
  }
  const anyComparable = pairs.some((p) => p.outcome !== "not-comparable");
  return anyComparable
    ? {
        status: "inconclusive",
        keep: null,
        summary:
          "No copy is clearly better than all the others. These measurements do not establish equal fidelity.",
      }
    : {
        status: "not-comparable",
        keep: null,
        summary:
          "The files could not be verified as copies of the same recording, so no copy is recommended.",
      };
}
