import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deinterleave,
  wavContainerInfo,
  wavMetaFromBlob,
  WavPcmSource,
  type WavPcmMeta,
} from "./wav-source.ts";

type WavSpec = {
  channels: number;
  sampleRate: number;
  bits: number;
  float?: boolean;
  /** Absolute sample values per channel, interleaver builds frames from these. */
  frames: number[][];
  /** Optional junk chunk before data (id, byte payload); exercises the walk. */
  junk?: { id: string; payload: Uint8Array }[];
};

/** Minimal RIFF/WAVE encoder: fmt + optional junk chunks + data. */
function buildWav(spec: WavSpec): Blob {
  const { channels, sampleRate, bits, float } = spec;
  const bps = bits / 8;
  const blockAlign = bps * channels;
  const fmtSize = 16;
  const junkBytes =
    spec.junk?.reduce((s, j) => s + 8 + j.payload.length + (j.payload.length % 2), 0) ?? 0;
  const dataSize = blockAlign * spec.frames.length;
  const size = 12 + 8 + fmtSize + junkBytes + 8 + dataSize;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, size - 8, true);
  str(8, "WAVE");
  let o = 12;
  str(o, "fmt ");
  v.setUint32(o + 4, fmtSize, true);
  v.setUint16(o + 8, float ? 3 : 1, true);
  v.setUint16(o + 10, channels, true);
  v.setUint32(o + 12, sampleRate, true);
  v.setUint32(o + 16, sampleRate * blockAlign, true);
  v.setUint16(o + 20, blockAlign, true);
  v.setUint16(o + 22, bits, true);
  o += 8 + fmtSize;
  for (const j of spec.junk ?? []) {
    str(o, j.id);
    v.setUint32(o + 4, j.payload.length, true);
    new Uint8Array(buf, o + 8, j.payload.length).set(j.payload);
    o += 8 + j.payload.length + (j.payload.length % 2);
  }
  str(o, "data");
  v.setUint32(o + 4, dataSize, true);
  const dv = new DataView(buf, o + 8, dataSize);
  for (let f = 0; f < spec.frames.length; f++) {
    for (let c = 0; c < channels; c++) {
      const x = spec.frames[f]![c] ?? 0;
      const p = (f * channels + c) * bps;
      if (float) dv.setFloat32(p, x, true);
      else if (bps === 1) dv.setUint8(p, x);
      else if (bps === 2) dv.setInt16(p, x, true);
      else if (bps === 3) {
        const u = x & 0xffffff;
        dv.setUint8(p, u & 0xff);
        dv.setUint8(p + 1, (u >> 8) & 0xff);
        dv.setUint8(p + 2, (u >> 16) & 0xff);
      } else if (bps === 4) dv.setInt32(p, x, true);
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}

const meta = (over: Partial<WavPcmMeta>): WavPcmMeta => {
  const m = {
    sampleRate: 8000,
    channels: 2,
    bits: 16,
    float: false,
    dataStart: 44,
    dataLen: 0,
    blockAlign: 4,
    frameCount: 0,
    ...over,
  };
  return { bytesPerSample: m.blockAlign / m.channels, ...m };
};

describe("deinterleave (decodeAudioData-parity scaling)", () => {
  it("20-bit declared in 3-byte slots decodes as 24-bit frames", () => {
    // 0x400000 (= 0.5 in int24 scale) left, 0xC00000 (= -0.5) right.
    const bytes = new Uint8Array([0x00, 0x00, 0x40, 0x00, 0x00, 0xc0]);
    const [l, r] = deinterleave(
      bytes,
      2,
      meta({ bits: 20, blockAlign: 6, dataLen: 6, frameCount: 1 }),
    );
    assert.equal(l[0], 0.5);
    assert.equal(r[0], -0.5);
  });

  it("int16: little-endian pairs / 32768", () => {
    const bytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0]); // 16384, -16384
    const [l, r] = deinterleave(bytes, 2, meta({ dataLen: 4, frameCount: 1 }));
    assert.equal(l[0], 0.5);
    assert.equal(r[0], -0.5);
  });

  it("int8: unsigned, centered on 128", () => {
    const bytes = new Uint8Array([128, 255]);
    const [l, r] = deinterleave(
      bytes,
      2,
      meta({ bits: 8, blockAlign: 2, dataLen: 2, frameCount: 1 }),
    );
    assert.equal(l[0], 0);
    assert.ok(Math.abs(r[0] - 127 / 128) < 1e-9);
  });

  it("int24: sign-extends below zero", () => {
    // -8388608 → 0x800000; +8388607 → 0x7fffff
    const neg = new Uint8Array([0x00, 0x00, 0x80, 0xff, 0xff, 0x7f]);
    const [l, r] = deinterleave(
      neg,
      2,
      meta({ bits: 24, blockAlign: 6, dataLen: 6, frameCount: 1 }),
    );
    assert.equal(l[0], -1);
    assert.ok(Math.abs(r[0]! - 8388607 / 8388608) < 1e-9);
  });

  it("int32: signed little-endian / 2^31", () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0xc0]); // 2^30, -2^30
    const [l, r] = deinterleave(
      bytes,
      2,
      meta({ bits: 32, blockAlign: 8, dataLen: 8, frameCount: 1 }),
    );
    assert.equal(l[0], 0.5);
    assert.equal(r[0], -0.5);
  });

  it("float32 passes values through", () => {
    const bytes = new Uint8Array(8);
    const dv = new DataView(bytes.buffer);
    dv.setFloat32(0, 0.25, true);
    dv.setFloat32(4, -0.75, true);
    const [l, r] = deinterleave(
      bytes,
      2,
      meta({ bits: 32, float: true, blockAlign: 8, dataLen: 8, frameCount: 1 }),
    );
    assert.equal(l[0], 0.25);
    assert.equal(r[0], -0.75);
  });

  it("clips the output to the bytes actually provided", () => {
    const bytes = new Uint8Array(new Int16Array([100, -100]).buffer);
    const [l, r] = deinterleave(bytes, 4, meta({ dataLen: 4, frameCount: 1 }));
    assert.equal(l.length, 1);
    assert.equal(r.length, 1);
  });
});

