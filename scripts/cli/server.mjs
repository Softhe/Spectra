// HTTP API for curl and scripts:
//   curl -F file=@a.flac -F file=@b.mp3 http://127.0.0.1:8787/compare
// Uploads go to a private temporary directory that is removed after each
// request. One comparison runs at a time; a short queue absorbs bursts.
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import { isIPv4 } from "node:net";
import { compareFiles } from "./compare.mjs";
import { formatSummary } from "./format.mjs";
import { version } from "./version.mjs";

const MAX_QUEUE = 4;

function isLoopback(host) {
  return host === "::1" || host === "localhost" || (isIPv4(host) && host.startsWith("127."));
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n";
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(text);
}

function authorized(req, token) {
  if (!token) return true;
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Request body as a web stream that errors once it passes `limit` bytes. */
function limitedBody(req, limit) {
  let seen = 0;
  const guard = new Transform({
    transform(chunk, _enc, done) {
      seen += chunk.length;
      if (seen > limit) done(Object.assign(new Error("too large"), { status: 413 }));
      else done(null, chunk);
    },
  });
  req.on("error", (e) => guard.destroy(e));
  return Readable.toWeb(req.pipe(guard));
}

/** Upload names are only shown in reports; disk names are fixed. */
function safeExt(name) {
  const ext = extname(name || "").toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

export function serve({ host, port, token, maxUploadBytes, ...limits }) {
  if (!isLoopback(host) && !token) {
    throw new Error("Listening on a non-loopback address requires --token or SPECTRA_TOKEN.");
  }
  let queue = Promise.resolve();
  // Requests holding a slot: parsing their upload, waiting, or comparing.
  let pending = 0;

  const server = createServer(async (req, res) => {
    let reserved = false;
    try {
      const url = new URL(req.url ?? "/", "http://spectra.local");
      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, version: version(), busy: pending > 0 });
      }
      if (req.method === "GET" && url.pathname === "/") {
        return send(
          res,
          200,
          "Spectra API\n\nPOST /compare  multipart/form-data with 2-4 audio files (any field names)\n" +
            "  ?format=text       plain-text summary instead of JSON\n" +
            "  ?equivalence=0     skip the complete decoded-sample comparison\n" +
            "GET  /health\n\n" +
            "Example: curl -F file=@a.flac -F file=@b.mp3 http://HOST:PORT/compare\n",
          "text/plain; charset=utf-8",
        );
      }
      if (url.pathname !== "/compare") return send(res, 404, { error: "Not found." });
      if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
      if (!authorized(req, token))
        return send(res, 401, { error: "Missing or wrong bearer token." });
      if (!/^multipart\/form-data/i.test(req.headers["content-type"] ?? "")) {
        return send(res, 415, { error: "Send the files as multipart/form-data (curl -F)." });
      }
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > maxUploadBytes) return send(res, 413, { error: "Upload too large." });
      // Reserve the slot before buffering the upload so concurrent requests
      // cannot all pass this check and exceed MAX_QUEUE.
      if (pending >= MAX_QUEUE) return send(res, 429, { error: "Busy. Retry shortly." });
      pending++;
      reserved = true;

      const form = await new Request("http://spectra.local/compare", {
        method: "POST",
        headers: { "content-type": req.headers["content-type"] },
        body: limitedBody(req, maxUploadBytes),
        duplex: "half",
      }).formData();
      const files = [...form.values()].filter(
        (v) => typeof v === "object" && v && "arrayBuffer" in v,
      );
      if (files.length < 2 || files.length > 4) {
        return send(res, 400, { error: "Upload 2 to 4 audio files." });
      }

      const job = queue.then(async () => {
        const dir = await mkdtemp(join(tmpdir(), "spectra-upload-"));
        try {
          const paths = [];
          for (let i = 0; i < files.length; i++) {
            const path = join(dir, `input-${i}${safeExt(files[i].name)}`);
            await writeFile(path, Buffer.from(await files[i].arrayBuffer()), { mode: 0o600 });
            paths.push(path);
          }
          return await compareFiles(paths, {
            ...limits,
            displayNames: files.map((f, i) => f.name || `file-${i + 1}`),
            includePaths: false,
            checkDecodedEquivalence: url.searchParams.get("equivalence") !== "0",
          });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
      queue = job.catch(() => {});
      const report = await job;
      return url.searchParams.get("format") === "text"
        ? send(res, 200, formatSummary(report) + "\n", "text/plain; charset=utf-8")
        : send(res, 200, report);
    } catch (err) {
      const status = err?.status ?? (err instanceof TypeError ? 400 : 422);
      if (!res.headersSent) {
        send(res, status, {
          error:
            status === 413
              ? "Upload too large."
              : err instanceof Error
                ? err.message
                : "The comparison failed.",
        });
      }
    } finally {
      if (reserved) pending--;
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      console.log(`Spectra API listening on http://${host}:${addr.port} (version ${version()})`);
      const stop = () => server.close(() => resolve());
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  });
}
