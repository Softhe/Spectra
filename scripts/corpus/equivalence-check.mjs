import { execFileSync } from "node:child_process";
import { fileHash } from "./playlist-inputs.mjs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createFixtures } from "./equivalence-fixtures.mjs";
import { checkedUrl } from "../browser-guard.mjs";
import { projectRoot } from "../with-app-env.mjs";
const appUrl = checkedUrl(process.argv[2] || "http://127.0.0.1:8080/");
const parent = resolve(process.argv[3] || join(projectRoot(), "audio-tests"));
if (!parent.split(/[\\/]/).includes("audio-tests"))
  throw Error("Use a dedicated audio-tests directory.");
mkdirSync(parent, { recursive: true });
if (!realpathSync(parent).split(/[\\/]/).includes("audio-tests"))
  throw Error("The test directory resolves outside audio-tests.");
const root = createFixtures(mkdtempSync(join(parent, "equivalence-")));
const output = join(root, "evidence");
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 950 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const results = [];
mkdirSync(output, { recursive: true });
const names = [
  "source.wav",
  "source.flac",
  "changed.wav",
  "float.wav",
  "tolerance.wav",
  "rate-48k.wav",
  "mono.wav",
  "oversized.flac",
  "metadata.wav",
  "layout.wav",
];
const hashes = Object.fromEntries(
  await Promise.all(names.map(async (name) => [name, await fileHash(join(root, name))])),
);
writeFileSync(
  join(output, "manifest.json"),
  JSON.stringify(
    {
      node: process.version,
      browser: browser.version(),
      ffmpeg: execFileSync(process.env.FF || "ffmpeg", ["-version"], { encoding: "utf8" }).split(
        "\n",
      )[0],
      fixtureVersion: 1,
      hashes,
    },
    null,
    2,
  ),
);
try {
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.id = "fixtures";
    document.body.appendChild(input);
  });
  await page
    .locator("#fixtures")
    .setInputFiles(
      [
        "source.wav",
        "source.flac",
        "changed.wav",
        "float.wav",
        "tolerance.wav",
        "rate-48k.wav",
        "mono.wav",
        "oversized.flac",
        "metadata.wav",
        "layout.wav",
      ].map((n) => root + "/" + n),
    );
  const cases = [
    ["source.wav", "metadata.wav", "exact"],
    ["source.wav", "layout.wav", "unavailable"],
    ["source.wav", "source.wav", "exact"],
    ["source.wav", "source.flac", "tolerance"],
    ["source.wav", "changed.wav", "different"],
    ["float.wav", "tolerance.wav", "tolerance"],
    ["source.wav", "rate-48k.wav", "different"],
    ["source.wav", "mono.wav", "different"],
    ["source.wav", "oversized.flac", "unavailable"],
  ];
  const selectedCases = process.argv.includes("--built") ? [] : cases;
  for (const [a, b, expected] of selectedCases) {
    const r = await page.evaluate(
      async ({ a, b }) => {
        const { verifyAudioFiles } = await import("/src/lib/audio/equivalence-browser.ts");
        const files = [...document.querySelector("#fixtures").files];
        return verifyAudioFiles(
          files.find((x) => x.name === a),
          files.find((x) => x.name === b),
        );
      },
      { a, b },
    );
    assert.equal(r.status, expected, JSON.stringify(r));
    results.push({ a, b, ...r });
    console.log(a, b, r.status);
  }
  await page.reload({ waitUntil: "networkidle" });
  await page
    .locator("input[type=file]")
    .nth(0)
    .setInputFiles(root + "/source.wav");
  await page.locator("audio[data-slot=a]").waitFor({ state: "attached", timeout: 120000 });
  await page
    .locator("input[type=file]")
    .nth(1)
    .setInputFiles(root + "/source.flac");
  await page
    .getByText("No clear quality difference detected", { exact: true })
    .waitFor({ timeout: 120000 });
  const check = page.getByRole("button", {
    name: "Check whether the audio is identical",
    exact: true,
  });
  await check.waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (x) => x.textContent.includes("Check whether the audio is identical") && !x.disabled,
    ),
  );
  let text = await page.locator("body").innerText();
  assert.ok(!text.includes("low evidence"));
  assert.ok(text.includes("The measured passages do not support a preference"));
  assert.ok(text.includes("totaling 16 seconds"));
  await check.click();
  await page
    .getByText("The decoded audio matches within tolerance", { exact: true })
    .waitFor({ timeout: 120000 });
  await page
    .getByRole("button", { name: "Copy comparison report to clipboard", exact: true })
    .click();
  const report = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(report.includes("PCM data rate: 1411 kbps"));
  assert.ok(report.includes("Compressed audio bitrate: Variable"));
  assert.ok(report.includes("Complete audio check: tolerance"));
  assert.ok(!report.includes("low evidence"));
  writeFileSync(output + "/report.txt", report);
  await page.screenshot({ path: output + "/desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: output + "/mobile.png", fullPage: true });

  await page.getByRole("button", { name: "Blind test", exact: true }).click();
  await page.getByRole("button", { name: "Reveal", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Check whether the audio is identical", exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Reveal", exact: true }).click();
  assert.equal(
    await page.getByText("The decoded audio matches within tolerance", { exact: true }).count(),
    0,
  );
  await check.click();
  await page.getByRole("button", { name: "Cancel check", exact: true }).click();
  await page.getByText("The check stopped before completion.", { exact: false }).waitFor();
  for (const name of names) assert.equal(await fileHash(join(root, name)), hashes[name]);
  assert.deepEqual(errors, []);
  writeFileSync(
    output + "/results.json",
    JSON.stringify({ results, errors, ui: "passed" }, null, 2),
  );
  console.log("All equivalence and UI checks passed");
} finally {
  await browser.close();
}
