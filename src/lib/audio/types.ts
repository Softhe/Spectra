import type { Envelope, SongMatch } from "./align";

export type QualityClass = "lossless" | "high" | "medium" | "standard" | "low" | "telephone";

export type RolloffKind = "natural" | "brickwall" | "steep";

/** Per-factor points behind a 0–100 score (clip is ≤ 0). */
export type ScoreParts = {
  ceiling: number;
  rolloff: number;
  air: number;
  clarity: number;
  clip: number;
};

export type ContainerInfo = {
  codec: string;
  sampleRate: number | null;
  channels: number | null;
  bitDepth: number | null;
  claimedKbps: number | null;
  vbr: boolean | null;
};

export type SpectrogramData = {
  /** Row-major dB values, nFrames * nBins. Frequency 0 → maxHz. */
  frames: Float32Array;
  nFrames: number;
  nBins: number;
  maxHz: number;
  durationSec: number;
  excerptStartSec: number;
};

export type ComparisonCoverage = {
  status: "shared" | "unavailable";
  key?: string;
  windows?: number;
  measuredSec?: number;
  overlapSec?: number;
};

export type Analysis = {
  comparisonCoverage?: ComparisonCoverage;
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  objectUrl: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  container: ContainerInfo;
  /** Average bitrate from file size / duration. */
  containerKbps: number;
  cutoffHz: number;
  nyquistHz: number;
  rolloff: RolloffKind;
  brickwallHz: number | null;
  qualityClass: QualityClass;
  /** 0–100 composite. */
  score: number;
  /** Per-factor points behind `score` (for the breakdown UI). */
  scoreParts: ScoreParts;
  /** True when the ceiling reflects the music, not an encoder (caps class). */
  sourceLimited: boolean;
  /** True when a very long file was analyzed from excerpts (memory guard). */
  liteAnalysis: boolean;
  /** Sampled content hash for caching; equality does not prove full-file identity. */
  cacheKey: string | null;
  /**
   * How the decode rate came to be the one measured. Refinement passes and
   * excerpt scans re-decode and must reproduce the same rate semantics, so
   * the confirmed/guessed distinction is carried on the analysis.
   */
  decode?: { rateConfirmed: boolean; sourceRateHint: number | null };
  /** Loudness envelope (same-song verification + shared-window refinement). */
  envelope?: Envelope;
  /**
   * Effective bit depth for lossless containers: a 24-bit container whose
   * audio fits the 16-bit grid exactly reads 16. Null when undocumented
   * (lossy containers, float containers, no clean integer grid).
   */
  effectiveBits?: number | null;
  peakDb: number;
  rmsDb: number;
  crestDb: number;
  clipFraction: number;
  stereoWidth: number;
  /** Fraction of frames with audible energy in 16–20 kHz. */
  hfOccupancy: number;
  /** dB/octave of the mean spectrum from 10 to 16 kHz (or Nyquist − 100 Hz if lower). */
  hfSlope: number;
  meanDb: Float32Array;
  meanDbHzPerBin: number;
  spectrogram: SpectrogramData;
};

export type SlotId = "a" | "b" | "c" | "d";

export type Comparison = {
  outcome: "preferred" | "inconclusive" | "not-comparable";
  reasons: (
    | "bandwidth-or-score"
    | "insufficient-separation"
    | "identity-uncertain"
    | "different-recording"
    | "shared-measurement-unavailable"
  )[];
  identityStatus: "same" | "uncertain" | "different" | "unverified";
  coverage?: ComparisonCoverage;
  winner: SlotId | "tie";
  confidence: "high" | "medium" | "low";
  headline: string;
  detail: string;
  cutoffDeltaHz: number;
  sameLength: boolean;
  /**
   * Envelope-based same-song verification, present when both sides carried an
   * envelope. A "different" status turns the verdict into a guarded tie: two
   * unrelated recordings would otherwise fight over a meaningless winner.
   */
  songMatch?: SongMatch;
};
