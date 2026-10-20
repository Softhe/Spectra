// Regression suite for the quality-judgment layer: classes, scores,
// verdicts, and header parsing. Pure functions only — runs in milliseconds
// under `npm test` (no browser, no audio files).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  classifyQuality,
  compareAnalyses,
  decodeErrorMessage,
  runDsp,
  scoreOf,
} from "./analyze.ts";
import { fft } from "./fft.ts";
import { sniffContainer } from "./sniff.ts";
import type { Analysis, QualityClass, RolloffKind } from "./types.ts";

function mkAnalysis(o: {
  id?: string;
  cutoff?: number;
  rolloff?: RolloffKind;
  score?: number;
  cls?: QualityClass;
  codec?: string;
  claimed?: number | null;
  ckbps?: number;
  limited?: boolean;
  duration?: number;
}): Analysis {
  return {
    id: o.id ?? "x",
    fileName: o.id ?? "x",
    fileSize: 0,
    mimeType: "",
    objectUrl: "",
    durationSec: o.duration ?? 146,
    sampleRate: 44100,
    channels: 2,
    container: {
      codec: o.codec ?? "MP3",
      sampleRate: 44100,
      channels: 2,
      bitDepth: 16,
      claimedKbps: o.claimed ?? null,
      vbr: null,
    },
    containerKbps: o.ckbps ?? 0,
    cutoffHz: o.cutoff ?? 22050,
    nyquistHz: 22050,
    rolloff: o.rolloff ?? "natural",
    brickwallHz: null,
    qualityClass: o.cls ?? "lossless",
    score: o.score ?? 90,
    scoreParts: { ceiling: 62, rolloff: 12, air: 14, clarity: 12, clip: 0 },
    sourceLimited: o.limited ?? false,
    liteAnalysis: false,
    cacheKey: null,
    peakDb: 0,
    rmsDb: -9,
    crestDb: 9,
    clipFraction: 0,
    stereoWidth: 0.1,
    hfOccupancy: 0.3,
    hfSlope: 0,
    meanDb: new Float32Array(),
    meanDbHzPerBin: 0,
    spectrogram: {
      frames: new Float32Array(),
      nFrames: 0,
      nBins: 0,
      maxHz: 0,
      durationSec: 0,
      excerptStartSec: 0,
    },
  };
}

describe("classifyQuality", () => {
  it("grades a full-bandwidth natural encode lossless", () => {
    assert.equal(classifyQuality(22039, 22050, "natural", 0.56), "lossless");
  });
  it("walks the ladder by ceiling", () => {
    assert.equal(classifyQuality(19638, 22050, "brickwall", 0.56), "high");
    assert.equal(classifyQuality(18292, 22050, "brickwall", 0.25), "medium");
    assert.equal(classifyQuality(15902, 22050, "brickwall", 0.02), "standard");
    assert.equal(classifyQuality(12188, 22050, "brickwall", 0), "low");
    assert.equal(classifyQuality(8000, 22050, "brickwall", 0), "telephone");
  });
  it("caps starved full-band mush at low", () => {
    assert.equal(classifyQuality(22050, 22050, "natural", 1, { bbFlatness: 0.7 }), "low");
  });
  it("caps source-limited ceilings at high", () => {
    assert.equal(classifyQuality(22039, 22050, "natural", 0.16, { sourceLimited: true }), "high");
  });
  it("does not punish 48 kHz lossless for living under 22 kHz", () => {
    assert.equal(classifyQuality(22000, 24000, "natural", 0.5), "lossless");
    assert.equal(classifyQuality(21500, 24000, "natural", 0.5), "high");
  });
  it("grades lossy ceilings by absolute frequency, not by sample rate", () => {
    // Encoder low-passes don't move with the rate: a 20 kHz natural ceiling
    // is the same encode at 48 kHz as at 44.1 kHz.
    for (const [hz, occ] of [
      [20000, 0.25],
      [18600, 0.1],
      [17100, 0.05],
      [14200, 0],
      [10100, 0],
    ]) {
      for (const r of ["natural", "brickwall"] as const) {
        assert.equal(
          classifyQuality(hz, 24000, r, occ),
          classifyQuality(hz, 22050, r, occ),
          `${hz} Hz ${r}`,
        );
      }
    }
    assert.equal(classifyQuality(20000, 24000, "natural", 0.25), "high");
  });
});

