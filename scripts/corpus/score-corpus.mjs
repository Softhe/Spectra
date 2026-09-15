// Scores $CORPUS_DIR/items/*.f32 with the REAL detection functions from
// src/lib/audio/analyze.ts (no copies). Run from the repo root:
//   node --experimental-strip-types --no-warnings --loader ./scripts/corpus/ts-resolve.mjs ./scripts/corpus/score-corpus.mjs [name-filter]
import { readFileSync, readdirSync } from "node:fs";
import {
  classifyQuality,
  compareAnalyses,
  detectCutoff,
  loudFrameMask,
  meanSpectrum,
  pickRegions,
  scoreOf,
  stftPower,
} from "../../src/lib/audio/analyze.ts";

const CORPUS_DIR = process.env.CORPUS_DIR || "/tmp/corpus";
const FFT_SIZE = 4096;
const N_BINS = FFT_SIZE / 2;
const filter = process.argv[2] || "";
const manifest = JSON.parse(readFileSync(`${CORPUS_DIR}/manifest.json`, "utf8"));
const results = {};

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
  // Mirror the app's region framing exactly.
  const regions = pickRegions(mono, item.sr);
  const allFrames = [];
  const allRms = [];
  for (const r of regions) {
    const { magDb, frameRmsDb } = await stftPower(mono, r.start, r.end);
    allFrames.push(...magDb);
    for (let k = 0; k < frameRmsDb.length; k++) allRms.push(frameRmsDb[k]);
  }
  const frameRms = Float32Array.from(allRms);
  const meanDb = await meanSpectrum(allFrames, N_BINS, loudFrameMask(frameRms, allFrames.length));
  const det = await detectCutoff(allFrames, item.sr, meanDb, frameRms);
  const cls = classifyQuality(det.cutoffHz, item.sr / 2, det.rolloff, det.hfOccupancy,
    { bbFlatness: det.bbFlatness, sourceLimited: det.sourceLimited });
  const cc = crestClip(mono);
  const score = scoreOf({
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
    durationSec: 8, sampleRate: item.sr, channels: item.ch,
    container: { codec: item.kind === "mp3" ? "MP3" : item.kind === "transcode" || item.kind === "wav" ? "PCM" : item.kind, sampleRate: item.sr, channels: item.ch, bitDepth: 16, claimedKbps: item.kind === "mp3" ? item.kbps : item.kind === "wav" || item.kind === "transcode" ? 1411 : null, vbr: null },
    containerKbps: 0, cutoffHz: r.cutoffHz, nyquistHz: item.sr / 2,
    rolloff: r.rolloff, brickwallHz: null, qualityClass: r.cls, score: r.score,
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
