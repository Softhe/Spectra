import { bufferSource, type SliceSource } from "./source";
import { WavPcmSource, wavMetaFromBlob } from "./wav-source";
import { sniffContainer } from "./sniff";
import {
  checkCancelled,
  compareDecodedSources,
  SAMPLE_TOLERANCE,
  type EquivalenceResult,
} from "./equivalence";

type Plan = {
  file: File;
  rate: number;
  channels: number;
  frames: number;
  bytes: number;
  codec: "wav" | "flac";
  bits: number;
  open: () => Promise<SliceSource>;
};
const MIB = 1024 ** 2;

async function prepare(file: File, signal?: AbortSignal): Promise<Plan> {
  checkCancelled(signal);
  if (file.size > 1024 * MIB) throw new Error("The full-audio check supports files up to 1 GiB.");
  const wav = await wavMetaFromBlob(file);
  if (wav) {
    const expectedMask = wav.channels === 1 ? 4 : 3;
    if (wav.channelMask && wav.channelMask !== expectedMask)
      throw new Error("This WAV uses an unsupported channel layout.");
    return {
      file,
      rate: wav.sampleRate,
      channels: wav.channels,
      frames: wav.frameCount,
      bytes: 0,
      codec: "wav",
      bits: wav.bits,
      open: async () => new WavPcmSource(file, wav),
    };
  }
  if (file.size > 32 * MIB)
    throw new Error(
      "Compressed files must be at most 32 MiB for this check. WAV files are read in chunks.",
    );
  // Read STREAMINFO before decoding to bound memory and require a native rate.
  const prefix = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  let offset = 0;
  if (String.fromCharCode(...prefix.slice(0, 3)) === "ID3") {
    if (prefix.length !== 10 || prefix.slice(6, 10).some((x) => x > 127))
      throw new Error("The FLAC tag header is invalid.");
    offset = 10 + prefix.slice(6, 10).reduce((size, value) => size * 128 + value, 0);
  }
  const header = new Uint8Array(await file.slice(offset, offset + 42).arrayBuffer());
  if (
    header.length !== 42 ||
    String.fromCharCode(...header.slice(0, 4)) !== "fLaC" ||
    (header[4]! & 127) !== 0 ||
    header[5] !== 0 ||
    header[6] !== 0 ||
    header[7] !== 34
  ) {
    throw new Error("The full-audio check currently supports PCM WAV and native FLAC files.");
  }
  const info = sniffContainer(header.buffer, "audio.flac", "audio/flac");
  const rate = info.sampleRate;
  const channels = info.channels;
  const frames = (header[21]! & 15) * 4294967296 + new DataView(header.buffer).getUint32(22, false);
  if (!rate || !channels || !frames)
    throw new Error(
      "The FLAC header does not provide a sample rate, channel count and total sample count.",
    );
  const bytes = frames * channels * 4;
  const bits = info.bitDepth;
  if (!bits || bits < 16 || bits > 32)
    throw new Error("This check supports FLAC files with a bit depth from 16 to 32.");
  return {
    file,
    rate,
    channels,
    frames,
    bytes,
    codec: "flac",
    bits,
    open: async () => {
      checkCancelled(signal);
      const context = new OfflineAudioContext(channels, 1, rate);
      const buffer = await context.decodeAudioData(await file.arrayBuffer());
      checkCancelled(signal);
      if (
        buffer.sampleRate !== rate ||
        buffer.numberOfChannels !== channels ||
        buffer.length !== frames
      ) {
        throw new Error(
          "The browser decoder changed the sample rate, channel count or sample count. Equivalence was not verified.",
        );
      }
      return bufferSource(buffer);
    },
  };
}

/** This opt-in check never writes to the selected files or falls back to resampling. */
export async function verifyAudioFiles(
  a: File,
  b: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<EquivalenceResult> {
  const unavailable = (detail: string): EquivalenceResult => ({
    status: "unavailable",
    detail,
    framesCompared: 0,
    totalFrames: 0,
  });
  try {
    const plans = [await prepare(a, signal), await prepare(b, signal)];
    checkCancelled(signal);
    for (const plan of plans) {
      if (![1, 2].includes(plan.channels) || plan.frames / plan.rate > 600)
        return unavailable("This check supports mono or stereo files up to ten minutes long.");
    }
    const lowMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    const budget = lowMemory && lowMemory <= 4 ? 32 * MIB : 64 * MIB;
    if (plans.reduce((sum, plan) => sum + plan.bytes, 0) > budget)
      return unavailable(
        "The decoded audio exceeds this check's memory limit. Try shorter copies, or use PCM WAV files for chunked reading.",
      );
    const left = await plans[0]!.open();
    checkCancelled(signal);
    const right = await plans[1]!.open();
    const flac = plans.find((plan) => plan.codec === "flac");
    const tolerance =
      flac && plans.some((plan) => plan.codec === "wav")
        ? Math.max(SAMPLE_TOLERANCE, 2 ** (1 - flac.bits))
        : SAMPLE_TOLERANCE;
    return await compareDecodedSources(left, right, onProgress, signal, tolerance);
  } catch (error) {
    checkCancelled(signal);
    return unavailable(
      error instanceof DOMException
        ? "The browser could not read or decode these files. Equivalence was not verified."
        : error instanceof Error
          ? error.message
          : "The browser could not complete the audio check.",
    );
  }
}