describe("scoreOf", () => {
  const base = {
    cutoffHz: 22039,
    nyquistHz: 22050,
    rolloff: "natural" as RolloffKind,
    hfOccupancy: 0.56,
    clipFraction: 0,
    bbFlatness: 0.115,
  };
  it("scores a transparent master in the mid-90s", () => {
    const { total: s, parts } = scoreOf(base);
    assert.ok(s > 90 && s <= 100, `got ${s}`);
    // Parts explain the whole: ceiling dominates, nothing docked.
    assert.equal(parts.rolloff, 12);
    assert.equal(parts.clip, 0);
    assert.ok(
      Math.abs(parts.ceiling + parts.rolloff + parts.air + parts.clarity + parts.clip - s) < 1e-6,
    );
  });
  it("scores a 128k-style brickwall in the low 60s", () => {
    const { total: s, parts } = scoreOf({
      ...base,
      cutoffHz: 15902,
      rolloff: "brickwall",
      hfOccupancy: 0.024,
      bbFlatness: 0.027,
    });
    assert.ok(s > 55 && s < 68, `got ${s}`);
    assert.equal(parts.rolloff, 0);
    assert.ok(parts.ceiling < 50, `ceiling part ${parts.ceiling}`);
  });
  it("caps starved mush at 35", () => {
    assert.ok(scoreOf({ ...base, hfOccupancy: 1, bbFlatness: 0.7 }).total <= 35);
  });
  it("docks sustained clipping", () => {
    assert.ok(scoreOf({ ...base, clipFraction: 0.005 }).total < scoreOf(base).total - 10);
  });
});

describe("compareAnalyses", () => {
  it("declares the wider-bandwidth copy winner on the reported user case", () => {
    const c = compareAnalyses(
      mkAnalysis({
        id: "A",
        cutoff: 21900,
        rolloff: "steep",
        score: 84,
        cls: "high",
        codec: "FLAC",
        ckbps: 824,
      }),
      mkAnalysis({
        id: "B",
        cutoff: 19300,
        rolloff: "natural",
        score: 85,
        cls: "high",
        codec: "WAV",
        claimed: 1411,
        ckbps: 1411,
      }),
    );
    assert.equal(c.winner, "a");
    assert.equal(c.confidence, "high");
    assert.match(c.headline, /Winner: File A/);
    assert.match(c.detail, /WAV.*band-limited/);
  });
  it("lets a 1-point score gap not veto kilohertz of bandwidth, but a 20-point gap does", () => {
    const narrowWin = compareAnalyses(
      mkAnalysis({ id: "A", cutoff: 21900, score: 84 }),
      mkAnalysis({ id: "B", cutoff: 19300, score: 85 }),
    );
    assert.equal(narrowWin.winner, "a");
    const crushed = compareAnalyses(
      mkAnalysis({ id: "A", cutoff: 22000, score: 70 }),
      mkAnalysis({ id: "B", cutoff: 19000, score: 92 }),
    );
    assert.equal(crushed.winner, "b");
    assert.equal(crushed.confidence, "medium");
  });
  it("wins on a decisive score gap alone", () => {
    const c = compareAnalyses(
      mkAnalysis({ id: "A", cutoff: 22039, score: 100 }),
      mkAnalysis({ id: "B", cutoff: 22039, score: 87 }),
    );
    assert.equal(c.winner, "a");
  });
  it("names both ceilings when a tie still shows a visible gap", () => {
    const c = compareAnalyses(
      mkAnalysis({ id: "A", cutoff: 20000, score: 70 }),
      mkAnalysis({ id: "B", cutoff: 19000, score: 76 }),
    );
    assert.equal(c.winner, "tie");
    assert.match(c.detail, /File A reaches 20\.0 kHz and File B 19\.0 kHz/);
  });
  it("keeps the classic line for near-identical ceilings", () => {
    const c = compareAnalyses(
      mkAnalysis({ id: "A", cutoff: 16000, score: 70 }),
      mkAnalysis({ id: "B", cutoff: 15800, score: 71 }),
    );
    assert.equal(c.winner, "tie");
    assert.match(c.detail, /Both reach about 16\.0 kHz/);
  });
  it("explains source-limited ties", () => {
    const c = compareAnalyses(
      mkAnalysis({ id: "A", cutoff: 22039, score: 91, limited: true }),
      mkAnalysis({ id: "B", cutoff: 22039, score: 93, limited: true }),
    );
    assert.equal(c.winner, "tie");
    assert.match(c.detail, /reflects the music itself/);
  });
  it("never claims more air for a score win over an equal-or-higher ceiling", () => {
    // A: natural 19 kHz, B: brickwalled 20 kHz — the score overrides the
    // 1 kHz bandwidth gap, so "more air kept" would contradict itself.
    const c = compareAnalyses(
      mkAnalysis({ id: "A", cutoff: 19000, rolloff: "natural", score: 88, cls: "high" }),
      mkAnalysis({ id: "B", cutoff: 20000, rolloff: "brickwall", score: 70, cls: "high" }),
    );
    assert.equal(c.winner, "a");
    assert.doesNotMatch(c.detail, /more air kept/);
    assert.match(c.detail, /File A reaches 19\.0 kHz and File B 20\.0 kHz/);
    assert.match(c.detail, /natural rolloff.*brickwall low-pass/);
    assert.match(c.detail, /88 vs 70/);
    // A genuine bandwidth win keeps the classic line.
    const wide = compareAnalyses(
      mkAnalysis({ id: "A", cutoff: 22000, score: 92 }),
      mkAnalysis({ id: "B", cutoff: 16000, rolloff: "brickwall", score: 62, cls: "standard" }),
    );
    assert.match(
      wide.detail,
      /^22\.0 kHz of real bandwidth versus 16\.0 kHz — 6\.0 kHz more air kept\./,
    );
  });
  it("flags a band-limited CAF wrapper like the other lossless shells", () => {
    const c = compareAnalyses(
      mkAnalysis({ id: "A", cutoff: 22000, score: 90, codec: "CAF" }),
      mkAnalysis({ id: "B", cutoff: 16000, score: 62, cls: "standard", codec: "CAF", ckbps: 1200 }),
    );
    assert.equal(c.winner, "a");
    assert.match(c.detail, /CAF .*band-limited/);
  });
});

