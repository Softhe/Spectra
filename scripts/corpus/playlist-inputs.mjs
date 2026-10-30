import { createHash } from "node:crypto";
import { createReadStream, readFileSync, realpathSync, statSync, statfsSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export function containedFile(root, name) {
  if (typeof name !== "string" || isAbsolute(name))
    throw new Error("Inputs must use relative paths.");
  const file = realpathSync(join(root, name));
  const rel = relative(realpathSync(root), file);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("Input escapes the test directory.");
  if (!statSync(file).isFile()) throw new Error("Input is not a file.");
  return file;
}

export async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function loadCases(directory, limit = 8, offset = 0) {
  const root = realpathSync(directory);
  if (!root.split(/[\\/]/).includes("audio-tests"))
    throw new Error("Use a dedicated audio-tests directory, never the listening library.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 16)
    throw new Error("Limit must be between 1 and 16 pairs.");
  if (!Number.isInteger(offset) || offset < 0)
    throw new Error("Offset must be a nonnegative integer.");
  const manifest = JSON.parse(readFileSync(join(root, "cases.json"), "utf8"));
  if (!Array.isArray(manifest.cases)) throw new Error("cases.json must contain a cases array.");
  for (const item of manifest.cases) {
    if (![undefined, "observational", "neutral", "different", "b-parent"].includes(item.expected)) {
      throw new Error("Unknown expected outcome in cases.json.");
    }
  }
  const cases = manifest.cases.slice(offset, offset + limit).map((item, index) => ({
    id: `pair-${offset + index + 1}`,
    expected: item.expected ?? "observational",
    a: containedFile(root, item.a),
    b: containedFile(root, item.b),
  }));
  if (!cases.length) throw new Error("No pairs selected.");
  const files = [...new Set(cases.flatMap((item) => [item.a, item.b]))];
  if (files.some((file) => statSync(file).size > 64 * 1024 ** 2))
    throw new Error("Each compressed input is limited to 64 MiB.");
  const bytes = files.reduce((sum, file) => sum + statSync(file).size, 0);
  if (bytes > 512 * 1024 ** 2) throw new Error("Selected inputs exceed 512 MiB.");
  const disk = statfsSync(root);
  if (disk.bavail * disk.bsize < Math.max(1024 ** 3, bytes * 3))
    throw new Error("Insufficient free space for a bounded test run.");
  return { root, cases, files, bytes };
}
