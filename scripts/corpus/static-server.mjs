// Tiny CORS-enabled static server for corpus tool assets. Run:
//   node scripts/corpus/static-server.mjs [root]   (default :8099)
// Serves:
//   /corpus/*        -> this directory (decode.html for the decode-dump step)
//   /corpus-files/*  -> $CORPUS_DIR (encoded audio; default /tmp/corpus)
//   /*               -> root (tool installs, e.g. a lamejs/ffmpeg checkout)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.argv[2] || "/tmp/corpus-tools";
const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = process.env.CORPUS_DIR || "/tmp/corpus";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg" };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/__beacon") {
      console.log("BEACON:", url.searchParams.get("m"));
      res.writeHead(200, { "Access-Control-Allow-Origin": "*" });
      res.end("ok");
      return;
    }
    const [file, allowed] = url.pathname === "/corpus/" || url.pathname.startsWith("/corpus/")
      ? [normalize(join(HERE, basename(url.pathname))), HERE]
      : url.pathname.startsWith("/corpus-files/")
        ? [normalize(join(CORPUS_DIR, url.pathname.slice("/corpus-files/".length))), CORPUS_DIR]
        : [normalize(join(ROOT, url.pathname)), ROOT];
    if (!file.startsWith(allowed)) throw new Error("escape");
    const data = await readFile(file);
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Content-Type": MIME[extname(file)] || "application/octet-stream",
      "Content-Length": data.length,
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    res.end("nf");
  }
}).listen(8099, "127.0.0.1", () => console.log("static :8099"));
