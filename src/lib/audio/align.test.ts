import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  alignEnvelopes,
  bTimeOf,
  envelopeFromMono,
  sampleEnvelope,
  songMatchOf,
  testLag,
  type Envelope,
} from "./align.ts";

const BS = 0.125;
const blocks = (n: number, fill: (i: number) => number): Envelope => {
  const power = new Float32Array(n);
  for (let i = 0; i < n; i++) power[i] = fill(i);
  return { blockSec: BS, power };
};

/** Smooth identifiable envelope: slow musical swells, no flat runs. */
const musicish = (n: number): Envelope =>
  blocks(n, (i) => {
    const s = Math.sin(i / 23) * 0.4 + Math.sin(i / 7 + 1.3) * 0.3 + 0.8;
    return s * s; // power-scale, positive
  });

describe("envelopeFromMono", () => {
  it("averages mean-square power per 0.125 s block", () => {
    // 8000 Hz → 1000 samples per block. Blocks 0,1: flat 0.5 and 1.
    const mono = new Float32Array(2000);
    for (let i = 0; i < 1000; i++) mono[i] = Math.sqrt(0.5);
    for (let i = 1000; i < 2000; i++) mono[i] = 1;
    const env = envelopeFromMono(mono, 8000);
    assert.equal(env.blockSec, 0.125);
    assert.equal(env.power.length, 2);
    assert.ok(Math.abs(env.power[0]! - 0.5) < 1e-6);
    assert.ok(Math.abs(env.power[1]! - 1) < 1e-6);
  });

  it("never emits an empty envelope", () => {
    const env = envelopeFromMono(new Float32Array(0), 44100);
    assert.equal(env.power.length, 1);
  });
});

describe("testLag (lag direction: A[i] pairs with B[i - lag])", () => {
  it("finds lag 0 and full correlation for identical envelopes", () => {
    const a = musicish(200);
    const r = testLag(a, a, 0);
    assert.ok(r.corr > 0.999);
    assert.ok(Math.abs(r.overlapSec - 25) < 0.2);
  });

  it("pairs A[i] with B[i - lag]: a B delayed by k blocks peaks at lag = -k", () => {
    // B leads with k blocks of distinct filler, then A's content from its
    // start: B[i] = A[i - k] past the head. For A[i] ↔ B[i - lag] to hold,
    // lag must be -k (negative lag = B starts later).
    const a = musicish(200);
    const k = 8;
    const b = blocks(200, (i) => (i < k ? 0.29 : a.power[i - k]!));
    const at0 = testLag(a, b, 0);
    const atK = testLag(a, b, k);
    const atMinusK = testLag(a, b, -k);
    assert.ok(atMinusK.corr > 0.999, `corr at -k ${atMinusK.corr}`);
    assert.ok(atMinusK.corr2 > at0.corr2, "peak must beat lag 0");
    assert.ok(atMinusK.corr2 > atK.corr2, "peak must beat +k");
  });

  it("a B advanced (starts earlier by k blocks) peaks at lag = +k", () => {
    const a = musicish(200);
    // B[i] = A[i + 8]: B's block i is A's 1-second-later content.
    const b = blocks(192, (i) => a.power[i + 8]!);
    const at = testLag(a, b, 8);
    assert.ok(at.corr > 0.999, `corr at +k ${at.corr}`);
  });

  it("returns corr -1 when the overlap is under 10 s", () => {
    const a = musicish(80); // 10 s
    const r = testLag(a, blocks(80, () => 1), 20); // 60 blocks = 7.5 s overlap
    assert.equal(r.corr, -1);
  });
});

