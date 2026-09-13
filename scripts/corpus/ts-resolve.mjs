// Resolves extensionless TS relative imports (./fft -> ./fft.ts) so node
// --experimental-strip-types can import the repo's real source files.
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (
      err?.code === "ERR_MODULE_NOT_FOUND" &&
      (specifier.startsWith("./") || specifier.startsWith("../"))
    ) {
      const base = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`]) {
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
    }
    throw err;
  }
}
