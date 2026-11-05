// Run both suites without shell globs or platform-specific status syntax.
import { mkdtempSync, readdirSync, writeFileSync as writeSync } from "node:fs";


import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { projectRoot } from "./with-app-env.mjs";

let failed = false;

// Node without TypeScript support accepts --experimental-strip-types but
// throws ERR_NO_TYPESCRIPT the moment it parses a .ts file. Probe by
// transpiling a real temp file, then fall back to a transpile loader so the
// TS suite runs on any Node build.
function nodeStripsTypescript() {
  const dir = mkdtempSync(join(tmpdir(), "spectra-ts-probe-"));
  const file = join(dir, "probe.ts");
  writeSync(file, "const n: number = 1;\nconsole.log(n);\n");
  return (
    spawnSync(process.execPath, ["--experimental-strip-types", file], {
      encoding: "utf8",
    }).status === 0
  );
}
const tsOptions = nodeStripsTypescript()
  ? ["--experimental-strip-types", "--loader", "./scripts/corpus/ts-resolve.mjs"]
  : [
      "--loader",
      "./scripts/corpus/ts-resolve.mjs",
      "--loader",
      "./scripts/corpus/ts-transpile.mjs",
    ];

for (const [directory, suffix, options] of [
  ["scripts", ".test.mjs", []],
  ["src", ".test.ts", tsOptions],
]) {
  const files = readdirSync(`${projectRoot()}/${directory}`, { recursive: true })
    .filter((file) => file.endsWith(suffix))
    .sort()
    .map((file) => `${directory}/${file}`);
  const result = spawnSync(process.execPath, [...options, "--test", ...files], {
    cwd: projectRoot(),
    stdio: "inherit",
  });
  if (result.error) console.error(result.error.message);
  failed ||= result.status !== 0;
}
process.exitCode = failed ? 1 : 0;
