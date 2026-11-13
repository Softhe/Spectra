#!/usr/bin/env node
// Entry point for the Spectra command-line tool and HTTP API. Installs
// in-process TypeScript hooks equivalent to scripts/corpus/ts-resolve.mjs
// (+ ts-transpile.mjs where Node cannot strip types), so the CLI runs the
// real analysis sources on any Node 22+ build, then hands off to
// scripts/cli/main.mjs.
//
//   node scripts/spectra-cli.mjs compare <file> <file> [file] [file] [--json]
//   node scripts/spectra-cli.mjs serve [--host 127.0.0.1] [--port 8787]
import * as mod from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const stripsTypes = Boolean(process.features?.typescript);

if (typeof mod.registerHooks === "function") {
  // Synchronous hooks (Node 22.15+/23.5+): no deprecated loader thread.
  let ts = null;
  if (!stripsTypes) ts = (await import("typescript")).default;
  mod.registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (err) {
        if (
          err?.code === "ERR_MODULE_NOT_FOUND" &&
          (specifier.startsWith("./") || specifier.startsWith("../")) &&
          context.parentURL
        ) {
          const base = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
          for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`]) {
            if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
          }
        }
        throw err;
      }
    },
    load(url, context, next) {
      if (ts && url.startsWith("file:") && /\.m?ts$/.test(new URL(url).pathname)) {
        const path = fileURLToPath(url);
        const { outputText } = ts.transpileModule(readFileSync(path, "utf8"), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
          fileName: path,
        });
        return { format: "module", source: outputText, shortCircuit: true };
      }
      return next(url, context);
    },
  });
} else {
  mod.register("./corpus/ts-resolve.mjs", import.meta.url);
  if (!stripsTypes) mod.register("./corpus/ts-transpile.mjs", import.meta.url);
}

const { main } = await import("./cli/main.mjs");
process.exitCode = await main(process.argv.slice(2));
