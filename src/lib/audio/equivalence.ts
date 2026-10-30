import type { SliceSource } from "./source";

export const SAMPLE_TOLERANCE = 1e-7;
export type EquivalenceResult = {
  status: "exact" | "tolerance" | "different" | "unavailable";
  detail: string;
  framesCompared: number;
  totalFrames: number;
  maxDifference?: number;
  tolerance?: number;
};

export function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Audio check cancelled.", "AbortError");
}

/** Compare every channel without aligning, resampling, trimming or changing gain. */
export async function compareDecodedSources(
  a: SliceSource,
  b: SliceSource,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
  tolerance = SAMPLE_TOLERANCE,
): Promise<EquivalenceResult> {
  checkCancelled(signal);
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1 / 32768)
    throw new Error("The sample tolerance is outside the supported range.");
  const base = { framesCompared: 0, totalFrames: a.length };
  if (
    a.sampleRate !== b.sampleRate ||
    a.numberOfChannels !== b.numberOfChannels ||
    a.length !== b.length
  ) {
    return {
      ...base,
      status: "different",
      detail:
        "The sample rates, channel counts or sample counts differ. This does not select a better copy.",
    };
  }
  if (!Number.isSafeInteger(a.length) || a.length < 1 || ![1, 2].includes(a.numberOfChannels)) {
    return {
      ...base,
      status: "unavailable",
      detail: "This check supports nonempty mono and stereo audio.",
    };
  }
  let maxDifference = 0;
  for (let start = 0; start < a.length; start += 65536) {
    checkCancelled(signal);
    const end = Math.min(a.length, start + 65536);
    const left = await a.sliceChannels(start, end);
    const right = await b.sliceChannels(start, end);
    for (let channel = 0; channel < a.numberOfChannels; channel++) {
      if (left[channel]?.length !== end - start || right[channel]?.length !== end - start) {
        throw new Error("The decoder returned an incomplete audio range.");
      }
      for (let i = 0; i < end - start; i++) {
        const x = left[channel]![i]!;
        const y = right[channel]![i]!;
        if (!Number.isFinite(x) || !Number.isFinite(y))
          throw new Error("The audio contains invalid sample values.");
        maxDifference = Math.max(maxDifference, Math.abs(x - y));
      }
    }
    checkCancelled(signal);
    onProgress?.(end / a.length);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  checkCancelled(signal);
  return {
    status: maxDifference === 0 ? "exact" : maxDifference <= tolerance ? "tolerance" : "different",
    detail:
      maxDifference === 0
        ? "Every decoded sample matches in this browser, in every channel. The file bytes and metadata may differ."
        : maxDifference <= tolerance
          ? `Every decoded sample differs by at most ${tolerance} on the normalized audio scale. This is a tolerance match, not exact equality.${tolerance > SAMPLE_TOLERANCE ? " Browser FLAC and WAV decoders can use different integer scaling. The bound is one FLAC quantization step; no gain adjustment was applied." : ""}`
          : "The decoded samples differ. This check does not select a better copy or establish whether the difference is audible.",
    framesCompared: a.length,
    totalFrames: a.length,
    maxDifference,
    tolerance,
  };
}
