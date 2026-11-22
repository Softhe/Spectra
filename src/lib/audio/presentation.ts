import type { Analysis, Comparison, ComparisonCoverage } from "./types";
import { channelLabel, formatDuration, formatSampleRate, isLosslessCodec } from "./format";

export function bitrateDescription(audio: Pick<Analysis, "container">): {
  label: string;
  value: string;
} {
  const info = audio.container;
  if (/^(PCM(?: float)?|WAV|AIFF|CAF)$/i.test(info.codec)) {
    // Prefer the container-derived byte rate (WAV/RF64 fmt-chunk byteRate):
    // the recomputed ceil(bitDepth/8) formula overstates nothing but
    // miscomputes padded storage (20-bit content in 32-bit slots reads
    // ⅔ of the true rate). The formula is the fallback for containers
    // (AIFF, CAF lpcm) where only declared fields are known.
    const rate =
      info.claimedKbps ??
      (info.sampleRate && info.channels && info.bitDepth
        ? (info.sampleRate * info.channels * Math.ceil(info.bitDepth / 8) * 8) / 1000
        : null);
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

/** "FLAC · lossless" / "MP3 · lossy": the file's coding, as the table shows it. */
export function formatDescription(audio: Pick<Analysis, "container">): string {
  return `${audio.container.codec} · ${isLosslessCodec(audio.container.codec) ? "lossless" : "lossy"}`;
}

/**
 * The sample rate the audio was measured at. Every codec decodes at its own
 * rate, except HE-AAC whose header advertises a half-rate core while the
 * decoder outputs the full rate (see decodeRateFor), so the decode rate is
 * the honest figure.
 */
export function fileSampleRate(audio: Pick<Analysis, "sampleRate">): number {
  return audio.sampleRate;
}

type EquivalenceInput = Pick<Analysis, "container" | "sampleRate" | "channels">;

/**
 * Why the complete decoded-audio check cannot report a match for this pair,
 * decided before any file is read. Null when the check can run. The check
 * itself (equivalence-browser.ts) still validates every header; this only
 * spares the reader a run whose answer is already known.
 */
export function equivalencePrecheck(
  a: EquivalenceInput,
  b: EquivalenceInput,
  labels: { a: string; b: string },
): string | null {
  const sides = [
    [a, labels.a],
    [b, labels.b],
  ] as const;
  const lossy = sides.filter(([x]) => !isLosslessCodec(x.container.codec));
  if (lossy.length > 0) {
    const names = lossy.map(([x, slot]) => `File ${slot} (${x.container.codec})`).join(" and ");
    return `${names} ${lossy.length === 1 ? "uses" : "use"} lossy coding. A lossy copy never decodes to exactly the same samples as another copy, so this check cannot show a match.`;
  }
  const unsupported = sides.filter(([x]) => !/^(WAV|PCM|PCM float|FLAC)$/i.test(x.container.codec));
  if (unsupported.length > 0) {
    const codecs = [...new Set(unsupported.map(([x]) => x.container.codec))].join(" and ");
    return `This check reads WAV and FLAC files. ${codecs} files are not supported yet. Convert separate test copies to WAV or FLAC to compare every sample.`;
  }
  const rateA = fileSampleRate(a);
  const rateB = fileSampleRate(b);
  if (rateA !== rateB) {
    return `The copies have different sample rates (${formatSampleRate(rateA)} and ${formatSampleRate(rateB)}). Their samples cannot match without resampling, which this check does not do.`;
  }
  const chA = a.container.channels ?? a.channels;
  const chB = b.container.channels ?? b.channels;
  if (chA !== chB) {
    return `The copies have different channel layouts (${channelLabel(chA).toLowerCase()} and ${channelLabel(chB).toLowerCase()}), so their samples cannot match.`;
  }
  return null;
}