describe("runDsp lite spans", () => {
  it("labels the spectrogram with the true excerpt position, not the slice offset", async () => {
    // Mirror analyzeFile's lite path: a concatenated slice buffer whose
    // excerpt lives locally at 16 s but at 384 s (32% of a 20-min song) in
    // the original file. The spans must carry the true wall-clock start.
    const sr = 44100;
    const win = 4 * sr;
    const localRegions = [
      { start: 0, end: win },
      { start: win, end: win * 2 },
      { start: win * 2, end: win * 3 },
      { start: win * 3, end: win * 4 },
    ];
    const localExcerpt = { start: win * 4, end: win * 4 + 12 * sr };
    const mono = new Float32Array(localExcerpt.end);
    for (let i = 0; i < mono.length; i++) {
      mono[i] = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.3;
    }
    const res = await runDsp(mono, sr, 0, undefined, {
      regions: localRegions,
      excerpt: localExcerpt,
      excerptStartSec: 384,
      excerptDurSec: 12,
    });
    assert.equal(res.spectrogram.excerptStartSec, 384);
    assert.equal(res.spectrogram.durationSec, 12);
  });
});

describe("runDsp unconfirmed decode rate", () => {
  // Broadband noise shaped ~−4.8 dB/oct (music-like flatness) times `gain`
  // (default: hard stop above `topHz`). Deterministic (fixed LCG seed).
  function shapedNoise(
    sr: number,
    topHz: number,
    gain: (f: number) => number = () => 1,
    n = 1 << 18,
  ): Float32Array {
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    let seed = 7;
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    for (let k = 1; k < n / 2; k++) {
      const f = (k * sr) / n;
      if (f < 40 || f > topHz) continue;
      const mag = Math.pow(f / 1000, -0.8) * gain(f);
      const ph = rnd() * 2 * Math.PI;
      re[k] = mag * Math.cos(ph);
      im[k] = mag * Math.sin(ph);
      re[n - k] = re[k]!;
      im[n - k] = -im[k]!;
    }
    fft(re, im, true);
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(re[i]!));
    for (let i = 0; i < n; i++) re[i] = (re[i]! / peak) * 0.5;
    return re;
  }
  // Kaiser (β = 8) windowed-sinc 44.1 → 48 kHz resampler: what a decoder
  // does to a 44.1 kHz file when the decode runs at 48 kHz. 160 output
  // phases repeat (48000 / 44100 = 160 / 147), so kernels are tabulated.
  function resample441to48(x: Float32Array, cutFrac: number, half: number): Float32Array {
    const i0 = (v: number) => {
      let sum = 1;
      let term = 1;
      for (let k = 1; k < 30; k++) {
        term *= (v / 2 / k) ** 2;
        sum += term;
      }
      return sum;
    };
    const fc = cutFrac / 2; // cycles per input sample
    const kernels: Float64Array[] = [];
    for (let p = 0; p < 160; p++) {
      const frac = (p * 147) / 160 - Math.floor((p * 147) / 160);
      const ker = new Float64Array(2 * half);
      for (let j = 0; j < 2 * half; j++) {
        const d = frac + half - 1 - j; // t − k for k = c − half + 1 + j
        const r = d / half;
        if (Math.abs(r) >= 1) continue;
        const sinc = d === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d);
        ker[j] = sinc * (i0(8 * Math.sqrt(1 - r * r)) / i0(8));
      }
      kernels.push(ker);
    }
    const out = new Float32Array(Math.floor((x.length * 160) / 147));
    for (let n = 0; n < out.length; n++) {
      const c = Math.floor((n * 147) / 160);
      const ker = kernels[n % 160]!;
      let s = 0;
      for (let j = 0; j < 2 * half; j++) {
        const k = c - half + 1 + j;
        if (k >= 0 && k < x.length) s += x[k]! * ker[j]!;
      }
      out[n] = s;
    }
    return out;
  }
  const verdict = (r: Awaited<ReturnType<typeof runDsp>>) => [
    r.cutoffHz,
    r.rolloff,
    r.brickwallHz,
    r.qualityClass,
    r.score,
    r.sourceLimited,
  ];
  const unconfirmed = { rateConfirmed: false };

  it("reads a 44.1 kHz source's band edge as natural, not a brickwall", async () => {
    const mono = shapedNoise(48000, 21900);
    const asDecoded = await runDsp(mono, 48000, 0);
    assert.equal(asDecoded.rolloff, "brickwall"); // confirmed-rate behavior unchanged
    assert.notEqual(asDecoded.qualityClass, "lossless");
    const confirmed = await runDsp(mono, 48000, 0, undefined, undefined, undefined, {
      rateConfirmed: true,
    });
    assert.equal(confirmed.cutoffHz, asDecoded.cutoffHz);
    assert.equal(confirmed.score, asDecoded.score);

    const r = await runDsp(mono, 48000, 0, undefined, undefined, undefined, unconfirmed);
    assert.equal(r.rolloff, "natural");
    assert.equal(r.brickwallHz, null);
    assert.equal(r.qualityClass, "lossless");
    assert.ok(r.cutoffHz >= 21350 && r.cutoffHz <= 22050, `cutoff ${r.cutoffHz}`);
    assert.equal(r.nyquistHz, 24000); // the decode Nyquist is still reported
  });
  it("still calls a real encoder low-pass a brickwall", async () => {
    const r = await runDsp(
      shapedNoise(48000, 20000),
      48000,
      0,
      undefined,
      undefined,
      undefined,
      unconfirmed,
    );
    assert.equal(r.rolloff, "brickwall");
    assert.equal(r.qualityClass, "high");
  });
  it("leaves a 44.1 kHz decode untouched (no lower Nyquist to infer)", async () => {
    const mono = shapedNoise(44100, 21900);
    const a = await runDsp(mono, 44100, 0);
    const b = await runDsp(mono, 44100, 0, undefined, undefined, undefined, unconfirmed);
    assert.deepEqual(
      [b.cutoffHz, b.rolloff, b.qualityClass, b.score],
      [a.cutoffHz, a.rolloff, a.qualityClass, a.score],
    );
  });
  it("rejects the inference when a cliff provably exceeds 22.05 kHz", async () => {
    // Content up to 22.1–22.4 kHz can't come from a 44.1 kHz source: these
    // read exactly as a confirmed-rate decode reads them.
    for (const top of [22100, 22200, 22300, 22400]) {
      const mono = shapedNoise(48000, top);
      const a = await runDsp(mono, 48000, 0);
      const b = await runDsp(mono, 48000, 0, undefined, undefined, undefined, unconfirmed);
      assert.deepEqual(verdict(b), verdict(a), `cut ${top}`);
      assert.equal(b.rolloff, "brickwall", `cut ${top}`);
      assert.notEqual(b.qualityClass, "lossless", `cut ${top}`);
      assert.equal(b.cutoffHz, b.brickwallHz, `cut ${top}`);
    }
  });
  it("bounds the documented ambiguous band (≈21.35–22.09 kHz)", async () => {
    // Below the band: a real low-pass, as confirmed.
    for (const top of [20000, 21000, 21300]) {
      const r = await runDsp(
        shapedNoise(48000, top),
        48000,
        0,
        undefined,
        undefined,
        undefined,
        unconfirmed,
      );
      assert.equal(r.rolloff, "brickwall", `cut ${top}`);
      assert.notEqual(r.qualityClass, "lossless", `cut ${top}`);
    }
    // Inside it a hard cut is indistinguishable from a 44.1 kHz source's
    // band edge and is read as one (see detectCutoff's edgeFor).
    for (const top of [21600, 22000, 22050]) {
      const r = await runDsp(
        shapedNoise(48000, top),
        48000,
        0,
        undefined,
        undefined,
        undefined,
        unconfirmed,
      );
      assert.equal(r.rolloff, "natural", `cut ${top}`);
      assert.equal(r.qualityClass, "lossless", `cut ${top}`);
      assert.ok(r.cutoffHz <= 22050, `cut ${top}: ${r.cutoffHz}`);
    }
  });
  it("reads a resampled full-band 44.1 kHz source as lossless", async () => {
    const src = shapedNoise(44100, 22050, () => 1, 1 << 17);
    const mono = resample441to48(src, 0.97, 64);
    const confirmed = await runDsp(mono, 48000, 0);
    assert.equal(confirmed.rolloff, "brickwall"); // its edge, read as a cut
    const r = await runDsp(mono, 48000, 0, undefined, undefined, undefined, unconfirmed);
    assert.equal(r.rolloff, "natural");
    assert.equal(r.qualityClass, "lossless");
  });
  it("uses only the container rate's Nyquist when that rate is known", async () => {
    // 96 kHz decode of content cut at 22.05 kHz. Unknown rate: plausibly a
    // 44.1 kHz source. Known 48 kHz container (native decode failed): only
    // a 24 kHz edge is plausible, so 22.05 kHz is a real low-pass.
    const mono = shapedNoise(96000, 22050);
    const a = await runDsp(mono, 96000, 0);
    const unknown = await runDsp(mono, 96000, 0, undefined, undefined, undefined, unconfirmed);
    assert.equal(unknown.rolloff, "natural");
    assert.equal(unknown.qualityClass, "lossless");
    const known48 = await runDsp(mono, 96000, 0, undefined, undefined, undefined, {
      rateConfirmed: false,
      sourceRate: 48000,
    });
    assert.deepEqual(verdict(known48), verdict(a));
    assert.equal(known48.rolloff, "brickwall");
    const known441 = await runDsp(mono, 96000, 0, undefined, undefined, undefined, {
      rateConfirmed: false,
      sourceRate: 44100,
    });
    assert.equal(known441.rolloff, "natural");
    // 96 kHz container decoded at 48 kHz: its Nyquist is above ours.
    const at48 = shapedNoise(48000, 22050);
    const b = await runDsp(at48, 48000, 0);
    const known96 = await runDsp(at48, 48000, 0, undefined, undefined, undefined, {
      rateConfirmed: false,
      sourceRate: 96000,
    });
    assert.deepEqual(verdict(known96), verdict(b));
  });
  it("never infers an edge from a natural fade", async () => {
    // HF-quiet (−8.4 dB/oct) 48 kHz material fading gently from 21.5 / 22
    // kHz: occupancy runs out near 22 kHz with no cliff. Must be judged
    // against the decode Nyquist, exactly as a confirmed decode is.
    for (const f0 of [21500, 22000]) {
      const mono = shapedNoise(
        48000,
        24000,
        (f) => Math.pow(f / 1000, -0.6) * (f < f0 ? 1 : Math.pow(10, (-6 * (f - f0)) / 20000)),
      );
      const a = await runDsp(mono, 48000, 0);
      const b = await runDsp(mono, 48000, 0, undefined, undefined, undefined, unconfirmed);
      assert.equal(a.rolloff, "natural", `fade ${f0}`);
      assert.deepEqual(verdict(b), verdict(a), `fade ${f0}`);
    }
  });
  it("keeps the confirmed path identical with or without options", async () => {
    for (const top of [20000, 21900, 22200, 24000]) {
      const mono = shapedNoise(48000, top);
      const a = await runDsp(mono, 48000, 0);
      const b = await runDsp(mono, 48000, 0, undefined, undefined, undefined, {
        rateConfirmed: true,
        sourceRate: 44100,
      });
      assert.deepEqual(verdict(b), verdict(a), `cut ${top}`);
      assert.deepEqual(Array.from(b.meanDb), Array.from(a.meanDb));
    }
  });
});

