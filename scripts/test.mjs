// Run both suites without shell globs or platform-specific status syntax.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { projectRoot } from "./with-app-env.mjs";

let failed = false;
for (const [directory, suffix, options] of [
  ["scripts", ".test.mjs", []],
  [
    "src",
    ".test.ts",
    ["--experimental-strip-types", "--loader", "./scripts/corpus/ts-resolve.mjs"],
  ],
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
