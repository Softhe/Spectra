import type { ContainerInfo } from "./types";

function ascii(bytes: Uint8Array, start: number, len: number): string {
  let s = "";
  const end = Math.min(bytes.length, start + len);
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

function findAscii(bytes: Uint8Array, tag: string, from = 0): number {
  const t0 = tag.charCodeAt(0);
  outer: for (let i = from; i <= bytes.length - tag.length; i++) {
    if (bytes[i] !== t0) continue;
    for (let j = 1; j < tag.length; j++) {
      if (bytes[i + j] !== tag.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

function skipId3(view: DataView): number {
  if (view.byteLength < 10) return 0;
  if (
    view.getUint8(0) === 0x49 &&
    view.getUint8(1) === 0x44 &&
    view.getUint8(2) === 0x33
  ) {
    const size =
      ((view.getUint8(6) & 0x7f) << 21) |
      ((view.getUint8(7) & 0x7f) << 14) |
      ((view.getUint8(8) & 0x7f) << 7) |
      (view.getUint8(9) & 0x7f);
    return Math.min(view.byteLength, 10 + size);
  }
  return 0;
}

const MP3_BITRATE: Record<string, number[]> = {
  // MPEG-1 Layer III
  "11-1": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  // MPEG-2/2.5 Layer III
  "01-1": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  "00-1": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};

const MP3_SR: Record<number, number[]> = {
  3: [44100, 48000, 32000, 0], // MPEG-1
  2: [22050, 24000, 16000, 0], // MPEG-2
  0: [11025, 12000, 8000, 0], // MPEG-2.5
};

function parseMp3(bytes: Uint8Array): ContainerInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = skipId3(view);
  while (offset + 4 < bytes.length) {
    if (bytes[offset] === 0xff && (bytes[offset + 1]! & 0xe0) === 0xe0) break;
    offset++;
    if (offset > 64 * 1024) return null;
  }
  if (offset + 4 >= bytes.length) return null;

  const b1 = bytes[offset + 1]!;
  const b2 = bytes[offset + 2]!;
  const b3 = bytes[offset + 3]!;
  const verBits = (b1 >> 3) & 0x3;
  const layerBits = (b1 >> 1) & 0x3;
  const bitrateIndex = (b2 >> 4) & 0xf;
  const srIndex = (b2 >> 2) & 0x3;
  const channelMode = (b3 >> 6) & 0x3;
  const versionKey = verBits === 3 ? 3 : verBits === 2 ? 2 : verBits === 0 ? 0 : -1;
  const layer = layerBits === 1 ? 1 : layerBits === 2 ? 2 : layerBits === 3 ? 3 : 0;
  if (versionKey < 0 || layer !== 1) {
    return {
      codec: "MP3",
      sampleRate: null,
      channels: channelMode === 3 ? 1 : 2,
      bitDepth: null,
      claimedKbps: null,
      vbr: null,
    };
  }
  const verFlag = versionKey === 3 ? "11" : versionKey === 2 ? "01" : "00";
  const table = MP3_BITRATE[`${verFlag}-1`];
  const srTable = MP3_SR[versionKey];
  const firstKbps = table?.[bitrateIndex] ?? null;
  const sampleRate = srTable?.[srIndex] || null;

  // VBR headers live in the first frame: bound the search there instead of
  // scanning 512 KB of audio bytes for false "Xing" hits. A LAME VBR file's
  // first frame is often a 32 kbps placeholder, so the first-frame index is
  // NOT the file's bitrate — report unknown and let size/duration speak.
  const head = bytes.subarray(offset, Math.min(bytes.length, offset + 4096));
  const xingAt = findAscii(head, "Xing");
  const infoAt = findAscii(head, "Info");
  const vbriAt = findAscii(head, "VBRI");
  const tagged = xingAt !== -1 || infoAt !== -1 || vbriAt !== -1;
  let vbr: boolean | null =
    xingAt !== -1 || vbriAt !== -1 ? true : infoAt !== -1 ? false : null;

  let claimedKbps = vbr === true ? null : firstKbps || null;
  // Tagless VBR (no Xing/Info/VBRI): the first frame alone is a placeholder —
  // walking real frames and finding differing bitrates is the only honest
  // answer here, same as for Xing-tagged files. Frame length follows the
  // Layer III formulas (144 slots MPEG-1, 72 MPEG-2/2.5). Stop on any header
  // that doesn't parse — a conservative miss keeps the old first-frame claim.
  if (!tagged && claimedKbps !== null && sampleRate) {
    const slots = verFlag === "11" ? 144 : 72;
    const frameLen = (pos: number): number | null => {
      const b2 = bytes[pos + 2]!;
      const kbps = table?.[(b2 >> 4) & 0xf] ?? 0;
      if (!kbps) return null;
      return Math.floor((slots * kbps * 1000) / sampleRate) + ((b2 >> 1) & 1);
    };
    const seen = new Set<number>([firstKbps!]);
    let pos = offset;
    for (let f = 0; f < 48 && pos + 4 < bytes.length; f++) {
      const len = frameLen(pos);
      if (len === null || len <= 0 || pos + len + 4 > bytes.length) break;
      pos += len;
      if (bytes[pos] !== 0xff || (bytes[pos + 1]! & 0xe0) !== 0xe0) break;
      const next = table?.[(bytes[pos + 2]! >> 4) & 0xf] ?? 0;
      if (!next) break;
      seen.add(next);
    }
    if (seen.size >= 2) {
      vbr = true;
      claimedKbps = null;
    }
  }

  return {
    codec: "MP3",
    sampleRate,
    channels: channelMode === 3 ? 1 : 2,
    bitDepth: null,
    claimedKbps,
    vbr,
  };
}

function parseWav(bytes: Uint8Array): ContainerInfo | null {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") return null;
  let i = 12;
  while (i + 8 < bytes.length) {
    const id = ascii(bytes, i, 4);
    const size =
      bytes[i + 4]! |
      (bytes[i + 5]! << 8) |
      (bytes[i + 6]! << 16) |
      (bytes[i + 7]! << 24);
    if (id === "fmt " && i + 16 < bytes.length) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const channels = view.getUint16(i + 10, true);
      const sampleRate = view.getUint32(i + 12, true);
      const byteRate = view.getUint32(i + 16, true);
      const bitDepth = view.getUint16(i + 22, true);
      const claimedKbps = sampleRate > 0 ? Math.round((byteRate * 8) / 1000) : null;
      const audioFormat = view.getUint16(i + 8, true);
      const codec =
        audioFormat === 1
          ? "PCM"
          : audioFormat === 3
            ? "PCM float"
            : audioFormat === 0xfffe
              ? "WAV"
              : "WAV";
      return {
        codec,
        sampleRate,
        channels,
        bitDepth,
        claimedKbps,
        vbr: false,
      };
    }
    i += 8 + size + (size % 2);
  }
  return { codec: "WAV", sampleRate: null, channels: null, bitDepth: null, claimedKbps: null, vbr: false };
}

function parseFlac(bytes: Uint8Array): ContainerInfo | null {
  // Tagged FLACs start with an ID3v2 prefix — skip it before the fLaC check.
  let base = 0;
  if (ascii(bytes, 0, 3) === "ID3" && bytes.length > 10) {
    const size =
      ((bytes[6]! & 0x7f) << 21) |
      ((bytes[7]! & 0x7f) << 14) |
      ((bytes[8]! & 0x7f) << 7) |
      (bytes[9]! & 0x7f);
    base = Math.min(bytes.length, 10 + size);
  }
  if (ascii(bytes, base, 4) !== "fLaC") return null;
  // STREAMINFO block starts at base+8; sample rate is 20 bits at base+18.
  if (bytes.length < base + 26) {
    return { codec: "FLAC", sampleRate: null, channels: null, bitDepth: 16, claimedKbps: null, vbr: true };
  }
  const sr =
    ((bytes[base + 18]! << 12) | (bytes[base + 19]! << 4) | (bytes[base + 20]! >> 4)) >>> 0;
  const channels = ((bytes[base + 20]! & 0x0e) >> 1) + 1;
  const bitDepth = ((bytes[base + 20]! & 0x01) << 4) + (bytes[base + 21]! >> 4) + 1;
  return {
    codec: "FLAC",
    sampleRate: sr || null,
    channels,
    bitDepth,
    claimedKbps: null,
    vbr: true,
  };
}

function readU32(bytes: Uint8Array, i: number, be = true): number {
  return be
    ? ((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!) >>> 0
    : (bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) >>> 0;
}

function parseMp4(bytes: Uint8Array): ContainerInfo | null {
  if (bytes.length < 12) return null;
  const ftyp = ascii(bytes, 4, 4);
  if (ftyp !== "ftyp" && ascii(bytes, 4, 4) !== "mdat" && ftyp !== "moov") {
    // Some M4A start with a wide atom then ftyp
    if (findAscii(bytes.subarray(0, 64), "ftyp") < 0) return null;
  }

  let codec = "AAC";
  const brand = ascii(bytes, 8, 4);
  if (brand === "M4A " || brand === "M4B " || brand === "mp42" || brand === "isom" || brand === "M4A") {
    codec = "AAC";
  }
  if (findAscii(bytes, "alac") >= 0) codec = "ALAC";
  // Opus-in-MP4 is identified by the dOps box the spec requires. Matching the
  // bare word "opus" instead flipped AAC files to "Opus" whenever the word
  // appeared in metadata (an album literally titled "Opus"), which then made
  // Safari decode errors blame the wrong codec.
  if (findAscii(bytes, "dOps") >= 0) codec = "Opus";

  let sampleRate: number | null = null;
  let channels: number | null = null;
  let claimedKbps: number | null = null;

  const mdhd = findAscii(bytes, "mdhd");
  if (mdhd >= 0 && mdhd + 32 < bytes.length) {
    // mdhd layout after the fourcc: version(1) + flags(3), then
    // v0: creation(4) + modification(4) + timescale(4: +16) + duration(4)
    // v1: creation(8) + modification(8) + timescale(4: +24) + duration(4).
    // (Reading duration here once resampled every M4A to a garbage rate —
    // duration-as-hertz looks plausible for short files.)
    const version = bytes[mdhd + 4]!;
    if (version === 0) {
      sampleRate = readU32(bytes, mdhd + 16);
    } else if (version === 1) {
      sampleRate = readU32(bytes, mdhd + 24);
    }
    if (sampleRate !== null && (sampleRate < 8000 || sampleRate > 384000)) {
      sampleRate = null;
    }
  }

  const esds = findAscii(bytes, "esds");
  if (esds >= 0 && esds + 40 < bytes.length) {
    // DecoderConfigDescriptor order is …, maxBitrate, avgBitrate: the first
    // plausible u32 is usually the MAX, so take the last valid one — the
    // average — instead of overstating the header claim.
    let last: number | null = null;
    for (let i = esds + 8; i < Math.min(esds + 80, bytes.length - 4); i++) {
      const v = readU32(bytes, i);
      if (v > 16_000 && v < 2_000_000) last = Math.round(v / 1000);
    }
    claimedKbps = last;
  }

  const chnl = findAscii(bytes, "mp4a");
  if (chnl >= 0 && chnl + 16 < bytes.length) {
    channels = (bytes[chnl + 17]! << 8) | bytes[chnl + 18]!;
    if (channels < 1 || channels > 8) channels = 2;
  }

  return { codec, sampleRate, channels, bitDepth: codec === "ALAC" ? 24 : 16, claimedKbps, vbr: true };
}

function parseOgg(bytes: Uint8Array): ContainerInfo | null {
  if (ascii(bytes, 0, 4) !== "OggS") return null;
  if (findAscii(bytes.subarray(0, 128), "OpusHead") >= 0) {
    const head = findAscii(bytes, "OpusHead");
    const channels = head >= 0 && head + 9 < bytes.length ? bytes[head + 9]! : 2;
    return { codec: "Opus", sampleRate: 48000, channels, bitDepth: null, claimedKbps: null, vbr: true };
  }
  if (findAscii(bytes.subarray(0, 128), "vorbis") >= 0) {
    // Parse the identification packet properly: 0x01 + "vorbis" at a packet
    // start, then channels (1 byte) and sample rate (LE u32). Matching a
    // bare "vorbis" string can land in the comment header and decode garbage.
    const magic = [0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]; // \x01vorbis
    let channels: number | null = null;
    let sampleRate: number | null = null;
    outer: for (let i = 0; i + 14 < bytes.length && i < 64 * 1024; i++) {
      if (bytes[i] !== 0x01) continue;
      for (let j = 0; j < magic.length; j++) {
        if (bytes[i + j] !== magic[j]) continue outer;
      }
      channels = bytes[i + 11]!;
      sampleRate = readU32(bytes, i + 12, false);
      break;
    }
    return { codec: "Vorbis", sampleRate, channels, bitDepth: null, claimedKbps: null, vbr: true };
  }
  return { codec: "Ogg", sampleRate: null, channels: null, bitDepth: null, claimedKbps: null, vbr: true };
}

/** IEEE 754 80-bit extended float (big-endian) — AIFF COMM sample rates. */
function readExtended(view: DataView, off: number): number {
  const se = view.getUint16(off, false);
  const exp = (se & 0x7fff) - 16383;
  const hi = view.getUint32(off + 2, false);
  const lo = view.getUint32(off + 6, false);
  const mantissa = hi * 4294967296 + lo;
  return (se & 0x8000 ? -mantissa : mantissa) * Math.pow(2, exp - 63);
}

const validRate = (hz: number | null): number | null =>
  hz != null && Number.isFinite(hz) && hz >= 8000 && hz <= 384000 ? hz : null;

// AIFF never carries an MP3 frame-sync pattern in its header region, and its
// FORM/AIFF magic is specific — but its raw PCM body CAN contain bytes that
// look like a frame sync, so it must be parsed before parseMp3 gets a turn.
function parseAiff(bytes: Uint8Array): ContainerInfo | null {
  if (ascii(bytes, 0, 4) !== "FORM") return null;
  const form = ascii(bytes, 8, 4);
  if (form !== "AIFF" && form !== "AIFC") return null;
  let i = 12;
  while (i + 8 < bytes.length) {
    const id = ascii(bytes, i, 4);
    const size = readU32(bytes, i + 4);
    if (id === "COMM" && i + 26 <= bytes.length) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const channels = view.getUint16(i + 8, false);
      const sampleRate = readExtended(view, i + 8 + 6);
      const bitDepth = view.getUint16(i + 8 + 16, false);      return {
        codec: "AIFF",
        sampleRate: validRate(sampleRate),
        channels: channels >= 1 && channels <= 8 ? channels : null,
        bitDepth: bitDepth >= 1 && bitDepth <= 64 ? bitDepth : null,
        claimedKbps: null,
        vbr: false,
      };
    }
    // Chunks are word-aligned: odd sizes carry one pad byte.
    i += 8 + size + (size % 2);
  }
  return {
    codec: "AIFF",
    sampleRate: null,
    channels: null,
    bitDepth: null,
    claimedKbps: null,
    vbr: false,
  };
}

function parseCaf(bytes: Uint8Array): ContainerInfo | null {
  if (ascii(bytes, 0, 4) !== "caff") return null;
  // Chunk headers use a big-endian u64 size: 4cc + 8 bytes.
  let i = 8;
  while (i + 12 <= bytes.length) {
    const id = ascii(bytes, i, 4);
    const size = readU32(bytes, i + 4) * 4294967296 + readU32(bytes, i + 8);
    if (id === "info" && size >= 28 && i + 12 + 28 <= bytes.length) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const o = i + 12;
      const sampleRate = view.getFloat64(o, false);
      const channels = view.getUint32(o + 20, false);
      const bitDepth = view.getUint32(o + 24, false);
      return {
        codec: "CAF",
        sampleRate: validRate(sampleRate),
        channels: channels >= 1 && channels <= 8 ? channels : null,
        bitDepth: bitDepth >= 1 && bitDepth <= 64 ? bitDepth : null,
        claimedKbps: null,
        vbr: false,
      };
    }
    i += 12 + size + (size % 2);
  }
  return {
    codec: "CAF",
    sampleRate: null,
    channels: null,
    bitDepth: null,
    claimedKbps: null,
    vbr: false,
  };
}

function fromExt(name: string, mime: string): string {  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    mp3: "MP3",
    m4a: "AAC",
    aac: "AAC",
    mp4: "AAC",
    wav: "WAV",
    wave: "WAV",
    flac: "FLAC",
    ogg: "Vorbis",
    opus: "Opus",
    aiff: "AIFF",
    aif: "AIFF",
    caf: "CAF",
    webm: "Opus",
  };
  if (map[ext]) return map[ext]!;
  if (mime.includes("mpeg")) return "MP3";
  if (mime.includes("mp4") || mime.includes("aac")) return "AAC";
  if (mime.includes("wav")) return "WAV";
  if (mime.includes("flac")) return "FLAC";
  if (mime.includes("ogg")) return "Vorbis";
  if (mime.includes("opus")) return "Opus";
  return mime.split("/")[1]?.toUpperCase() || "Audio";
}

export function sniffContainer(
  buffer: ArrayBuffer,
  fileName: string,
  mimeType: string,
): ContainerInfo {
  // Zero-copy view: the parsers only read the first bytes, so never copy
  // the whole file here (decodeAudioData gets its own copy later).
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 512 * 1024));
  const parsed =
    parseWav(bytes) ??
    parseFlac(bytes) ??
    parseOgg(bytes) ??
    parseMp4(bytes) ??
    parseAiff(bytes) ??
    parseCaf(bytes) ??
    parseMp3(bytes);

  if (parsed) {
    return {
      ...parsed,
      codec: parsed.codec || fromExt(fileName, mimeType),
    };
  }

  return {
    codec: fromExt(fileName, mimeType),
    sampleRate: null,
    channels: null,
    bitDepth: null,
    claimedKbps: null,
    vbr: null,
  };
}
