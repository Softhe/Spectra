export type QualityClass =
  | "lossless"
  | "high"
  | "medium"
  | "standard"
  | "low"
  | "telephone";

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

export type Analysis = {
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
  peakDb: number;
  rmsDb: number;
  crestDb: number;
  clipFraction: number;
  stereoWidth: number;
  /** Fraction of frames with audible energy in 16–20 kHz. */
  hfOccupancy: number;
  /** dB/octave from 10 kHz to cutoff. */
  hfSlope: number;
  meanDb: Float32Array;
  meanDbHzPerBin: number;
  spectrogram: SpectrogramData;
};

export type SlotId = "a" | "b";

export type Comparison = {
  winner: SlotId | "tie";
  confidence: "high" | "medium" | "low";
  headline: string;
  detail: string;
  cutoffDeltaHz: number;
  sameLength: boolean;
};
