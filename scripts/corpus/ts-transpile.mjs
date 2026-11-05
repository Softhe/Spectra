// Fallback load hook for Node builds compiled WITHOUT TypeScript support
// (some distro v24+ builds): those reject --experimental-strip-types with
// ERR_NO_TYPESCRIPT. Transpiles .ts/.mts test sources with the repo's own
// typescript package instead, so `npm test` runs on any Node.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const EXTENSIONS = [".ts", ".mts"];

export async function load(url, context, next) {
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Non-file URL — not ours.
  }
  if (!EXTENSIONS.some((ext) => pathname.endsWith(ext))) return next(url, context);
  const path = fileURLToPath(url);
  const source = await readFile(path, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
    },
    fileName: path,
  });
  return {
    format: "module",
    source: outputText,
    shortCircuit: true,
  };
}
