// Scores $CORPUS_DIR/items/*.f32 with the REAL detection functions from
// src/lib/audio/analyze.ts (no copies). Run from the repo root:
//   node --experimental-strip-types --no-warnings --loader ./scripts/corpus/ts-resolve.mjs ./scripts/corpus/score-corpus.mjs [name-filter]
// Prints one row per item, the COMPARE A/B verdicts, then an EXPECT block of
// PASS/FAIL/XFAIL/XPASS/SKIP lines; exits 1 on any FAIL or XPASS (XFAIL =
// listed in KNOWN_GAPS and failing with the recorded outcome).
import { readFileSync } from "node:fs";
import {
  classifyQuality,
  compareQualityMeasurements as compareAnalyses,
  detectCutoff,
  excerptRegion,
  loudFrameMask,
  meanSpectrum,
  pickRegions,
  pickRegionsFromBuffer,
  runDsp,
  scoreOf,
  stftPower,
} from "../../src/lib/audio/analyze.ts";

const CORPUS_DIR = process.env.CORPUS_DIR || "/tmp/corpus";
const FFT_SIZE = 4096;
const N_BINS = FFT_SIZE / 2;
const filter = process.argv[2] || "";
const manifest = JSON.parse(readFileSync(`${CORPUS_DIR}/manifest.json`, "utf8"));
const results = {};
const regionsOf = {}; // name -> regions used (seconds), for the long-file checks
// Lite path threshold, mirrored from analyzeFile (LONG_SEC).
const LITE_SEC = 15 * 60;
// bright-long envelope, mirrored from gen-wavs.mjs (LONG): quiet intro to
// 6 s, fade-in to 8 s, loud to 33 s, fade-out to 40 s.
const LONG_ENV = { loudFrom: 8, loudTo: 33 };

function crestClip(mono) {
  let peak = 0, sumSq = 0, run = 0, clipRun = 0;
  for (let i = 0; i < mono.length; i++) {
    const v = mono[i], a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
    if (a >= 0.999) run++;
    else { if (run >= 16) clipRun += run; run = 0; }
  }
  if (run >= 16) clipRun += run;
  const rms = Math.sqrt(sumSq / Math.max(1, mono.length));
  const peakDb = 20 * Math.log10(peak + 1e-12);
  const rmsDb = 20 * Math.log10(rms + 1e-12);
  return { peakDb, rmsDb, crestDb: peakDb - rmsDb, clipFraction: clipRun / Math.max(1, mono.length) };
}

