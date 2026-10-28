// Bounded-memory WAV reader: a big PCM file (a 24-bit vinyl rip, a split
// FLAC-to-WAV conversion, anything over the decode cap) is decoded frame range
// by frame range straight off the File/Blob — a full decodeAudioData would
// materialize the entire PCM buffer and can OOM-kill the tab. The header walk
// reads only chunk headers; payload bytes arrive per slice.
//
// Scale parity: PCM integers normalize exactly like decodeAudioData does
// (int16 / 32768, int24 / 8388608, …), so numbers from either path agree.
import type { SliceSource } from "./source";
import type { ContainerInfo } from "./types";

export type WavPcmMeta = {
  sampleRate: number;
  channels: number;
  /** Container bit depth as declared in fmt (payload bits per sample). */
  bits: number;
  /** True for fmt code 3 (IEEE float). */
  float: boolean;
  /** Byte offset of the first audio frame inside the blob. */
  dataStart: number;
  /** Bytes of audio present from dataStart (clamped to the blob). */
  dataLen: number;
  blockAlign: number;
  frameCount: number;
};

function ascii(bytes: Uint8Array, from: number, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(bytes[from + i] ?? 0);
  return out;
}

type FmtCore = { sampleRate: number; channels: number; bits: number; float: boolean };

function parseFmt(bytes: Uint8Array): FmtCore | null {
  if (bytes.length < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = view.getUint16(0, true);
  const channels = view.getUint16(2, true);
  const sampleRate = view.getUint32(4, true);
  const bits = view.getUint16(14, true);
  let float = false;
  let effectiveFormat = format;
  if (format === 0xfffe && bytes.length >= 40) {
    // WAVE_FORMAT_EXTENSIBLE: the real format is the first 2 bytes of the
    // SubFormat GUID. cbSize/validBits/channelMask are skipped.
    effectiveFormat = view.getUint16(24, true);
  }
  if (effectiveFormat === 3) float = true;
  else if (effectiveFormat !== 1) return null; // ADPCM/μ-law etc. — not our jam
  if (channels < 1 || channels > 8) return null;
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 768000) return null;
  // Mixed-in giant chunks: supported widths only. 32-bit int PCM is rare but legal.
  if (!float && ![8, 16, 20, 24, 32].includes(bits)) return null;
  if (float && bits !== 32) return null;
  return { sampleRate, channels, bits, float };
}

/**
 * Structural peek: is this blob a WAVE container we can stream from? Returns
 * quickly (a few small reads) and null for anything else — the caller then
 * falls back to the whole-arrayBuffer code path.
 */
export async function wavMetaFromBlob(blob: Blob): Promise<WavPcmMeta | null> {
  if (blob.size < 44) return null;
  const head = new Uint8Array(await blob.slice(0, 44).arrayBuffer());
  if (ascii(head, 0, 4) !== "RIFF" || ascii(head, 8, 4) !== "WAVE") return null;
  let i = 12;
  let fmt: FmtCore | null = null;
  let blockAlign = 0;
  let dataStart = -1;
  let dataLen = -1;
  // Header-only walk: per chunk, 8 bytes (enough for fmt, which is
  // always ≤ 40 bytes). An absurd number of junk chunks caps out below.
  for (let reads = 0; i + 8 <= blob.size && reads < 2048; reads++) {
    const hb = new Uint8Array(await blob.slice(i, i + 8).arrayBuffer());
    const id = ascii(hb, 0, 4);
    const size = new DataView(hb.buffer).getUint32(4, true);
    if (id === "fmt " && fmt === null) {
      const fb = new Uint8Array(await blob.slice(i + 8, Math.min(i + 8 + 40, blob.size)).arrayBuffer());
      fmt = parseFmt(fb);
      blockAlign = fb.length >= 16 ? new DataView(fb.buffer, fb.byteOffset).getUint16(12, true) : 0;
    } else if (id === "data") {
      dataStart = i + 8;
      dataLen = Math.min(size, blob.size - dataStart);
    }
    const next = i + 8 + size + (size % 2); // chunks pad to even offsets
    if (!(next > i)) break; // corrupt size — bail, trust nothing further
    i = next;
  }
  if (!fmt || dataStart < 0 || dataLen < 0) return null;
  // A zero/undersized data chunk is not analyzable audio.
  if (!blockAlign) blockAlign = (fmt.bits / 8) * fmt.channels;
  const frameCount = Math.floor(dataLen / Math.max(1, blockAlign));
  if (frameCount < 256) return null;
  return { ...fmt, dataStart, dataLen, blockAlign, frameCount };
}

