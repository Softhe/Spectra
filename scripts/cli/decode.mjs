// Node-side file loading for the CLI: hash, sniff and decode one audio file
// with FFmpeg into the AudioBuffer-shaped object the analysis code reads.
// Decode-rate rules mirror analyzeFile/decodeNative: decode at the
// container's rate (HE-AAC core rates lifted), else 48 kHz, and report
// whether the decode ran at the container's own rate.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import { decodeRateFor } from "../../src/lib/audio/analyze.ts";
import { sniffContainer } from "../../src/lib/audio/sniff.ts";

const MIB = 1024 ** 2;
/** Same compressed-size ceiling as the browser analyzer on a normal device. */
export const DEFAULT_MAX_FILE_BYTES = 600 * MIB;
/** Decoded float32 PCM ceiling per file (about 45 min of 48 kHz stereo). */
export const DEFAULT_MAX_DECODED_BYTES = 1024 * MIB;

/** Wall-clock ceiling for one decode, so a stalled FFmpeg cannot hold the server queue. */
export const DEFAULT_DECODE_TIMEOUT_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60 * 1000;

const FFMPEG = process.env.SPECTRA_FFMPEG || "ffmpeg";
const FFPROBE = process.env.SPECTRA_FFPROBE || "ffprobe";

// Inputs may be untrusted uploads. Allow only audio container demuxers and the
// local file protocol, so playlist- or concat-style inputs (HLS, ffconcat, ...)
// cannot make FFmpeg open other local files or network URLs.
const INPUT_GUARD = [
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  "flac,mp3,wav,w64,aiff,ogg,matroska,mov,aac,asf,caf,wv,ape,dsf,tta,mpc,mpc8,ac3,eac3,dts,truehd,amr,au",
];

/**
 * Resolve with `child`'s exit code once it closes. Reject if it cannot start,
 * or kill it and reject if it outlives `timeoutMs`.
 */
function settle(child, cmd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} did not finish within ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e.code === "ENOENT" ? new Error(`${cmd} was not found. Install FFmpeg.`) : e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function run(cmd, args, timeoutMs = PROBE_TIMEOUT_MS) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const out = [];
  let err = "";
  child.stdout.on("data", (d) => out.push(d));
  child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
  const code = await settle(child, cmd, timeoutMs);
  if (code !== 0) throw new Error(`${cmd} exited with code ${code}: ${err.trim()}`);
  return Buffer.concat(out);
}

export async function decoderVersion() {
  const out = await run(FFMPEG, ["-hide_banner", "-version"]);
  return out.toString("utf8").split("\n")[0].trim();
}

async function probe(path) {
  const out = await run(FFPROBE, [
    "-v",
    "error",
    ...INPUT_GUARD,
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_name,channels,sample_rate",
    "-of",
    "json",
    path,
  ]);
  const stream = JSON.parse(out.toString("utf8")).streams?.[0];
  if (!stream) throw new Error("The file has no audio stream.");
  return { codecName: stream.codec_name, channels: Number(stream.channels) };
}

/** Planar Float32 channels presented with AudioBuffer's read members. */
export function pcmAudioBuffer(channels, sampleRate) {
  const length = channels[0]?.length ?? 0;
  return {
    sampleRate,
    length,
    numberOfChannels: channels.length,
    duration: length / sampleRate,
    getChannelData: (c) => {
      if (c < 0 || c >= channels.length) throw new RangeError("channel index out of range");
      return channels[c];
    },
  };
}

async function decodePcm(path, rate, channels, maxDecodedBytes, timeoutMs) {
  const child = spawn(
    FFMPEG,
    [
      "-hide_banner",
      "-v",
      "error",
      "-nostdin",
      ...INPUT_GUARD,
      "-i",
      path,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-f",
      "f32le",
      "-acodec",
      "pcm_f32le",
      "-ar",
      String(rate),
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const chunks = [];
  let total = 0;
  let err = "";
  let tooLarge = false;
  child.stdout.on("data", (d) => {
    total += d.length;
    if (total > maxDecodedBytes) {
      tooLarge = true;
      child.kill();
      return;
    }
    chunks.push(d);
  });
  child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
  const code = await settle(child, FFMPEG, timeoutMs);
  if (tooLarge) {
    throw new Error(
      `The decoded audio exceeds ${Math.round(maxDecodedBytes / MIB)} MiB. Use a shorter file or raise --max-decoded-mb.`,
    );
  }
  if (code !== 0) throw new Error(`The file could not be decoded: ${err.trim() || `exit ${code}`}`);

  // Deinterleave chunk by chunk so the interleaved copy can be released early.
  const frameBytes = 4 * channels;
  const frames = Math.floor(total / frameBytes);
  const planar = Array.from({ length: channels }, () => new Float32Array(frames));
  let frame = 0;
  let carry = Buffer.alloc(0);
  for (let k = 0; k < chunks.length; k++) {
    let buf = carry.length ? Buffer.concat([carry, chunks[k]]) : chunks[k];
    chunks[k] = null;
    const usable = buf.length - (buf.length % frameBytes);
    for (let off = 0; off < usable && frame < frames; off += frameBytes, frame++) {
      for (let c = 0; c < channels; c++) planar[c][frame] = buf.readFloatLE(off + 4 * c);
    }
    carry = buf.subarray(usable);
  }
  return planar;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest("hex");
}

/**
 * Load one file for compareGroup: { info, audio, sha256 }.
 * `displayName` replaces the on-disk name in reports (HTTP uploads).
 */
export async function loadAudioFile(path, options = {}) {
  const {
    displayName = basename(path),
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    maxDecodedBytes = DEFAULT_MAX_DECODED_BYTES,
    decodeTimeoutMs = DEFAULT_DECODE_TIMEOUT_MS,
  } = options;
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${displayName} is not a regular file.`);
  if (info.size > maxFileBytes) {
    throw new Error(
      `${displayName} is larger than ${Math.round(maxFileBytes / MIB)} MiB. Raise --max-file-mb to analyze it.`,
    );
  }
  const handle = await open(path, "r");
  let bytes;
  try {
    bytes = await handle.readFile();
  } finally {
    await handle.close().catch(() => {});
  }
  const container = sniffContainer(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    displayName,
    "",
  );
  bytes = null;
  const [sha256, probed] = await Promise.all([sha256File(path), probe(path)]);
  // analyzeFile decodes at the sniffed rate; an unknown rate falls back to 48 kHz.
  const rate = decodeRateFor(container.sampleRate, container.codec) ?? 48000;
  const planar = await decodePcm(path, rate, probed.channels, maxDecodedBytes, decodeTimeoutMs);
  return {
    sha256,
    audio: pcmAudioBuffer(planar, rate),
    info: {
      fileName: displayName,
      fileSize: info.size,
      mimeType: "",
      objectUrl: "",
      container,
      cacheKey: null,
    },
  };
}
