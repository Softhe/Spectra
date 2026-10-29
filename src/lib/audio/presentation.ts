import type { Analysis, Comparison, ComparisonCoverage } from "./types";
import { formatDuration } from "./format";

export function bitrateDescription(audio: Pick<Analysis, "container">): {
  label: string;
  value: string;
} {
  const info = audio.container;
  if (/^(PCM|WAV|AIFF)$/i.test(info.codec)) {
    const rate =
      info.sampleRate && info.channels && info.bitDepth
        ? (info.sampleRate * info.channels * Math.ceil(info.bitDepth / 8) * 8) / 1000
        : null;
    return { label: "PCM data rate", value: rate ? `${Math.round(rate)} kbps` : "Not available" };
  }
  if (/FLAC|ALAC/i.test(info.codec))
    return { label: "Compressed audio bitrate", value: "Variable" };
  return {
    label: "Encoded audio bitrate",
    value: info.claimedKbps
      ? `${Math.round(info.claimedKbps)} kbps${info.vbr ? ", variable" : ""}`
      : info.vbr
        ? "Variable"
        : "Not available",
  };
}

export function coverageDescription(coverage?: ComparisonCoverage): string {
  if (
    coverage?.status !== "shared" ||
    !coverage.windows ||
    coverage.measuredSec === undefined ||
    coverage.overlapSec === undefined
  )
    return "Shared-passage measurements are not available.";
  const seconds = coverage.measuredSec ?? 0;
  const overlap = Math.round((coverage.overlapSec ?? 0) * 10) / 10;
  const duration =
    formatDuration(Math.floor(overlap)) + (overlap % 1 ? `.${Math.round((overlap % 1) * 10)}` : "");
  return `Compared ${coverage.windows} shared ${coverage.windows === 1 ? "passage" : "passages"} totaling ${seconds.toFixed(seconds % 1 ? 1 : 0)} seconds. The files overlap for ${duration}.`;
}

export function preferenceDescription(comparison: Comparison): string {
  return comparison.outcome === "preferred"
    ? `Evidence for the preference: ${comparison.confidence}. This is a heuristic rating, not a probability.`
    : comparison.outcome === "not-comparable"
      ? "No quality comparison is available for this pair."
      : comparison.reasons.includes("shared-measurement-unavailable")
        ? "No preference is shown because shared measurements are missing."
        : "The measured passages do not support a preference.";
}