describe("makeDemoFiles", () => {
  it("renders byte-identical files every call so the result cache bites", async () => {
    // Repeat "Load a demo comparison" resolves through the IndexedDB cache
    // only when the seeded render produces the same bytes each time.
    const { makeDemoFiles } = await import("./demo.ts");
    const [first, second] = await Promise.all([makeDemoFiles(), makeDemoFiles()]);
    const [a1, a2] = [await first.a.arrayBuffer(), await second.a.arrayBuffer()];
    const [b1, b2] = [await first.b.arrayBuffer(), await second.b.arrayBuffer()];
    assert.ok(a1.byteLength > 1_000_000);
    assert.ok(Buffer.from(a1).equals(Buffer.from(a2)), "demo master bytes differ between calls");
    assert.ok(Buffer.from(b1).equals(Buffer.from(b2)), "demo rip bytes differ between calls");
    // And they really are well-formed PCM WAVs (RIFF/WAVE, 44.1 kHz stereo).
    assert.equal(String.fromCharCode(...new Uint8Array(a1, 0, 4)), "RIFF");
    assert.equal(String.fromCharCode(...new Uint8Array(a1, 8, 4)), "WAVE");
  });
});

describe("sniffContainer", () => {
  const u8 = (arr: number[]) => new Uint8Array(arr).buffer;
  it("reads CBR MP3 headers, ignores deep false Xing hits", () => {
    const b = new Uint8Array(9000);
    b.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 0);
    b.set([0xff, 0xfb, 0x90, 0x64], 10);
    b.set([0x58, 0x69, 0x6e, 0x67], 8000); // "Xing" far outside the first frame
    const r = sniffContainer(u8([...b]), "song.mp3", "audio/mpeg");
    assert.equal(r.codec, "MP3");
    assert.equal(r.claimedKbps, 128);
    assert.equal(r.vbr, null);
  });
  it("reports VBR bitrate as unknown instead of the placeholder frame", () => {
    const b = new Uint8Array(4200);
    b.set([0xff, 0xfb, 0x20, 0x64], 0); // 32k first frame
    b.set([0x58, 0x69, 0x6e, 0x67], 100); // "Xing"
    const r = sniffContainer(u8([...b]), "vbr.mp3", "audio/mpeg");
    assert.equal(r.vbr, true);
    assert.equal(r.claimedKbps, null);
  });
  it("walks tagless VBR frames and refuses to carry the placeholder claim", () => {
    // First frame 320 kbps (144·320000/44100 → 1044-byte stride), data frames
    // at 128 kbps (417-byte stride), no Xing/Info/VBRI anywhere.
    const b = new Uint8Array(8192);
    const frame = (off: number, idx: number) => {
      b[off] = 0xff;
      b[off + 1] = 0xfb;
      b[off + 2] = idx << 4;
      b[off + 3] = 0xc4;
    };
    frame(0, 0xe); // 320 kbps placeholder
    frame(1044, 0x9); // 128 kbps real data
    frame(1044 + 417, 0x9);
    frame(1044 + 2 * 417, 0x9);
    const r = sniffContainer(u8([...b]), "song.mp3", "audio/mpeg");
    assert.equal(r.vbr, true);
    assert.equal(r.claimedKbps, null);
  });
  it("keeps a tagless CBR claim when the walk confirms one bitrate", () => {
    const b = new Uint8Array(8192);
    const frame = (off: number, idx: number) => {
      b[off] = 0xff;
      b[off + 1] = 0xfb;
      b[off + 2] = idx << 4;
      b[off + 3] = 0xc4;
    };
    let pos = 0;
    for (let f = 0; f < 20; f++) {
      frame(pos, 0x9); // 128 kbps throughout (417-byte stride)
      pos += 417;
    }
    const r = sniffContainer(u8([...b]), "song.mp3", "audio/mpeg");
    assert.equal(r.claimedKbps, 128);
    assert.equal(r.vbr, null);
  });
  it("reads Opus-in-MP4 via dOps, not stray metadata text", () => {
    // M4A whose ©nam metadata literally says "Opus" but whose track is AAC.
    const b = new Uint8Array(2048);
    const view = new DataView(b.buffer);
    const w32 = (v: number, o: number) => view.setUint32(o, v, false);
    const str = (s: string, o: number) => {
      for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i);
    };
    w32(2048, 0);
    str("ftypM4A ", 4);
    w32(64, 100);
    str("moov", 104);
    w32(40, 148);
    str("udta", 152);
    w32(32, 188);
    str("\xa9nam", 192);
    str("Opus (Mixed)", 200);
    const r = sniffContainer(u8([...b]), "album.m4a", "audio/mp4");
    assert.equal(r.codec, "AAC");
  });
  it("calls a real Opus-in-MP4 track Opus", () => {
    const b = new Uint8Array(512);
    const view = new DataView(b.buffer);
    const w32 = (v: number, o: number) => view.setUint32(o, v, false);
    const str = (s: string, o: number) => {
      for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i);
    };
    w32(512, 0);
    str("ftypM4A ", 4);
    w32(64, 100);
    str("moov", 104);
    w32(40, 148);
    str("trak", 152);
    // Sample entry "Opus" + the spec-required dOps box.
    str("Opus", 200);
    str("dOps", 240);
    const r = sniffContainer(u8([...b]), "song.m4a", "audio/mp4");
    assert.equal(r.codec, "Opus");
  });
  it("takes the MP4 average bitrate, not the max", () => {
    const b = new Uint8Array(256);
    b.set([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20], 0);
    const e = 64;
    b.set([0x65, 0x73, 0x64, 0x73], e);
    const w32 = (v: number, o: number) => {
      b[o] = (v >>> 24) & 255;
      b[o + 1] = (v >>> 16) & 255;
      b[o + 2] = (v >>> 8) & 255;
      b[o + 3] = v & 255;
    };
    w32(256000, e + 12);
    w32(128000, e + 16);
    const r = sniffContainer(u8([...b]), "song.m4a", "audio/mp4");
    assert.equal(r.codec, "AAC");
    assert.equal(r.claimedKbps, 128);
  });
  it("parses tagged FLAC and real Vorbis packets", () => {
    const f = new Uint8Array(64);
    f.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05], 0);
    f.set([0x66, 0x4c, 0x61, 0x43], 15);
    f.set([0x10, 0x00, 0x00, 0x22], 19);
    f[33] = 0x0a;
    f[34] = 0xc4;
    f[35] = 0x42;
    f[36] = 0xf0;
    const rf = sniffContainer(u8([...f]), "t.flac", "audio/flac");
    assert.deepEqual([rf.codec, rf.sampleRate, rf.channels, rf.bitDepth], ["FLAC", 44100, 2, 16]);
    const g = new Uint8Array(128);
    g.set([0x4f, 0x67, 0x67, 0x53], 0);
    g.set([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0, 0, 0, 0, 2, 0x44, 0xac, 0, 0], 28);
    const rg = sniffContainer(u8([...g]), "s.ogg", "audio/ogg");
    assert.deepEqual([rg.codec, rg.sampleRate, rg.channels], ["Vorbis", 44100, 2]);
  });
  it(
    "reads a genuine FFmpeg M4A timescale (not duration)",
    { skip: !existsSync(`${process.env.CORPUS_DIR || "/tmp/corpus"}/bright-aac-128.m4a`) },
    async () => {
      const { readFileSync } = await import("node:fs");
      const p = `${process.env.CORPUS_DIR || "/tmp/corpus"}/bright-aac-128.m4a`;
      const b = readFileSync(p);
      const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      const r = sniffContainer(ab, "bright-aac-128.m4a", "audio/mp4");
      assert.deepEqual([r.codec, r.sampleRate, r.channels, r.vbr], ["AAC", 44100, 2, true]);
    },
  );
});