describe("alignEnvelopes", () => {
  it("recovers a 1 s delay through the coarse+fine scan", () => {
    const a = musicish(240); // 30 s
    const k = 8; // 1 s
    // B = 1 s of distinct filler, then A's content from its start: B starts
    // 1 s LATE relative to A, so B[i] = A[i - k] past the filler head.
    const b = blocks(240, (i) => (i < k ? 0.31 : a.power[i - k]!));
    const { lagSec, correlation } = alignEnvelopes(a, b);
    assert.ok(Math.abs(lagSec + k * BS) <= BS / 2, `lagSec ${lagSec}, want ${-k * BS}`);
    assert.ok(correlation > 0.99);
  });

  it("is gain-invariant (amplitude Pearson, mean-removed)", () => {
    const a = musicish(200);
    const b = blocks(200, (i) => a.power[i]! * 9);
    const { lagSec, correlation } = alignEnvelopes(a, b);
    assert.equal(lagSec, 0);
    assert.ok(correlation > 0.999);
  });
});

describe("songMatchOf", () => {
  it("verifies identical takes as same with lag 0", () => {
    const a = musicish(400); // 50 s
    const m = songMatchOf(a, blocks(400, (i) => a.power[i]!));
    assert.equal(m.status, "same");
    assert.equal(m.lagSec, 0);
    assert.ok(m.correlation > 0.999);
  });

  it("verifies a trimmed copy as same with the right lag sign", () => {
    // A carries 4 s of (near-)silence lead-in before the music; B is the
    // music only — B starts 4 s EARLIER in the timeline, which the pairing
    // direction (A[i] ↔ B[i - lag]) encodes as POSITIVE lag = +4 s.
    const pad = 32;
    const body = musicish(360);
    const a = blocks(360 + pad, (i) => (i < pad ? 1e-9 : body.power[i - pad]!));
    const b = body;
    const m = songMatchOf(a, b);
    assert.equal(m.status, "same");
    assert.ok(Math.abs(m.lagSec - pad * BS) <= BS / 2.0001, `lagSec ${m.lagSec}`);
    // The lag is the cross-time map: bTime = aTime - lagSec.
    assert.equal(bTimeOf(m.lagSec, pad * BS), 0);
  });

  it("calls unrelated takes different", () => {
    const a = musicish(400);
    // Decorrelated: wide pseudorandom swells share no shape with A.
    const b = blocks(400, (i) => {
      const jitter = (((i * 2654435761) % 97) / 97) * 1.7 + 0.05;
      return jitter * jitter;
    });
    const m = songMatchOf(a, b);
    assert.equal(m.status, "different");
  });

  it("returns uncertain — not different — when the shared timeline is under 12 s", () => {
    const a = musicish(90); // 11.25 s
    const m = songMatchOf(a, blocks(90, (i) => a.power[i]!));
    assert.equal(m.status, "uncertain");
    assert.ok(m.overlapSec < 12);
  });

  it("rejects >1.6× duration ratios as different even with matching shape", () => {
    const a = musicish(400); // 50 s
    const b = blocks(400 / 1.75 | 0, (i) => a.power[i]!); // ~28.6 s copy
    const m = songMatchOf(a, b);
    assert.equal(m.status, "different");
  });
});

describe("bTimeOf", () => {
  it("maps A time to B time as bTime = aTime - lagSec", () => {
    // B starts 2 s later than A (lagSec = -2): A's chorus at 30 s sits at 32 s.
    assert.equal(bTimeOf(-2, 30), 32);
    // B starts 1 s earlier (lagSec = +1): A's 30 s sits at B 29 s.
    assert.equal(bTimeOf(1, 30), 29);
    assert.equal(bTimeOf(0, 5), 5);
  });
});

describe("sampleEnvelope", () => {
  it("interpolates linearly between blocks and clamps at the edges", () => {
    const env = blocks(4, (i) => i + 1); // 1,2,3,4
    assert.equal(sampleEnvelope(env, 0), 1);
    assert.equal(sampleEnvelope(env, 0.5), 1.5);
    assert.equal(sampleEnvelope(env, 2.25), 3.25);
    assert.equal(sampleEnvelope(env, 99), 4);
    assert.equal(sampleEnvelope(env, -5), 1);
  });
});