/** ContainerInfo entry for the streaming path (mirrors sniff's WAV fields). */
export function wavContainerInfo(meta: WavPcmMeta, durationSec: number): ContainerInfo {
  const byteRate = meta.blockAlign * meta.sampleRate;
  const claimedKbps = durationSec > 0 ? Math.round((meta.dataLen * 8) / durationSec / 1000) : null;
  return {
    codec: meta.float ? "PCM float" : "PCM",
    sampleRate: meta.sampleRate,
    channels: meta.channels,
    bitDepth: meta.bits,
    claimedKbps: claimedKbps ?? Math.round((byteRate * 8) / 1000),
    vbr: false,
  };
}

/**
 * Slice source over a WAVE blob: `sliceChannels` decodes exactly the frames
 * asked for. One chunk is cached (blob reads can cost a real disk hit) — the
 * analysis passes always move forward, so a single-entry cache coalesces the
 * boundary reads between passes.
 */
export class WavPcmSource implements SliceSource {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  private blob: Blob;
  private meta: WavPcmMeta;

  constructor(blob: Blob, meta: WavPcmMeta) {
    this.blob = blob;
    this.meta = meta;
    this.sampleRate = meta.sampleRate;
    this.numberOfChannels = meta.channels;
    this.length = meta.frameCount;
  }

  async sliceChannels(start: number, end: number): Promise<Float32Array[]> {
    const startC = Math.max(0, Math.min(this.meta.frameCount, Math.floor(start)));
    const endC = Math.max(startC, Math.min(this.meta.frameCount, Math.ceil(end)));
    if (endC <= startC) {
      return Array.from({ length: this.meta.channels }, () => new Float32Array(0));
    }
    const bytes = await this.readFrames(startC, endC);
    return deinterleave(bytes, (endC - startC) * this.meta.channels, this.meta);
  }

  private async readFrames(startFrame: number, endFrame: number): Promise<Uint8Array> {
    const { blockAlign, dataStart } = this.meta;
    const from = dataStart + startFrame * blockAlign;
    const to = Math.min(dataStart + this.meta.dataLen, dataStart + endFrame * blockAlign);
    return new Uint8Array(await this.blob.slice(from, to).arrayBuffer());
  }
}

/** Interleaved PCM bytes → per-channel Float32, decodeAudioData-parity scaling. */
export function deinterleave(bytes: Uint8Array, nValues: number, meta: WavPcmMeta): Float32Array[] {
  const channels: Float32Array[] = [];
  const valueCount = Math.min(nValues, Math.floor(bytes.byteLength / (meta.bits / 8)));
  for (let c = 0; c < meta.channels; c++) channels.push(new Float32Array(Math.ceil(valueCount / meta.channels)));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bps = meta.bits / 8;
  const bAlign = meta.blockAlign;
  const counts = new Array(channels.length).fill(0) as number[];
  for (let idx = 0; idx < valueCount; idx++) {
    const frame = Math.floor(idx / meta.channels);
    const c = idx % meta.channels;
    const off = frame * bAlign + c * bps;
    const out = channels[c]!;
    const i = counts[c]!++;
    let v: number;
    if (meta.float) {
      v = view.getFloat32(off, true);
    } else if (bps === 1) {
      v = (view.getUint8(off) - 128) / 128;
    } else if (bps === 2) {
      v = view.getInt16(off, true) / 32768;
    } else if (bps === 3) {
      // Sign-extend the 24-bit little-endian sample.
      const u = view.getUint8(off) | (view.getUint8(off + 1) << 8) | (view.getUint8(off + 2) << 16);
      v = (u | (u & 0x800000 ? 0xff000000 : 0)) / 8388608;
    } else {
      v = view.getInt32(off, true) / 2147483648;
    }
    out[i] = v;
  }
  for (let c = 0; c < channels.length; c++) {
    channels[c] = channels[c]!.subarray(0, counts[c]!);
  }
  return channels;
}