for (const item of manifest.items) {
  if (filter && !item.name.includes(filter)) continue;
  const buf = readFileSync(`${CORPUS_DIR}/items/${item.name}.f32`);
  const mono = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const cc = crestClip(mono);
  let det, cls;
  if (mono.length / item.sr > LITE_SEC) {
    // Mirror analyzeFile's Lite branch: loudness-ranked regions from the
    // buffer + display excerpt, sliced and concatenated, then runDsp with
    // spans. (The app ranks on the channel mean; only the mono mix is
    // dumped here, which IS that mean — identical ranking.)
    const fakeBuf = { length: mono.length, sampleRate: item.sr, numberOfChannels: 1, getChannelData: () => mono };
    const regions = pickRegionsFromBuffer(fakeBuf);
    const excerpt = excerptRegion(mono.length, item.sr);
    const parts = [...regions, excerpt].map((r) => mono.subarray(r.start, r.end));
    const cat = new Float32Array(parts.reduce((n, x) => n + x.length, 0));
    const localRegions = [];
    let off = 0;
    for (let i = 0; i < parts.length; i++) {
      cat.set(parts[i], off);
      if (i < regions.length) localRegions.push({ start: off, end: off + parts[i].length });
      off += parts[i].length;
    }
    const exLen = parts[parts.length - 1].length;
    const dsp = await runDsp(cat, item.sr, cc.clipFraction, undefined, {
      regions: localRegions,
      excerpt: { start: off - exLen, end: off },
      excerptStartSec: excerpt.start / item.sr,
      excerptDurSec: (excerpt.end - excerpt.start) / item.sr,
    });
    det = { cutoffHz: dsp.cutoffHz, rolloff: dsp.rolloff, hfOccupancy: dsp.hfOccupancy, hfSlope: dsp.hfSlope, sourceLimited: dsp.sourceLimited, bbFlatness: NaN, score: dsp.score };
    cls = dsp.qualityClass;
    regionsOf[item.name] = { lite: true, regions: regions.map((r) => [r.start / item.sr, r.end / item.sr]) };
  } else {
    // Mirror the app's region framing exactly.
    const regions = pickRegions(mono, item.sr);
    regionsOf[item.name] = { lite: false, regions: regions.map((r) => [r.start / item.sr, r.end / item.sr]) };
    const allFrames = [];
    const allRms = [];
    for (const r of regions) {
      const { magDb, frameRmsDb } = await stftPower(mono, r.start, r.end);
      allFrames.push(...magDb);
      for (let k = 0; k < frameRmsDb.length; k++) allRms.push(frameRmsDb[k]);
    }
    const frameRms = Float32Array.from(allRms);
    const meanDb = await meanSpectrum(allFrames, N_BINS, loudFrameMask(frameRms, allFrames.length));
    det = await detectCutoff(allFrames, item.sr, meanDb, frameRms);
    cls = classifyQuality(det.cutoffHz, item.sr / 2, det.rolloff, det.hfOccupancy,
      { bbFlatness: det.bbFlatness, sourceLimited: det.sourceLimited });
  }
  const { total: score } = det.score !== undefined ? { total: det.score } : scoreOf({
    cutoffHz: det.cutoffHz, nyquistHz: item.sr / 2, rolloff: det.rolloff,
    hfOccupancy: det.hfOccupancy, clipFraction: cc.clipFraction, bbFlatness: det.bbFlatness,
  });
  results[item.name] = { cutoffHz: Math.round(det.cutoffHz), rolloff: det.rolloff, cls, score: +score.toFixed(1), hfOcc: +det.hfOccupancy.toFixed(3), hfSlope: +det.hfSlope.toFixed(1), limited: det.sourceLimited, clip: cc.clipFraction };
  console.log(
    item.name.padEnd(26),
    String(Math.round(det.cutoffHz)).padStart(6),
    det.rolloff.padEnd(10),
    cls.padEnd(9),
    String(score.toFixed(1)).padStart(6),
    `crest=${cc.crestDb.toFixed(1)}`,
    `clip=${cc.clipFraction.toFixed(4)}`,
    det.sourceLimited ? "LIMITED" : "       ",
    `hfOcc=${det.hfOccupancy.toFixed(3)}`,
    `bbFlat=${det.bbFlatness.toFixed(3)}`,
  );
}

// Key A/B verdicts the app must get right.
const mkAnalysis = (name, item) => {
  const r = results[name];
  return {
    id: name, fileName: name, fileSize: 0, mimeType: "", objectUrl: "",
    durationSec: item.samples / item.sr, sampleRate: item.sr, channels: item.ch,
    container: { codec: item.kind === "mp3" ? "MP3" : item.kind === "transcode" || item.kind === "wav" ? "PCM" : item.kind, sampleRate: item.sr, channels: item.ch, bitDepth: 16, claimedKbps: item.kind === "mp3" ? item.kbps : item.kind === "wav" || item.kind === "transcode" ? 1411 : null, vbr: null },
    containerKbps: 0, cutoffHz: r.cutoffHz, nyquistHz: item.sr / 2,
    rolloff: r.rolloff, brickwallHz: null, qualityClass: r.cls, score: r.score,
    scoreParts: { ceiling: 0, rolloff: 0, air: 0, clarity: 0, clip: 0 },
    sourceLimited: !!r.limited, liteAnalysis: false,
    peakDb: 0, rmsDb: -14, crestDb: 14, clipFraction: 0, stereoWidth: 0,
    hfOccupancy: r.hfOcc, hfSlope: r.hfSlope, meanDb: new Float32Array(), meanDbHzPerBin: 0,
    spectrogram: { frames: new Float32Array(), nFrames: 0, nBins: 0, maxHz: 0, durationSec: 0, excerptStartSec: 0 },
  };
};
const byName = Object.fromEntries(manifest.items.map((i) => [i.name, i]));
for (const [x, y] of [["bright-mp3-320", "bright-mp3-128"], ["bright-mp3-128", "bright-mp3-96"], ["quiet-ref", "quiet-mp3-128"], ["quiet-ref", "quiet-mp3-64m"], ["bright-ref", "bright-mp364-to-wav"], ["bright-mp3-128", "bright-mp3128-to-mp3320"], ["sweep-ref", "sweep-mp3-128"], ["noisy-mp3-320", "noisy-mp3-192"],
["bright-aac-128", "bright-mp3-128"], ["bright-aac-256", "bright-mp3-320"], ["bright-ref", "bright-aac64-to-wav"], ["bright-aac-128", "bright-mp3128-to-aac256"], ["bright-opus-64", "bright-mp3-128"], ["bright-mp3-320", "bright-opus-64"], ["quiet-opus-64", "quiet-mp3-96"]]) {
  if (!results[x] || !results[y]) {
    console.log(`COMPARE ${x} vs ${y}: SKIP (missing)`);
    continue;
  }
  const c = compareAnalyses(mkAnalysis(x, byName[x]), mkAnalysis(y, byName[y]));
  console.log(`COMPARE ${x} vs ${y}: winner=${c.winner} conf=${c.confidence} | ${c.headline}`);
}