describe("decodeErrorMessage", () => {
  it("points ALAC at Safari or a FLAC/WAV conversion", () => {
    const m = decodeErrorMessage("song.m4a", "ALAC");
    assert.match(m, /“song\.m4a”/);
    assert.match(m, /Apple Lossless \(ALAC\)/);
    assert.match(m, /Safari/);
    assert.match(m, /FLAC or WAV/);
  });
  it("blames Safari for Opus/Vorbis", () => {
    const m = decodeErrorMessage("song.opus", "Opus");
    assert.match(m, /Safari can't play Opus files/);
    assert.match(m, /Chrome or Firefox/);
    assert.match(decodeErrorMessage("s.ogg", "Vorbis"), /Safari can't play Vorbis/);
  });
  it("falls back to the generic format list", () => {
    const m = decodeErrorMessage("song.m4a", "AAC");
    assert.equal(m, "Could not decode “song.m4a”. Try MP3, M4A, AAC, WAV, FLAC, or OGG.");
  });
});

describe("runDsp edge cases", () => {
  // Band-limited deterministic noise: flat-ish up to `topHz`, nothing above.
  function lowpassNoise(sr: number, topHz: number, n: number, amp = 0.5): Float32Array {
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    let seed = 11;
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    for (let k = 1; k < n / 2; k++) {
      const f = (k * sr) / n;
      if (f < 40 || f > topHz) continue;
      const mag = Math.pow(f / 1000, -0.8);
      const ph = rnd() * 2 * Math.PI;
      re[k] = mag * Math.cos(ph);
      im[k] = mag * Math.sin(ph);
      re[n - k] = re[k]!;
      im[n - k] = -im[k]!;
    }
    fft(re, im, true);
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(re[i]!));
    for (let i = 0; i < n; i++) re[i] = (re[i]! / peak) * amp;
    return re;
  }

  it("does not grade a low sample-rate file 'high' by default", async () => {
    const r = await runDsp(lowpassNoise(8000, 3990, 1 << 17), 8000, 0);
    assert.equal(r.sourceLimited, false);
    assert.notEqual(r.qualityClass, "high");
  });

  it("does not read silence-padded lossy audio as full-band", async () => {
    // 3 s of 16 kHz-limited noise inside 15 s of digital silence.
    const sr = 44100;
    const mono = new Float32Array(15 * sr);
    mono.set(lowpassNoise(sr, 16000, 1 << 17), 6 * sr);
    const r = await runDsp(mono, sr, 0);
    assert.notEqual(r.qualityClass, "lossless");
    assert.ok(r.cutoffHz < 17500, `cutoff ${r.cutoffHz}`);
  });
});

describe("compareAnalyses tie confidence", () => {
  it("never reports a tie with more than low confidence", () => {
    const c = compareAnalyses(
      mkAnalysis({ id: "A", cutoff: 20000, score: 70 }),
      mkAnalysis({ id: "B", cutoff: 19000, score: 76 }),
    );
    assert.equal(c.winner, "tie");
    assert.equal(c.confidence, "low");
  });
});
