import assert from "node:assert/strict";
import { it } from "node:test";
import { bitrateDescription, coverageDescription } from "./presentation.ts";
import type { ContainerInfo } from "./types.ts";

const container: ContainerInfo = {
  codec: "PCM",
  sampleRate: 44100,
  channels: 2,
  bitDepth: 16,
  claimedKbps: null,
  vbr: false,
};
it("separates PCM data rate, compressed lossless rate and encoded MP3 rate", () => {
  assert.deepEqual(bitrateDescription({ container }), {
    label: "PCM data rate",
    value: "1411 kbps",
  });
  assert.deepEqual(
    bitrateDescription({ container: { ...container, codec: "PCM float", bitDepth: 32 } }),
    {
      label: "PCM data rate",
      value: "2822 kbps",
    },
  );
  assert.deepEqual(bitrateDescription({ container: { ...container, codec: "FLAC" } }), {
    label: "Compressed audio bitrate",
    value: "Variable",
  });
  assert.deepEqual(
    bitrateDescription({ container: { ...container, codec: "MP3", claimedKbps: 128 } }),
    { label: "Encoded audio bitrate", value: "128 kbps" },
  );
  assert.equal(
    bitrateDescription({ container: { ...container, sampleRate: null } }).value,
    "Not available",
  );
  assert.equal(
    bitrateDescription({ container: { ...container, bitDepth: 20 } }).value,
    "2117 kbps",
  );
});
it("distinguishes analyzed duration from overlap", () => {
  assert.equal(
    coverageDescription({ status: "shared", windows: 4, measuredSec: 16, overlapSec: 105.5 }),
    "Compared 4 shared passages totaling 16 seconds. The files overlap for 1:45.5.",
  );
});

it("explains up front why the identical-audio check cannot match", async () => {
  const { equivalencePrecheck, formatDescription } = await import("./presentation.ts");
  const file = (codec: string, sampleRate = 44100, channels = 2) => ({
    container: { ...container, codec, sampleRate, channels },
    sampleRate,
    channels,
  });
  const labels = { a: "A", b: "B" };
  assert.equal(equivalencePrecheck(file("FLAC"), file("PCM"), labels), null);
  assert.match(
    equivalencePrecheck(file("FLAC"), file("MP3"), labels) ?? "",
    /File B \(MP3\) uses lossy coding/,
  );
  assert.match(
    equivalencePrecheck(file("AAC"), file("Opus"), labels) ?? "",
    /File A \(AAC\) and File B \(Opus\) use lossy/,
  );
  assert.match(
    equivalencePrecheck(file("FLAC", 96000), file("FLAC"), labels) ?? "",
    /different sample rates \(96 kHz and 44\.1 kHz\)/,
  );
  assert.match(
    equivalencePrecheck(file("PCM", 44100, 1), file("PCM"), labels) ?? "",
    /different channel layouts \(mono and stereo\)/,
  );
  assert.match(equivalencePrecheck(file("AIFF"), file("FLAC"), labels) ?? "", /AIFF files are not/);
  assert.equal(formatDescription(file("FLAC")), "FLAC · lossless");
  assert.equal(formatDescription(file("MP3")), "MP3 · lossy");
  assert.equal(formatDescription(file("WAV")), "WAV · coding not identified");
});

it("reports the file's own sample rate, not a browser fallback decode rate", async () => {
  const { fileSampleRate, sampleRateText } = await import("./presentation.ts");
  const at = (declared: number | null, decoded: number, codec = "FLAC") => ({
    container: { ...container, codec, sampleRate: declared },
    sampleRate: decoded,
  });
  assert.equal(fileSampleRate(at(192000, 48000)), 192000);
  assert.equal(fileSampleRate(at(null, 48000)), 48000);
  // An AAC header declaring 24 kHz stays 24 kHz; the decode rate is shown beside it.
  assert.equal(fileSampleRate(at(24000, 48000, "AAC")), 24000);
  assert.equal(sampleRateText(at(24000, 48000, "AAC")), "24 kHz (decoded at 48 kHz)");
  assert.equal(sampleRateText(at(44100, 44100)), "44.1 kHz");
});

it("spaces frequency ticks for CD and hi-res axes", async () => {
  const { frequencyTicksKHz } = await import("./format.ts");
  assert.deepEqual(frequencyTicksKHz(22050), [5, 10, 15, 20]);
  assert.deepEqual(frequencyTicksKHz(24000), [5, 10, 15, 20]);
  assert.deepEqual(frequencyTicksKHz(48000), [10, 20, 30, 40]);
});