describe("wavMetaFromBlob header walk", () => {
  it("parses a canonical 16-bit stereo WAV", async () => {
    const frames: number[][] = [];
    for (let f = 0; f < 512; f++) frames.push(f < 2 ? [16384, -16384] : [0, 0]);
    const blob = buildWav({ channels: 2, sampleRate: 44100, bits: 16, frames });
    const m = await wavMetaFromBlob(blob);
    assert.ok(m);
    assert.equal(m.sampleRate, 44100);
    assert.equal(m.channels, 2);
    assert.equal(m.bits, 16);
    assert.equal(m.float, false);
    assert.equal(m.dataStart, 44);
    assert.equal(m.dataLen, 512 * 4);
    assert.equal(m.frameCount, 512);
  });

  it("walks junk chunks and pads odd sizes", async () => {
    const junk = { id: "LIST", payload: new Uint8Array(5).fill(0x49) }; // odd size
    const frames: number[][] = [];
    for (let f = 0; f < 512; f++) frames.push([1000]);
    const blob = buildWav({
      channels: 1,
      sampleRate: 8000,
      bits: 16,
      frames,
      junk: [junk],
    });
    const m = await wavMetaFromBlob(blob);
    assert.ok(m);
    // 12 + 8 + 16 + (8 + 5 + 1) + 8 = 58
    assert.equal(m.dataStart, 58);
    assert.equal(m.frameCount, 512);
  });

  it("reads float32 WAVs and marks them float", async () => {
    const frames: number[][] = [];
    for (let f = 0; f < 512; f++) frames.push(f < 2 ? [0.5] : f === 2 ? [-0.25] : [0]);
    const blob = buildWav({
      channels: 1,
      sampleRate: 48000,
      bits: 32,
      float: true,
      frames,
    });
    const m = await wavMetaFromBlob(blob);
    assert.ok(m);
    assert.equal(m.float, true);
    assert.equal(m.bits, 32);
    assert.equal(m.frameCount, 512);
  });

  it("clamps a truncated data chunk to the real bytes", async () => {
    // 512 real frames, declared as 1024; file cut off after 300.
    const frames: number[][] = [];
    for (let f = 0; f < 512; f++) frames.push([f]);
    const blob = buildWav({
      channels: 1,
      sampleRate: 8000,
      bits: 16,
      frames,
    });
    const full = await blob.arrayBuffer();
    const fakeSize = 1024 * 2; // claims 1024 frames
    const dv = new DataView(full);
    dv.setUint32(40, fakeSize, true); // data chunk size (no junk chunks)
    const truncated = full.slice(0, 44 + 300 * 2);
    const m = await wavMetaFromBlob(new Blob([truncated]));
    assert.ok(m);
    assert.equal(m.dataLen, 300 * 2);
    assert.equal(m.frameCount, 300);
  });

  it("returns null for non-WAV and degenerate files", async () => {
    assert.equal(await wavMetaFromBlob(new Blob([new Uint8Array(32)])), null);
    assert.equal(await wavMetaFromBlob(new Blob([new Uint8Array(2)])), null);
    const notWav = new Uint8Array(64).fill(0x41);
    assert.equal(await wavMetaFromBlob(new Blob([notWav])), null);
  });
});

