// End-to-end checks for the command-line tool and HTTP API on real encodes.
// Needs FFmpeg with libmp3lame; skipped when it is unavailable.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "scripts/spectra-cli.mjs");
const FFMPEG = process.env.SPECTRA_FFMPEG || "ffmpeg";
const hasFfmpeg =
  spawnSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout?.includes(
    "libmp3lame",
  ) ?? false;

let dir = "";
const file = (name) => join(dir, name);

function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: ROOT });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function ffmpeg(...args) {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-v", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

describe("spectra CLI", { skip: !hasFfmpeg && "FFmpeg with libmp3lame not found" }, () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "spectra-cli-"));
    const gen = spawnSync(process.execPath, [join(ROOT, "scripts/corpus/gen-wavs.mjs")], {
      env: { ...process.env, CORPUS_DIR: dir },
      encoding: "utf8",
    });
    assert.equal(gen.status, 0, gen.stderr);
    const wav = join(dir, "wav/bright-long.wav");
    ffmpeg("-i", wav, "-c:a", "flac", file("song.flac"));
    ffmpeg("-i", wav, "-c:a", "libmp3lame", "-b:a", "128k", file("song-128.mp3"));
    ffmpeg("-ss", "3", "-i", wav, "-c:a", "flac", file("song-trimmed.flac"));
    ffmpeg("-i", join(dir, "wav/quiet.wav"), "-c:a", "flac", file("other.flac"));
    copyFileSync(wav, file("song.wav"));
    copyFileSync(file("song.flac"), file("song-copy.flac"));
  });
  after(() => dir && rmSync(dir, { recursive: true, force: true }));

  const report = (...files) => {
    const r = cli("compare", "--json", ...files.map(file));
    assert.equal(r.code, 0, r.stderr);
    return JSON.parse(r.stdout);
  };

  it("prefers the lossless parent over its 128 kbps MP3 in either order", () => {
    for (const order of [
      ["song.flac", "song-128.mp3"],
      ["song-128.mp3", "song.flac"],
    ]) {
      const r = report(...order);
      const flac = r.files.find((f) => f.fileName === "song.flac");
      assert.equal(r.recommendation.status, "preferred");
      assert.equal(r.recommendation.keep, flac.label);
      assert.equal(r.pairs[0].recordingMatch, "same");
      assert.ok(
        r.files.every((f) => f.shared),
        "both measured over shared passages",
      );
    }
  });

  it("aligns a trimmed copy before judging it", () => {
    const r = report("song-trimmed.flac", "song-128.mp3");
    assert.equal(r.recommendation.keep, "A");
    assert.ok(Math.abs(Math.abs(r.pairs[0].lagSec) - 3) < 0.3, `lag ${r.pairs[0].lagSec}`);
  });

  it("distinguishes identical bytes, identical audio and different recordings", () => {
    assert.equal(report("song.flac", "song-copy.flac").recommendation.status, "identical-bytes");
    const sameAudio = report("song.flac", "song.wav");
    assert.equal(sameAudio.recommendation.status, "identical-audio");
    assert.equal(sameAudio.pairs[0].identity.decoded.status, "exact");
    const different = report("song.flac", "other.flac");
    assert.equal(different.recommendation.status, "not-comparable");
    assert.equal(different.recommendation.keep, null);
  });

  it("prints a readable summary and uses distinct exit codes", () => {
    const ok = cli("compare", file("song.flac"), file("song-128.mp3"));
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /Recommendation: preferred -> keep A/);
    assert.equal(cli("compare", file("song.flac")).code, 2);
    const missing = cli("compare", file("song.flac"), file("missing.flac"));
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /missing\.flac/);
  });

  it("serves comparisons over HTTP and enforces the bearer token", async () => {
    const server = spawn(process.execPath, [CLI, "serve", "--port", "0", "--token", "t0ken"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const port = await new Promise((resolve, reject) => {
        let out = "";
        server.stdout.on("data", (d) => {
          out += d;
          const m = out.match(/listening on http:\/\/[^:]+:(\d+)/);
          if (m) resolve(Number(m[1]));
        });
        server.on("exit", (code) => reject(new Error(`server exited ${code}`)));
      });
      const base = `http://127.0.0.1:${port}`;
      const health = await fetch(`${base}/health`).then((r) => r.json());
      assert.equal(health.ok, true);

      const form = () => {
        const f = new FormData();
        f.append("file", new Blob([readFileSync(file("song.flac"))]), "song.flac");
        f.append("file", new Blob([readFileSync(file("song-128.mp3"))]), "song-128.mp3");
        return f;
      };
      const denied = await fetch(`${base}/compare`, { method: "POST", body: form() });
      assert.equal(denied.status, 401);

      const res = await fetch(`${base}/compare`, {
        method: "POST",
        body: form(),
        headers: { authorization: "Bearer t0ken" },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.recommendation.status, "preferred");
      assert.equal(
        body.files.find((f) => f.label === body.recommendation.keep).fileName,
        "song.flac",
      );
      assert.ok(
        body.files.every((f) => f.path === undefined),
        "server paths stay private",
      );

      const one = new FormData();
      one.append("file", new Blob([readFileSync(file("song.flac"))]), "song.flac");
      const bad = await fetch(`${base}/compare`, {
        method: "POST",
        body: one,
        headers: { authorization: "Bearer t0ken" },
      });
      assert.equal(bad.status, 400);
    } finally {
      server.kill();
    }
  });

  it("refuses to listen beyond loopback without a token", () => {
    const r = spawnSync(process.execPath, [CLI, "serve", "--host", "0.0.0.0", "--port", "0"], {
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env, SPECTRA_TOKEN: "" },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /requires --token/);
  });
});
