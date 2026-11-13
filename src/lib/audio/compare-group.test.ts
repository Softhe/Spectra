import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareGroup, type GroupInput } from "./compare-group.ts";

const SR = 44100;

/** Deterministic harmonic + noise signal with a song-like loudness envelope. */
function render(seconds: number, seed: number, envelopeRate: number): Float32Array[] {
  let s = seed | 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = Math.round(seconds * SR);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  let pink = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = 0.35 + 0.3 * Math.sin(2 * Math.PI * envelopeRate * t) * Math.sin(0.7 * t + seed);
    pink = 0.97 * pink + 0.03 * (rnd() * 2 - 1);
    let v = pink * 2;
    for (const f of [110, 220, 440, 880, 1760, 3520, 7040])
      v += 0.05 * Math.sin(2 * Math.PI * f * t);
    left[i] = env * v * 0.6;
    right[i] = env * (v * 0.55 + 0.05 * (rnd() * 2 - 1));
  }
  return [left, right];
}

function input(name: string, channels: Float32Array[], sha256: string | null): GroupInput {
  const length = channels[0]!.length;
  const audio = {
    sampleRate: SR,
    length,
    numberOfChannels: channels.length,
    duration: length / SR,
    getChannelData: (c: number) => channels[c]!,
  } as unknown as AudioBuffer;
  return {
    sha256,
    audio,
    info: {
      fileName: name,
      fileSize: length * 4,
      mimeType: "",
      objectUrl: "",
      container: {
        codec: "FLAC",
        sampleRate: SR,
        channels: channels.length,
        bitDepth: 16,
        claimedKbps: null,
        vbr: null,
      },
      cacheKey: null,
    },
  };
}

const copy = (channels: Float32Array[]) => channels.map((c) => c.slice());

describe("headless group comparison", () => {
  it("rejects fewer than two or more than four files", async () => {
    const one = input("a.flac", render(1, 1, 0.3), "x");
    await assert.rejects(compareGroup([one]), /between 2 and 4/);
    await assert.rejects(compareGroup([one, one, one, one, one]), /between 2 and 4/);
  });

  it("reports byte-identical files without inventing a quality preference", async () => {
    const pcm = render(12, 7, 0.31);
    const report = await compareGroup([
      input("a.flac", pcm, "same"),
      input("b.flac", copy(pcm), "same"),
    ]);
    assert.equal(report.recommendation.status, "identical-bytes");
    assert.equal(report.recommendation.keep, null);
    assert.equal(report.pairs[0]!.identity.bytes, true);
    assert.equal(report.pairs[0]!.identity.decoded, null);
  });

  it("separates identical decoded audio from identical bytes", async () => {
    const pcm = render(12, 7, 0.31);
    const report = await compareGroup([
      input("a.flac", pcm, "hash-a"),
      input("a.wav", copy(pcm), "hash-b"),
    ]);
    assert.equal(report.pairs[0]!.identity.bytes, false);
    assert.equal(report.pairs[0]!.identity.decoded?.status, "exact");
    assert.doesNotMatch(report.pairs[0]!.identity.decoded!.detail, /browser/);
    assert.equal(report.recommendation.status, "identical-audio");
    assert.equal(report.recommendation.keep, null);
  });

  it("never recommends a copy across different recordings", async () => {
    const report = await compareGroup([
      input("a.flac", render(12, 7, 0.31), "hash-a"),
      input("b.flac", render(12, 99, 0.83), "hash-b"),
    ]);
    assert.equal(report.pairs[0]!.outcome, "not-comparable");
    assert.equal(report.pairs[0]!.preferred, null);
    assert.equal(report.recommendation.status, "not-comparable");
    assert.equal(report.recommendation.keep, null);
    assert.ok(report.files.every((f) => f.unranked && f.rank === null));
  });

  it("skips the decoded-sample check when asked", async () => {
    const pcm = render(12, 7, 0.31);
    const report = await compareGroup(
      [input("a.flac", pcm, "hash-a"), input("b.flac", copy(pcm), "hash-b")],
      { checkDecodedEquivalence: false },
    );
    assert.equal(report.pairs[0]!.identity.decoded, null);
    assert.notEqual(report.recommendation.status, "identical-audio");
  });
});