describe("WavPcmSource sliceChannels", () => {
  it("reads exactly the requested frame range, scaled to float", async () => {
    const frames: number[][] = [];
    for (let f = 0; f < 512; f++) frames.push([f % 100, (f * 2) % 100]);
    const blob = buildWav({ channels: 2, sampleRate: 8000, bits: 16, frames });
    const m = await wavMetaFromBlob(blob);
    assert.ok(m);
    const src = new WavPcmSource(blob, m);
    assert.equal(src.length, 512);
    assert.equal(src.numberOfChannels, 2);
    const slice = await src.sliceChannels(100, 104);
    assert.equal(slice[0]![0], (frames[100]![0] as number) / 32768);
    assert.equal(slice[1]![3], frames[103]![1]! / 32768);
  });

  it("clamps out-of-range slices and yields empty for an empty range", async () => {
    const frames: number[][] = [];
    for (let f = 0; f < 300; f++) frames.push([f]);
    const blob = buildWav({ channels: 1, sampleRate: 8000, bits: 16, frames });
    const m = (await wavMetaFromBlob(blob))!;
    const src = new WavPcmSource(blob, m);
    const tail = await src.sliceChannels(290, 400);
    assert.equal(tail[0]!.length, 10);
    const empty = await src.sliceChannels(200, 200);
    assert.equal(empty[0]!.length, 0);
  });
});

describe("wavContainerInfo", () => {
  it("reports codec, depth and computed bitrate", () => {
    const m = meta({
      sampleRate: 48000,
      channels: 2,
      bits: 24,
      float: false,
      blockAlign: 6,
      dataLen: 48000 * 6, // exactly 1 s
      frameCount: 48000,
    });
    const info = wavContainerInfo(m, 1);
    assert.equal(info.codec, "PCM");
    assert.equal(info.sampleRate, 48000);
    assert.equal(info.channels, 2);
    assert.equal(info.bitDepth, 24);
    assert.equal(info.claimedKbps, Math.round((48000 * 6 * 8) / 1 / 1000)); // 2304
    assert.equal(info.vbr, false);
  });
});

describe("wavMetaFromBlob · RF64 and 20-bit headers", () => {
  it("uses ds64 for a 5 GiB payload without allocating the payload", async () => {
    const header = new Uint8Array(80);
    const v = new DataView(header.buffer);
    const str = (at: number, value: string) => header.set(new TextEncoder().encode(value), at);
    str(0, "RF64");
    v.setUint32(4, 0xffffffff, true);
    str(8, "WAVEds64");
    v.setUint32(16, 28, true);
    const bytes = 5 * 1024 ** 3;
    v.setBigUint64(20, BigInt(bytes + 72), true);
    v.setBigUint64(28, BigInt(bytes), true);
    v.setBigUint64(36, BigInt(bytes / 4), true);
    str(48, "fmt ");
    v.setUint32(52, 16, true);
    v.setUint16(56, 1, true);
    v.setUint16(58, 2, true);
    v.setUint32(60, 48000, true);
    v.setUint32(64, 192000, true);
    v.setUint16(68, 4, true);
    v.setUint16(70, 16, true);
    str(72, "data");
    v.setUint32(76, 0xffffffff, true);
    const blob = {
      size: bytes + 80,
      slice: (start: number, end: number) => new Blob([header.slice(start, end)]),
    } as Blob;
    const parsed = await wavMetaFromBlob(blob);
    assert.equal(parsed?.dataLen, bytes);
    assert.equal(parsed?.frameCount, bytes / 4);
    // Unsafe lengths must never silently lose precision.
    v.setBigUint64(28, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true);
    assert.equal(await wavMetaFromBlob(blob), null);
  });
  it("rejects an RF64 data sentinel without ds64", async () => {
    const frames: number[][] = Array.from({ length: 1000 }, () => [100, -100]);
    const wav = new Uint8Array(
      await buildWav({ channels: 2, sampleRate: 44100, bits: 16, frames }).arrayBuffer(),
    );
    const dv = new DataView(wav.buffer);
    wav.set([0x52, 0x46, 0x36, 0x34], 0); // "RF64"
    dv.setUint32(40, 0xffffffff, true); // data chunk size sentinel
    const m = await wavMetaFromBlob(new Blob([wav]));
    assert.equal(m, null);
  });

  it("derives a 3-byte sample width when fmt declares 20 bits", async () => {
    const wav = new Uint8Array(
      await buildWav({
        channels: 2,
        sampleRate: 44100,
        bits: 24,
        frames: Array.from({ length: 1000 }, () => [1, -1]),
      }).arrayBuffer(),
    );
    new DataView(wav.buffer).setUint16(34, 20, true); // wBitsPerSample = 20
    const m = await wavMetaFromBlob(new Blob([wav]));
    assert.ok(m);
    assert.equal(m.bits, 20);
    assert.equal(m.bytesPerSample, 3);
  });
});