// ---- EXPECT: calibration invariants (exit 1 on any FAIL or XPASS) ----
// SKIP = item not in this corpus run (filter arg, or optional leg not built).
//
// KNOWN_GAPS: checks that currently fail for a known, accepted reason. Each
// entry pins the exact wrong outcome (`clsA/clsB` for same-class checks), so
// the check reports XFAIL (not counted) only while it fails the SAME way. A
// different wrong outcome is a FAIL; an unexpected pass is an XPASS (also a
// failure — delete the entry). Deferred to the 44.1 kHz detector
// recalibration PR; see README "Known gaps".
const KNOWN_GAPS = [
  { check: "same-class-48k", a: "bright-48k-aac-128", b: "bright-aac-128", outcome: "medium/standard",
    reason: "44.1k cut 16.9 kHz vs 48k 17.1 kHz straddles the 17 kHz class line" },
  { check: "same-class-48k", a: "bright-48k-aac-256", b: "bright-aac-256", outcome: "high/lossless",
    reason: "44.1k AAC-256 has no visible low-pass, reads false lossless" },
  { check: "same-class-48k", a: "noisy-48k-aac-256", b: "noisy-aac-256", outcome: "high/lossless",
    reason: "44.1k AAC-256 has no visible low-pass, reads false lossless" },
  { check: "same-class-48k", a: "quiet-48k-aac-64", b: "quiet-aac-64", outcome: "low/high",
    reason: "sparse 44.1k AAC-64 reads full band (no anchor for the real cut)" },
  { check: "same-class-48k", a: "quiet-48k-opus-64", b: "quiet-opus-64", outcome: "low/standard",
    reason: "sparse 44.1k Opus-64 cut reads ~15.9 kHz vs ~12 kHz at 48k" },
  { check: "same-class-48k", a: "sweep-48k-aac-128", b: "sweep-aac-128", outcome: "medium/lossless",
    reason: "sparse 44.1k AAC-128 sweep reads full band, false lossless" },
  { check: "same-class-48k", a: "sweep-48k-mp3-320", b: "sweep-mp3-320", outcome: "high/lossless",
    reason: "lamejs 44.1k MP3-320 sweep reads lossless vs libmp3lame 48k high" },
];
const gapKey = (check, a, b) => `${check} ${a} ~ ${b}`;
const gaps = new Map(KNOWN_GAPS.map((g) => [gapKey(g.check, g.a, g.b), { ...g, seen: false }]));
let expectFails = 0, expectPass = 0, expectSkip = 0, expectXfail = 0, expectXpass = 0;
// `outcome` = compact actual result, compared against a KNOWN_GAPS entry.
const expect = (label, ok, detail, outcome) => {
  const gap = gaps.get(label);
  if (gap) gap.seen = true;
  if (ok === null) { expectSkip++; console.log(`SKIP ${label} (${detail})`); return; }
  if (gap && ok) {
    expectXpass++;
    console.log(`XPASS ${label} | ${detail} — remove from KNOWN_GAPS`);
  } else if (gap && outcome === gap.outcome) {
    expectXfail++;
    console.log(`XFAIL ${label} | ${detail} (known gap: ${gap.reason})`);
  } else if (gap) {
    expectFails++;
    console.log(`FAIL ${label} | ${detail} (known gap changed: got ${outcome}, recorded ${gap.outcome})`);
  } else {
    if (ok) expectPass++; else expectFails++;
    console.log(`${ok ? "PASS" : "FAIL"} ${label} | ${detail}`);
  }
};
const desc = (n) => `${n}=${results[n].cls}@${results[n].cutoffHz}Hz/${results[n].rolloff}`;
const sameClass = (label, a, b) => {
  if (!results[a] || !results[b]) return expect(gapKey(label, a, b), null, "missing");
  expect(gapKey(label, a, b), results[a].cls === results[b].cls, `${desc(a)} vs ${desc(b)}`,
    `${results[a].cls}/${results[b].cls}`);
};
const isClass = (label, a, want) => {
  if (!results[a]) return expect(`${label} ${a}`, null, "missing");
  expect(`${label} ${a}`, results[a].cls === want, `${desc(a)} want=${want}`, results[a].cls);
};

