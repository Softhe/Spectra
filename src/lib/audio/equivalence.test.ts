import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareDecodedSources } from "./equivalence.ts";
import type { SliceSource } from "./source.ts";

function source(data: Float32Array[], rate = 44100): SliceSource {
  return {
    sampleRate: rate,
    numberOfChannels: data.length,
    length: data[0]!.length,
    async sliceChannels(start, end) {
      return data.map((channel) => channel.subarray(start, end));
    },
  };
}

describe("complete decoded-audio comparison", () => {
  it("checks the final sample of every channel beyond the first chunk", async () => {
    const a = [new Float32Array(140000), new Float32Array(140000)];
    const b = a.map((channel) => channel.slice());
    const progress: number[] = [];
    const exact = await compareDecodedSources(source(a), source(b), (value) =>
      progress.push(value),
    );
    assert.equal(exact.status, "exact");
    assert.equal(exact.framesCompared, 140000);
    assert.equal(progress.at(-1), 1);
    b[1]![139999] = 0.25;
    const different = await compareDecodedSources(source(a), source(b));
    assert.equal(different.status, "different");
    assert.equal(different.maxDifference, 0.25);
  });
  it("keeps tolerance matches distinct from exact equality", async () => {
    const result = await compareDecodedSources(
      source([new Float32Array([0.5, 0])]),
      source([new Float32Array([0.5, 5e-8])]),
    );
    assert.equal(result.status, "tolerance");
    assert.match(result.detail, /not exact equality/);
  });
  it("states the decoder bound and never treats it as exact equality", async () => {
    const a = source([new Float32Array([0.5])]);
    const b = source([new Float32Array([0.5 + 1 / 65536])]);
    assert.equal((await compareDecodedSources(a, b)).status, "different");
    const tolerant = await compareDecodedSources(a, b, undefined, undefined, 1 / 32768);
    assert.equal(tolerant.status, "tolerance");
    assert.equal(tolerant.tolerance, 1 / 32768);
    assert.match(tolerant.detail, /no gain adjustment/);
    await assert.rejects(compareDecodedSources(a, b, undefined, undefined, 0.1), /outside/);
  });
  it("does not normalize gain, reorder channels, trim or resample", async () => {
    const a = source([new Float32Array([0.5, 0])]);
    for (const b of [
      source([new Float32Array([0.25, 0])]),
      source([new Float32Array([0.5])]),
      source([new Float32Array([0.5, 0])], 48000),
      source([new Float32Array([0.5, 0]), new Float32Array([0.5, 0])]),
    ]) {
      assert.equal((await compareDecodedSources(a, b)).status, "different");
    }
    assert.equal(
      (
        await compareDecodedSources(
          source([new Float32Array([1]), new Float32Array([0])]),
          source([new Float32Array([0]), new Float32Array([1])]),
        )
      ).status,
      "different",
    );
  });
  it("rejects incomplete ranges and invalid values instead of claiming a match", async () => {
    const a = source([new Float32Array([1, 2])]);
    await assert.rejects(
      compareDecodedSources(a, {
        ...a,
        async sliceChannels() {
          return [new Float32Array(0)];
        },
      }),
      /incomplete/,
    );
    await assert.rejects(
      compareDecodedSources(source([new Float32Array([NaN])]), source([new Float32Array([NaN])])),
      /invalid/,
    );
  });
  it("honors cancellation before publishing a complete result", async () => {
    const controller = new AbortController();
    const a = source([new Float32Array(140000)]);
    await assert.rejects(
      compareDecodedSources(a, a, () => controller.abort(), controller.signal),
      { name: "AbortError" },
    );
  });
});
