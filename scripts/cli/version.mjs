import { readFileSync } from "node:fs";

export function version() {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  return pkg.version ?? "0.0.0";
}