// 1. 48 kHz grading: same signal + codec + bitrate must land in the same
//    class as its 44.1 kHz counterpart (counterpart = name minus "-48k").
for (const item of manifest.items) {
  if (!item.name.includes("-48k-") || item.kind === "alac") continue;
  sameClass("same-class-48k", item.name, item.name.replace("-48k", ""));
}
// 2. Long (40 s, >20 s loudness-ranked path) must classify like the 8 s items…
sameClass("same-class-long", "bright-long-ref", "bright-ref");
sameClass("same-class-long", "bright-long-aac-256", "bright-aac-256");
// …and the ranking must actually have skipped the quiet intro / fade-out.
for (const n of ["bright-long-ref", "bright-long-aac-256", "bright-long-alac"]) {
  const r = regionsOf[n];
  if (!r) { expect(`long-regions-loud ${n}`, null, "missing"); continue; }
  const inLoud = r.regions.length === 4 && r.regions.every(([s, e]) => s >= LONG_ENV.loudFrom - 0.01 && e <= LONG_ENV.loudTo + 0.01);
  expect(`long-regions-loud ${n}`, inLoud,
    `n=${r.regions.length} ${r.regions.map(([s, e]) => `${s.toFixed(1)}-${e.toFixed(1)}s`).join(",")} want 4 within ${LONG_ENV.loudFrom}-${LONG_ENV.loudTo}s`);
}
// 3. ALAC (moov at end) is lossless: must score lossless-class, like the
//    PCM references. NOTE: decoded by the FFmpeg fallback (decoder:"ffmpeg")
//    — Chromium/Firefox decodeAudioData cannot decode ALAC at all.
isClass("alac-lossless", "bright-long-alac", "lossless");
isClass("alac-lossless", "bright-48k-alac", "lossless");
sameClass("same-class-48k", "bright-48k-ref", "bright-ref");
// 4. Lite path (>15 min, optional LITE=1 leg) must classify like the short AAC-256.
{
  const r = regionsOf["bright-lite-aac-256"];
  if (r && !r.lite) expect("lite-path-taken bright-lite-aac-256", false, "item is not >15 min");
  sameClass("same-class-lite", "bright-lite-aac-256", "bright-aac-256");
}

// A KNOWN_GAPS entry no check ever reached is a typo or a renamed item.
for (const [key, g] of gaps) {
  if (!g.seen) { expectFails++; console.log(`FAIL ${key} | stale KNOWN_GAPS entry (no such check)`); }
}

console.log(`EXPECT: ${expectPass} pass, ${expectFails} fail, ${expectXfail} xfail, ${expectXpass} xpass, ${expectSkip} skip`);
process.exit(expectFails + expectXpass === 0 ? 0 : 1);
