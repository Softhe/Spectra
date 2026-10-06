// Regression suite for the quality-judgment layer: classes, scores,
// verdicts, and header parsing. Pure functions only — runs in milliseconds
// under `npm test` (no browser, no audio files).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  classifyQuality,
  compareAnalyses,
  runDsp,
  scoreOf,
} from "./analyze.ts";
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
    assert.equal(
      classifyQuality(22050, 22050, "natural", 1, { bbFlatness: 0.7 }),
      "low",
    );
  });
  it("caps source-limited ceilings at high", () => {
    assert.equal(
      classifyQuality(22039, 22050, "natural", 0.16, { sourceLimited: true }),
      "high",
    );
  });
  it("does not punish 48 kHz lossless for living under 22 kHz", () => {
    assert.equal(classifyQuality(22000, 24000, "natural", 0.5), "lossless");
    assert.equal(classifyQuality(21500, 24000, "natural", 0.5), "high");
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
    assert.ok(
      scoreOf({ ...base, hfOccupancy: 1, bbFlatness: 0.7 }).total <= 35,
    );
  });
  it("docks sustained clipping", () => {
    assert.ok(scoreOf({ ...base, clipFraction: 0.005 }).total < scoreOf(base).total - 10);
  });
});

describe("compareAnalyses", () => {
  it("declares the wider-bandwidth copy winner on the reported user case", () => {
    const c = compareAnalyses(
      mkAnalysis({ id: "A", cutoff: 21900, rolloff: "steep", score: 84, cls: "high", codec: "FLAC", ckbps: 824 }),
      mkAnalysis({ id: "B", cutoff: 19300, rolloff: "natural", score: 85, cls: "high", codec: "WAV", claimed: 1411, ckbps: 1411 }),
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
    f[33] = 0x0a; f[34] = 0xc4; f[35] = 0x42; f[36] = 0xf0;
    const rf = sniffContainer(u8([...f]), "t.flac", "audio/flac");
    assert.deepEqual([rf.codec, rf.sampleRate, rf.channels, rf.bitDepth], ["FLAC", 44100, 2, 16]);
    const g = new Uint8Array(128);
    g.set([0x4f, 0x67, 0x67, 0x53], 0);
    g.set([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0, 0, 0, 0, 2, 0x44, 0xac, 0, 0], 28);
    const rg = sniffContainer(u8([...g]), "s.ogg", "audio/ogg");
    assert.deepEqual([rg.codec, rg.sampleRate, rg.channels], ["Vorbis", 44100, 2]);
  });
  it("reads a genuine FFmpeg M4A timescale (not duration)", { skip: !existsSync(`${process.env.CORPUS_DIR || "/tmp/corpus"}/bright-aac-128.m4a`) }, async () => {
    const { readFileSync } = await import("node:fs");
    const p = `${process.env.CORPUS_DIR || "/tmp/corpus"}/bright-aac-128.m4a`;
    const b = readFileSync(p);
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    const r = sniffContainer(ab, "bright-aac-128.m4a", "audio/mp4");
    assert.deepEqual([r.codec, r.sampleRate, r.channels, r.vbr], ["AAC", 44100, 2, true]);
  });
});
