import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
export function createFixtures(root) {
  mkdirSync(root, { recursive: true });
  const rate = 44100,
    frames = rate * 24;
  function wav(float = false, delta = 0, sampleRate = rate, channels = 2) {
    const width = float ? 4 : 2;
    const raw = Buffer.alloc(44 + frames * channels * width);
    raw.write("RIFF", 0);
    raw.writeUInt32LE(raw.length - 8, 4);
    raw.write("WAVEfmt ", 8);
    raw.writeUInt32LE(16, 16);
    raw.writeUInt16LE(float ? 3 : 1, 20);
    raw.writeUInt16LE(channels, 22);
    raw.writeUInt32LE(sampleRate, 24);
    raw.writeUInt32LE(sampleRate * channels * width, 28);
    raw.writeUInt16LE(channels * width, 32);
    raw.writeUInt16LE(width * 8, 34);
    raw.write("data", 36);
    raw.writeUInt32LE(frames * channels * width, 40);
    for (let f = 0; f < frames; f++) {
      const t = f / rate;
      for (let c = 0; c < channels; c++) {
        let v = Math.round(
          (Math.sin(t * 2 * Math.PI * (c ? 331 : 220)) * 0.5 +
            Math.sin(t * 2 * Math.PI * 8017) * 0.1) *
            (0.5 + 0.4 * Math.sin(t * 0.97) ** 2) *
            32767,
        );
        if (float)
          raw.writeFloatLE(
            v / 32768 + (f === frames - 1 && c === channels - 1 ? delta : 0),
            44 + (f * channels + c) * width,
          );
        else
          raw.writeInt16LE(
            v + (f === frames - 1 && c === channels - 1 ? delta : 0),
            44 + (f * channels + c) * width,
          );
      }
    }
    return raw;
  }
  for (const [name, args] of [
    ["source.wav", []],
    ["changed.wav", [false, 1]],
    ["float.wav", [true]],
    ["tolerance.wav", [true, 5e-8]],
    ["rate-48k.wav", [false, 0, 48000]],
    ["mono.wav", [false, 0, rate, 1]],
  ])
    writeFileSync(root + "/" + name, wav(...args));
  execFileSync(process.env.FF || "ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-n",
    "-threads",
    "1",
    "-i",
    root + "/source.wav",
    "-c:a",
    "flac",
    "-threads",
    "1",
    root + "/source.flac",
  ]);
  const header = Buffer.alloc(42);
  header.write("fLaC", 0);
  header[4] = 128;
  header[7] = 34;
  const packed = (BigInt(rate) << 44n) | (1n << 41n) | (15n << 36n) | BigInt(rate * 600);
  header.writeBigUInt64BE(packed, 18);
  writeFileSync(root + "/oversized.flac", header);
  const original = wav();
  const metadata = Buffer.alloc(original.length + 16);
  original.copy(metadata, 0, 0, 12);
  metadata.write("JUNK", 12);
  metadata.writeUInt32LE(8, 16);
  metadata.write("testdata", 20);
  original.copy(metadata, 28, 12);
  metadata.writeUInt32LE(metadata.length - 8, 4);
  writeFileSync(root + "/metadata.wav", metadata);
  const layout = Buffer.alloc(original.length + 24);
  original.copy(layout, 0, 0, 36);
  layout.writeUInt32LE(layout.length - 8, 4);
  layout.writeUInt32LE(40, 16);
  layout.writeUInt16LE(0xfffe, 20);
  layout.writeUInt16LE(22, 36);
  layout.writeUInt16LE(16, 38);
  layout.writeUInt32LE(12, 40);
  layout.set([1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113], 44);
  original.copy(layout, 60, 36);
  writeFileSync(root + "/layout.wav", layout);
  return root;
}
