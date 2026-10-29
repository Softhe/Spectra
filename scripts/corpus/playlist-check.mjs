// Opt-in local audio regression runner. Never discovers or modifies a library.
import { createServer } from "node:http";
import { createReadStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { chromium } from "playwright";
import { checkedUrl } from "../browser-guard.mjs";
import { loadCases, fileHash } from "./playlist-inputs.mjs";

const args = process.argv.slice(2);
const directory = args[0];
if (!directory)
  throw new Error(
    "Usage: node scripts/corpus/playlist-check.mjs <audio-tests/dataset> [loopback-app-url] [pair-limit] [offset]",
  );
const appUrl = checkedUrl(args[1] || "http://127.0.0.1:8080/");
const plan = loadCases(directory, Number(args[2] || 8), Number(args[3] || 0));
const output = join(plan.root, "runs", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
const inputs = [];
for (const path of plan.files) {
  const probe = JSON.parse(
    execFileSync(
      process.env.FFPROBE || "ffprobe",
      ["-v", "error", "-show_format", "-show_streams", "-of", "json", path],
      { encoding: "utf8", timeout: 30000, maxBuffer: 1024 ** 2 },
    ),
  );
  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 600)
    throw new Error("Input duration must be known and at most ten minutes.");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const decodedBytes = duration * Number(audio?.sample_rate) * Number(audio?.channels) * 4;
  if (!Number.isFinite(decodedBytes) || decodedBytes <= 0 || decodedBytes > 256 * 1024 ** 2)
    throw new Error("Decoded audio exceeds the 256 MiB per-file budget.");
  inputs.push({ path, sha256: await fileHash(path), probe });
}
const server = createServer((request, response) => {
  const match = /^\/file\/(\d+)$/.exec(request.url || "");
  const input = match && inputs[Number(match[1])];
  if (request.method !== "GET" || !input) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, {
    "Access-Control-Allow-Origin": new URL(appUrl).origin,
    "Content-Type": "application/octet-stream",
    "Content-Length": statSync(input.path).size,
  });
  const stream = createReadStream(input.path);
  stream.on("error", () => response.destroy());
  response.on("close", () => stream.destroy());
  stream.pipe(response);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
let browser;
const results = [];
const interrupt = () => {
  process.exitCode = 130;
  void browser?.close();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  browser = await chromium.launch();
  writeFileSync(
    join(output, "manifest.json"),
    JSON.stringify(
      {
        node: process.version,
        browser: browser.version(),
        ffprobe: execFileSync(process.env.FFPROBE || "ffprobe", ["-version"], {
          encoding: "utf8",
        }).split("\n")[0],
        cases: plan.cases,
        inputs,
      },
      null,
      2,
    ),
  );
  for (const item of plan.cases) {
    console.log(`Analyzing ${item.id}, sequentially.`);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(appUrl, { waitUntil: "networkidle" });
      const result = await page.evaluate(
        async (urls) => {
          const { analyzeFile, compareAnalyses } = await import("/src/lib/audio/analyze.ts");
          const { alignGroup, refineAnalyses } = await import("/src/lib/audio/refine.ts");
          const { analysisWithRefined } = await import("/src/lib/audio/rank.ts");
          const analyses = [];
          const signal = AbortSignal.timeout(120000);
          try {
            for (const [i, url] of urls.entries()) {
              const response = await fetch(url);
              if (!response.ok) throw new Error("Fixture fetch failed.");
              analyses.push(
                await analyzeFile(
                  new File([await response.blob()], `copy-${i}`, { lastModified: 1 }),
                  undefined,
                  signal,
                ),
              );
            }
            const alignment = alignGroup(analyses);
            const refinement = alignment
              ? await refineAnalyses(analyses, alignment, undefined, signal)
              : null;
            const [a, b] = analyses.map((file) =>
              analysisWithRefined(file, refinement?.refined[file.id], true),
            );
            const summarize = (file) => ({
              score: file.score,
              cutoffHz: file.cutoffHz,
              codec: file.container.codec,
              coverage: file.comparisonCoverage,
            });
            return { a: summarize(a), b: summarize(b), verdict: compareAnalyses(a, b) };
          } finally {
            for (const file of analyses) URL.revokeObjectURL(file.objectUrl);
          }
        },
        [item.a, item.b].map(
          (file) =>
            `http://127.0.0.1:${port}/file/${inputs.findIndex((input) => input.path === file)}`,
        ),
      );
      const failed =
        item.expected === "neutral"
          ? result.verdict.winner !== "tie"
          : item.expected === "different"
            ? result.verdict.identityStatus !== "different" || result.verdict.winner !== "tie"
            : item.expected === "b-parent"
              ? result.verdict.winner === "a"
              : false;
      results.push({ id: item.id, expected: item.expected, failed, ...result });
      if (failed) {
        process.exitCode = 1;
        break;
      }
    } catch (error) {
      results.push({ id: item.id, error: error.message });
      process.exitCode = 1;
      break;
    } finally {
      await context.close();
      writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2));
    }
  }
  for (const input of inputs)
    if ((await fileHash(input.path)) !== input.sha256)
      throw new Error("Test input changed during the run.");
  console.log(`Saved ${results.length} results in the local test directory.`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
