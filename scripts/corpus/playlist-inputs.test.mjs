import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containedFile, loadCases } from "./playlist-inputs.mjs";

test("playlist inputs cannot escape their dedicated directory or select a listening library", () => {
  const parent = mkdtempSync(join(tmpdir(), "spectra-inputs-"));
  try {
    const root = join(parent, "audio-tests");
    mkdirSync(root);
    writeFileSync(join(parent, "library.mp3"), "private");
    writeFileSync(join(root, "copy.mp3"), "fixture");
    writeFileSync(
      join(root, "cases.json"),
      JSON.stringify({ cases: [{ a: "copy.mp3", b: "copy.mp3", expected: "neutral" }] }),
    );
    assert.throws(() => containedFile(root, "../library.mp3"), /escapes/);
    assert.throws(() => containedFile(root, join(parent, "library.mp3")), /relative/);
    assert.throws(() => loadCases(parent), /dedicated/);
    assert.throws(() => loadCases(root, 17), /between/);
    const plan = loadCases(root, 1);
    assert.equal(plan.cases.length, 1);
    assert.equal(plan.files.length, 1);
    assert.equal(plan.bytes, 7);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
