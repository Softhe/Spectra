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
