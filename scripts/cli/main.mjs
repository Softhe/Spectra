// Spectra command-line tool: compare copies of a recording from a shell or
// over HTTP with the analyzer's own decision rules. Launch through
// scripts/spectra-cli.mjs (it installs the TypeScript loader).
import { compareFiles } from "./compare.mjs";
import { serve } from "./server.mjs";
import { formatSummary } from "./format.mjs";
import { version } from "./version.mjs";

const USAGE = `Spectra command-line tool

Usage:
  spectra compare <file> <file> [file] [file] [options]
  spectra serve [options]

compare options:
  --json                 Print the full JSON report instead of a summary.
  --no-equivalence       Skip the complete decoded-sample comparison.
  --max-file-mb <n>      Largest input file (default 600).
  --max-decoded-mb <n>   Largest decoded PCM per file (default 1024).

serve options:
  --host <addr>          Listen address (default 127.0.0.1).
  --port <n>             Listen port (default 8787).
  --token <secret>       Require "Authorization: Bearer <secret>"; also read
                         from SPECTRA_TOKEN. Mandatory for non-loopback hosts.
  --max-upload-mb <n>    Largest request body (default 1024).
  --max-file-mb, --max-decoded-mb as for compare.

compare exit codes: 0 report produced, 1 analysis error, 2 usage error.
FFmpeg and ffprobe must be on PATH (or set SPECTRA_FFMPEG / SPECTRA_FFPROBE).
Results are estimates, not certification of an original master or of audibility.`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const valued = new Set([
    "host",
    "port",
    "token",
    "max-file-mb",
    "max-decoded-mb",
    "max-upload-mb",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
      if (valued.has(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined) throw new UsageError(`--${name} needs a value.`);
        flags[name] = value;
      } else if (["json", "no-equivalence", "help", "version"].includes(name)) {
        flags[name] = true;
      } else {
        throw new UsageError(`Unknown option --${name}.`);
      }
    } else if (arg === "-h") {
      flags.help = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

class UsageError extends Error {}

function mib(flags, name, fallback) {
  if (flags[name] === undefined) return fallback;
  const n = Number(flags[name]);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} must be a positive number.`);
  return Math.round(n * 1024 * 1024);
}

function limits(flags) {
  return {
    maxFileBytes: mib(flags, "max-file-mb", undefined),
    maxDecodedBytes: mib(flags, "max-decoded-mb", undefined),
  };
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(err.message + "\n\n" + USAGE);
    return 2;
  }
  const { positional, flags } = parsed;
  const [command, ...rest] = positional;
  if (flags.version) {
    console.log(version());
    return 0;
  }
  if (flags.help || !command || command === "help") {
    console.log(USAGE);
    return command || flags.help ? 0 : 2;
  }
  if (command === "version") {
    console.log(version());
    return 0;
  }
  try {
    if (command === "compare") {
      if (rest.length < 2 || rest.length > 4) throw new UsageError("compare takes 2 to 4 files.");
      const report = await compareFiles(rest, {
        ...limits(flags),
        checkDecodedEquivalence: !flags["no-equivalence"],
      });
      console.log(flags.json ? JSON.stringify(report, null, 2) : formatSummary(report));
      return 0;
    }
    if (command === "serve") {
      const port = flags.port === undefined ? 8787 : Number(flags.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new UsageError("--port must be 0-65535.");
      await serve({
        host: flags.host ?? "127.0.0.1",
        port,
        token: flags.token ?? process.env.SPECTRA_TOKEN ?? "",
        maxUploadBytes: mib(flags, "max-upload-mb", 1024 * 1024 * 1024),
        ...limits(flags),
      });
      return 0;
    }
    throw new UsageError(`Unknown command '${command}'.`);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message + "\n\n" + USAGE);
      return 2;
    }
    console.error(`spectra: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
