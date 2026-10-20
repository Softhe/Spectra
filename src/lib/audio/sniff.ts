import type { ContainerInfo } from "./types";

function ascii(bytes: Uint8Array, start: number, len: number): string {
  let s = "";
  const end = Math.min(bytes.length, start + len);
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

const validRate = (hz: number | null): number | null =>
  hz != null && Number.isFinite(hz) && hz >= 8000 && hz <= 384000 ? hz : null;

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

/** Xing / Info / VBRI: the LAME and Fraunhofer first-frame VBR headers. */
function hasVbrTag(frame: Uint8Array): boolean {
  return (
    findAscii(frame, "Xing") >= 0 || findAscii(frame, "Info") >= 0 || findAscii(frame, "VBRI") >= 0
  );
}

/** Offset past every leading ID3v2 tag. Taggers sometimes stack several,
 * and a tag with the footer flag (0x10) carries 10 more bytes. */
function skipId3(bytes: Uint8Array): number {
  let p = 0;
  while (p + 10 <= bytes.length && ascii(bytes, p, 3) === "ID3") {
    const size =
      ((bytes[p + 6]! & 0x7f) << 21) |
      ((bytes[p + 7]! & 0x7f) << 14) |
      ((bytes[p + 8]! & 0x7f) << 7) |
      (bytes[p + 9]! & 0x7f);
    p += 10 + size + (bytes[p + 5]! & 0x10 ? 10 : 0);
  }
  return Math.min(p, bytes.length);
}

const validChannels = (n: number | null | undefined): number | null =>
  n != null && Number.isInteger(n) && n >= 1 && n <= 32 ? n : null;

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

type Mp3Header = {
  verKey: number;
  srIndex: number;
  kbps: number;
  sampleRate: number;
  channelMode: number;
  /** Layer III frame length in bytes (144 slots MPEG-1, 72 MPEG-2/2.5). */
  len: number;
};

/** Decode a Layer III frame header at `pos`, or null if any field is reserved/invalid. */
function mp3Header(bytes: Uint8Array, pos: number): Mp3Header | null {
  if (pos + 4 > bytes.length) return null;
  if (bytes[pos] !== 0xff || (bytes[pos + 1]! & 0xe0) !== 0xe0) return null;
  const b1 = bytes[pos + 1]!;
  const b2 = bytes[pos + 2]!;
  const b3 = bytes[pos + 3]!;
  const verBits = (b1 >> 3) & 0x3;
  const layerBits = (b1 >> 1) & 0x3;
  const bitrateIndex = (b2 >> 4) & 0xf;
  const srIndex = (b2 >> 2) & 0x3;
  // Version 01 is reserved; only Layer III (01) is an MP3; bitrate 0 is "free"
  // and 15 is invalid; sample-rate index 3 and emphasis 10 are reserved.
  if (verBits === 1 || layerBits !== 1) return null;
  if (bitrateIndex === 0 || bitrateIndex === 15 || srIndex === 3) return null;
  if ((b3 & 0x3) === 2) return null;
  const verKey = verBits;
  const kbps = MP3_BITRATE[verKey === 3 ? "11-1" : verKey === 2 ? "01-1" : "00-1"]![bitrateIndex]!;
  const sampleRate = MP3_SR[verKey]![srIndex]!;
  const slots = verKey === 3 ? 144 : 72;
  const len = Math.floor((slots * kbps * 1000) / sampleRate) + ((b2 >> 1) & 1);
  return { verKey, srIndex, kbps, sampleRate, channelMode: (b3 >> 6) & 0x3, len };
}

function parseMp3(bytes: Uint8Array): ContainerInfo | null {
  const start = skipId3(bytes);
  // A lone 0xFFEx pair is everywhere in compressed data (WebM, AAC, noise),
  // so a candidate only counts once a second, independent check agrees: the
  // next frame (one frame length later) is a header with the same version and
  // sample rate, or the first frame carries a Xing/Info/VBRI tag. The single
  // exception is a header sitting exactly at the start of the stream (byte 0,
  // or where an ID3 tag ends) — a sync there is no accident of compressed data.
  const limit = Math.min(bytes.length - 4, start + 64 * 1024);
  let offset = -1;
  let first: Mp3Header | null = null;
  for (let pos = start; pos <= limit; pos++) {
    if (bytes[pos] !== 0xff) continue;
    const h = mp3Header(bytes, pos);
    if (!h) continue;
    const next = mp3Header(bytes, pos + h.len);
    const confirmed =
      (next !== null && next.verKey === h.verKey && next.srIndex === h.srIndex) ||
      pos === start ||
      hasVbrTag(bytes.subarray(pos, Math.min(bytes.length, pos + h.len)));
    if (confirmed) {
      offset = pos;
      first = h;
      break;
    }
  }
  if (!first) return null;

  // VBR headers live in the first frame: bound the search there instead of
  // scanning 512 KB of audio bytes for false "Xing" hits. A LAME VBR file's
  // first frame is often a 32 kbps placeholder, so the first-frame index is
  // NOT the file's bitrate — report unknown and let size/duration speak.
  const head = bytes.subarray(offset, Math.min(bytes.length, offset + 4096));
  const xingAt = findAscii(head, "Xing");
  const infoAt = findAscii(head, "Info");
  const vbriAt = findAscii(head, "VBRI");
  const tagged = xingAt !== -1 || infoAt !== -1 || vbriAt !== -1;
  let vbr: boolean | null = xingAt !== -1 || vbriAt !== -1 ? true : infoAt !== -1 ? false : null;

  let claimedKbps = vbr === true ? null : first.kbps;
  // Tagless VBR (no Xing/Info/VBRI): the first frame alone is a placeholder —
  // walking real frames and finding differing bitrates is the only honest
  // answer here, same as for Xing-tagged files. Frame length follows the
  // Layer III formulas (144 slots MPEG-1, 72 MPEG-2/2.5). Stop on any header
  // that doesn't parse (or switches version / sample rate) — a conservative
  // miss keeps the old first-frame claim.
  if (!tagged && claimedKbps !== null) {
    const seen = new Set<number>([first.kbps]);
    let pos = offset;
    let cur: Mp3Header = first;
    for (let f = 0; f < 48; f++) {
      pos += cur.len;
      const next = mp3Header(bytes, pos);
      if (!next || next.verKey !== first.verKey || next.srIndex !== first.srIndex) break;
      seen.add(next.kbps);
      cur = next;
    }
    if (seen.size >= 2) {
      vbr = true;
      claimedKbps = null;
    }
  }

  return {
    codec: "MP3",
    sampleRate: first.sampleRate,
    channels: first.channelMode === 3 ? 1 : 2,
    bitDepth: null,
    claimedKbps,
    vbr,
  };
}

const WAV_FORMATS: Record<number, string> = {
  0x0001: "PCM",
  0x0003: "PCM float",
  0x0002: "ADPCM",
  0x0011: "ADPCM",
  0x0006: "A-law",
  0x0007: "µ-law",
  0x0050: "MPEG",
  0x0055: "MP3",
  0x2000: "AC-3",
};

function parseWav(bytes: Uint8Array): ContainerInfo | null {
  // RF64/BW64 are RIFF with a ds64 chunk for >4 GB sizes; the fmt chunk is
  // identical, and the ds64 chunk is skipped by its own size below.
  const magic = ascii(bytes, 0, 4);
  if ((magic !== "RIFF" && magic !== "RF64" && magic !== "BW64") || ascii(bytes, 8, 4) !== "WAVE")
    return null;
  let i = 12;
  while (i + 8 < bytes.length) {
    const id = ascii(bytes, i, 4);
    // Unsigned: a signed read turned 0xFFFFFFF8 into -8, so `i += 8 + size`
    // never advanced and the page froze.
    const size = readU32(bytes, i + 4, false);
    if (id === "fmt " && i + 24 <= bytes.length) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const channels = view.getUint16(i + 10, true);
      const sampleRate = view.getUint32(i + 12, true);
      const byteRate = view.getUint32(i + 16, true);
      const bitDepth = view.getUint16(i + 22, true);
      const claimedKbps = sampleRate > 0 ? Math.round((byteRate * 8) / 1000) : null;
      let audioFormat = view.getUint16(i + 8, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the SubFormat GUID's
      // leading u16 (cbSize 22 → SubFormat at fmt+24).
      if (audioFormat === 0xfffe && size >= 40 && i + 34 <= bytes.length) {
        audioFormat = view.getUint16(i + 32, true);
      }
      // Only PCM and float are lossless. A lossy payload in a RIFF wrapper
      // (MP3, ADPCM, companded telephony) must not pass as "WAV", which the
      // verdict treats as a lossless container.
      const codec = WAV_FORMATS[audioFormat] ?? `RIFF 0x${audioFormat.toString(16)}`;
      return {
        codec,
        sampleRate: validRate(sampleRate),
        channels: validChannels(channels),
        bitDepth: bitDepth || null,
        claimedKbps,
        vbr: false,
      };
    }
    const next = i + 8 + size + (size % 2);
    if (!(next > i)) break;
    i = next;
  }
  return {
    codec: "WAV",
    sampleRate: null,
    channels: null,
    bitDepth: null,
    claimedKbps: null,
    vbr: false,
  };
}

function parseFlac(bytes: Uint8Array): ContainerInfo | null {
  // Tagged FLACs start with an ID3v2 prefix — skip it before the fLaC check.
  const base = skipId3(bytes);
  if (ascii(bytes, base, 4) !== "fLaC") return null;
  // STREAMINFO block starts at base+8; sample rate is 20 bits at base+18.
  if (bytes.length < base + 26) {
    return {
      codec: "FLAC",
      sampleRate: null,
      channels: null,
      bitDepth: 16,
      claimedKbps: null,
      vbr: true,
    };
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

type Mp4Box = { type: string; start: number; body: number; end: number };

/**
 * Walk sibling MP4 boxes in [from, to) by their size fields. Handles 64-bit
 * `size == 1` largesize and `size == 0` (extends to the end of the parent).
 * A box running past `to` is clipped (truncated file), and a malformed size or
 * non-printable fourcc ends the walk — never guess past garbage.
 */
function* mp4Boxes(bytes: Uint8Array, from: number, to: number, max = 4096): Generator<Mp4Box> {
  let i = from;
  for (let n = 0; n < max && i + 8 <= to; n++) {
    let size = readU32(bytes, i);
    let header = 8;
    if (size === 1) {
      if (i + 16 > to) return;
      size = readU32(bytes, i + 8) * 4294967296 + readU32(bytes, i + 12);
      header = 16;
    } else if (size === 0) {
      size = to - i;
    }
    if (size < header) return;
    for (let j = 4; j < 8; j++) {
      const c = bytes[i + j]!;
      // Printable ASCII plus 0xA9 ("©" in iTunes metadata atoms).
      if ((c < 0x20 || c > 0x7e) && c !== 0xa9) return;
    }
    const end = Math.min(to, i + size);
    yield { type: ascii(bytes, i + 4, 4), start: i, body: i + header, end };
    if (i + size >= to) return;
    i += size;
  }
}

function mp4Child(bytes: Uint8Array, parent: Mp4Box, type: string): Mp4Box | null {
  for (const b of mp4Boxes(bytes, parent.body, parent.end)) if (b.type === type) return b;
  return null;
}

/** Read a BER-style MPEG-4 descriptor length (1–4 bytes, 0x80 continuation). */
function descLen(bytes: Uint8Array, i: number, end: number): [len: number, next: number] | null {
  let len = 0;
  for (let k = 0; k < 4 && i < end; k++) {
    const b = bytes[i++]!;
    len = (len << 7) | (b & 0x7f);
    if (!(b & 0x80)) return [len, i];
  }
  return null;
}

/**
 * esds → DecoderConfigDescriptor: objectTypeIndication + avgBitrate. Returns
 * null when the descriptor chain doesn't parse so callers can fall back.
 */
function parseEsds(
  bytes: Uint8Array,
  box: Mp4Box,
): { objectType: number; avgKbps: number | null } | null {
  let i = box.body + 4; // version + flags
  const end = box.end;
  if (bytes[i] !== 0x03) return null;
  const es = descLen(bytes, i + 1, end);
  if (!es) return null;
  i = es[1];
  if (i + 3 > end) return null;
  const flags = bytes[i + 2]!;
  i += 3; // ES_ID(2) + flags(1)
  if (flags & 0x80) i += 2; // dependsOn_ES_ID
  if (flags & 0x40) i += 1 + (bytes[i] ?? 0); // URL
  if (flags & 0x20) i += 2; // OCR_ES_Id
  if (bytes[i] !== 0x04) return null;
  const dc = descLen(bytes, i + 1, end);
  if (!dc) return null;
  i = dc[1];
  if (i + 13 > end) return null;
  const avg = readU32(bytes, i + 9);
  return {
    objectType: bytes[i]!,
    avgKbps: avg > 16_000 && avg < 2_000_000 ? Math.round(avg / 1000) : null,
  };
}

/** Last plausible bitrate u32 in an esds region — the avg follows the max. */
function esdsHeuristicKbps(bytes: Uint8Array, at: number, end: number): number | null {
  let last: number | null = null;
  for (let i = at + 8; i < Math.min(at + 80, end - 4); i++) {
    const v = readU32(bytes, i);
    if (v > 16_000 && v < 2_000_000) last = Math.round(v / 1000);
  }
  return last;
}

// Rates an mdhd timescale may be taken at face value when the sample entry
// can't corroborate it (its 16.16 field tops out at 65535 Hz, or is zero).
const AUDIO_RATES = new Set([
  8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000, 176400, 192000,
  352800, 384000,
]);

const MP4_CODECS: Record<string, string> = {
  mp4a: "AAC",
  alac: "ALAC",
  Opus: "Opus",
  fLaC: "FLAC",
  "ac-3": "AC-3",
  "ec-3": "E-AC-3",
  ".mp3": "MP3",
  lpcm: "PCM",
  ipcm: "PCM",
  fpcm: "PCM",
  sowt: "PCM",
  twos: "PCM",
  in24: "PCM",
  in32: "PCM",
  fl32: "PCM float",
  fl64: "PCM float",
};

type Mp4Track = {
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
  bitDepth: number | null;
  claimedKbps: number | null;
};

/** mdhd timescale (v0 at body+12, v1 at body+20), validated. */
function mdhdRate(bytes: Uint8Array, box: Mp4Box): number | null {
  // Layout after the box header: version(1) + flags(3), then
  // v0: creation(4) + modification(4) + timescale(4) + duration(4)
  // v1: creation(8) + modification(8) + timescale(4) + duration(8).
  // (Reading duration here once resampled every M4A to a garbage rate —
  // duration-as-hertz looks plausible for short files.)
  const version = bytes[box.body];
  const at = version === 0 ? box.body + 12 : version === 1 ? box.body + 20 : -1;
  if (at < 0 || at + 4 > box.end) return null;
  return validRate(readU32(bytes, at));
}

/**
 * Parse the first sound track in a moov: codec from the stsd sample entry's
 * fourcc (never from text that happens to appear in metadata — "Palace" holds
 * "alac", an album titled "Opus" holds "Opus"), rates/channels/bit depth from
 * the sample entry and its codec config box.
 */
function parseMoov(bytes: Uint8Array, moov: Mp4Box): Mp4Track | null {
  for (const trak of mp4Boxes(bytes, moov.body, moov.end)) {
    if (trak.type !== "trak") continue;
    const mdia = mp4Child(bytes, trak, "mdia");
    if (!mdia) continue;
    const hdlr = mp4Child(bytes, mdia, "hdlr");
    // handler_type sits after version/flags + pre_defined; skip video/text.
    if (hdlr && hdlr.body + 12 <= hdlr.end && ascii(bytes, hdlr.body + 8, 4) !== "soun") continue;
    const mdhd = mp4Child(bytes, mdia, "mdhd");
    const minf = mp4Child(bytes, mdia, "minf");
    const stbl = minf && mp4Child(bytes, minf, "stbl");
    const stsd = stbl && mp4Child(bytes, stbl, "stsd");
    const timescale = mdhd ? mdhdRate(bytes, mdhd) : null;
    const track: Mp4Track = {
      codec: null,
      sampleRate: null,
      channels: null,
      bitDepth: null,
      claimedKbps: null,
    };
    // stsd: version/flags(4) + entry_count(4), then the sample entries.
    const entry = stsd ? mp4Boxes(bytes, stsd.body + 8, stsd.end, 1).next().value : undefined;
    if (!entry) {
      track.sampleRate = timescale !== null && AUDIO_RATES.has(timescale) ? timescale : null;
      return track;
    }
    track.codec = MP4_CODECS[entry.type] ?? (entry.type.trim().toUpperCase() || null);

    // AudioSampleEntry: reserved(6) + data_ref(2) + version(2) + revision(2) +
    // vendor(4) + channelcount(2) + samplesize(2) + compression(2) +
    // packetsize(2) + samplerate(16.16) = 28 bytes; QuickTime v1 adds 16
    // bytes before the child boxes, v2 replaces the layout entirely.
    const e = entry.body;
    const version = e + 10 <= entry.end ? (bytes[e + 8]! << 8) | bytes[e + 9]! : -1;
    let entryRate: number | null = null;
    let sampleSize: number | null = null;
    let childAt = -1;
    if ((version === 0 || version === 1) && e + 28 <= entry.end) {
      const ch = (bytes[e + 16]! << 8) | bytes[e + 17]!;
      track.channels = ch >= 1 && ch <= 8 ? ch : null;
      sampleSize = (bytes[e + 18]! << 8) | bytes[e + 19]!;
      entryRate = validRate(readU32(bytes, e + 24) >>> 16);
      childAt = e + 28 + (version === 1 ? 16 : 0);
    }

    let configRate: number | null = null;
    let esds: Mp4Box | null = null;
    if (childAt >= 0) {
      for (const child of mp4Boxes(bytes, childAt, entry.end, 64)) {
        // QuickTime nests the codec config inside a 'wave' atom.
        const inner =
          child.type === "wave" ? [...mp4Boxes(bytes, child.body, child.end, 64)] : [child];
        for (const c of inner) {
          if (c.type === "esds") esds = c;
          if (c.type === "dOps" && c.body + 2 <= c.end) {
            const ch = bytes[c.body + 1]!;
            if (ch >= 1 && ch <= 8) track.channels = ch;
          }
          if (c.type === "alac" && entry.type === "alac") {
            // ALACSpecificConfig (24 bytes), normally behind a full-box
            // version/flags: frameLength(4) compatibleVersion(1) bitDepth(1)
            // pb kb mb(3) numChannels(1) maxRun(2) maxFrameBytes(4)
            // avgBitRate(4) sampleRate(4).
            const o = c.end - c.body >= 28 ? c.body + 4 : c.body;
            if (o + 24 <= c.end) {
              const depth = bytes[o + 5]!;
              const ch = bytes[o + 9]!;
              if (depth >= 8 && depth <= 32) track.bitDepth = depth;
              if (ch >= 1 && ch <= 8) track.channels = ch;
              configRate = validRate(readU32(bytes, o + 20));
            }
          }
        }
      }
    }

    if (esds) {
      const parsed = parseEsds(bytes, esds);
      if (parsed) {
        track.claimedKbps = parsed.avgKbps;
        // MP3-in-MP4 rides in an mp4a entry with an MPEG-1/2 audio object type.
        if (entry.type === "mp4a" && (parsed.objectType === 0x69 || parsed.objectType === 0x6b)) {
          track.codec = "MP3";
        }
      } else {
        track.claimedKbps = esdsHeuristicKbps(bytes, esds.start + 4, esds.end);
      }
    }
    if (
      (track.codec === "ALAC" || track.codec === "FLAC" || track.codec === "PCM") &&
      track.bitDepth === null
    ) {
      track.bitDepth = sampleSize && sampleSize >= 8 && sampleSize <= 32 ? sampleSize : null;
    }

    // A wrong rate hint silently resamples the decode, so only answer when the
    // sources agree: the codec config wins; otherwise mdhd and the sample
    // entry must match (or one is absent and the other is a standard rate).
    if (configRate !== null) track.sampleRate = configRate;
    else if (timescale !== null && entryRate !== null) {
      track.sampleRate =
        timescale === entryRate
          ? timescale
          : // The 16.16 entry field can't hold rates above 65535: accept the
            // timescale only when the entry is exactly its truncated overflow.
            timescale > 65535 && AUDIO_RATES.has(timescale) && entryRate === timescale % 65536
            ? timescale
            : null;
    } else if (timescale !== null) {
      track.sampleRate = AUDIO_RATES.has(timescale) ? timescale : null;
    } else {
      track.sampleRate = entryRate !== null && AUDIO_RATES.has(entryRate) ? entryRate : null;
    }
    return track;
  }
  return null;
}

function parseMp4(bytes: Uint8Array): ContainerInfo | null {
  if (bytes.length < 12) return null;
  const ftyp = ascii(bytes, 4, 4);
  if (ftyp !== "ftyp" && ftyp !== "mdat" && ftyp !== "moov") {
    // Some M4A start with a wide atom then ftyp
    if (findAscii(bytes.subarray(0, 64), "ftyp") < 0) return null;
  }

  // FFmpeg writes moov AFTER mdat unless +faststart, so for real songs the
  // index sits megabytes in: walk the top-level boxes by size (a few dozen
  // reads, no byte scan) to find it wherever it is.
  let moov: Mp4Box | null = null;
  for (const box of mp4Boxes(bytes, 0, bytes.length)) {
    if (box.type === "moov") {
      moov = box;
      break;
    }
  }
  const track = moov ? parseMoov(bytes, moov) : null;
  if (moov) {
    const codec = track?.codec ?? "AAC";
    return {
      codec,
      sampleRate: track?.sampleRate ?? null,
      channels: track?.channels ?? null,
      bitDepth: track?.bitDepth ?? (codec === "AAC" ? 16 : null),
      claimedKbps: track?.claimedKbps ?? null,
      vbr: true,
    };
  }
  return parseMp4Loose(bytes.subarray(0, Math.min(bytes.length, 512 * 1024)));
}

/**
 * Fallback for MP4s whose box tree doesn't walk (truncated, mangled sizes):
 * bounded substring search in the head. Codec still comes from a sample entry
 * (the fourcc right after an stsd header) or the spec-required dOps box —
 * never from a bare fourcc that metadata text can contain.
 */
function parseMp4Loose(bytes: Uint8Array): ContainerInfo {
  let codec = "AAC";
  const stsd = findAscii(bytes, "stsd");
  if (stsd >= 0 && stsd + 20 <= bytes.length) {
    const mapped = MP4_CODECS[ascii(bytes, stsd + 16, 4)];
    if (mapped) codec = mapped;
  }
  // Opus-in-MP4 is identified by the dOps box the spec requires. Matching the
  // bare word "opus" instead flipped AAC files to "Opus" whenever the word
  // appeared in metadata (an album literally titled "Opus"), which then made
  // Safari decode errors blame the wrong codec.
  if (findAscii(bytes, "dOps") >= 0) codec = "Opus";

  let sampleRate: number | null = null;
  const mdhd = findAscii(bytes, "mdhd");
  if (mdhd >= 4) {
    const rate = mdhdRate(bytes, {
      type: "mdhd",
      start: mdhd - 4,
      body: mdhd + 4,
      end: bytes.length,
    });
    sampleRate = rate !== null && AUDIO_RATES.has(rate) ? rate : null;
  }

  const esds = findAscii(bytes, "esds");
  // DecoderConfigDescriptor order is …, maxBitrate, avgBitrate: the first
  // plausible u32 is usually the MAX, so take the last valid one — the
  // average — instead of overstating the header claim.
  const claimedKbps =
    esds >= 0 && esds + 40 < bytes.length ? esdsHeuristicKbps(bytes, esds, bytes.length) : null;

  return {
    codec,
    sampleRate,
    channels: null,
    bitDepth: codec === "AAC" ? 16 : null,
    claimedKbps,
    vbr: true,
  };
}

function parseOgg(bytes: Uint8Array): ContainerInfo | null {
  if (ascii(bytes, 0, 4) !== "OggS") return null;
  if (findAscii(bytes.subarray(0, 128), "OpusHead") >= 0) {
    const head = findAscii(bytes, "OpusHead");
    const channels =
      head >= 0 && head + 9 < bytes.length ? (validChannels(bytes[head + 9]) ?? 2) : 2;
    return {
      codec: "Opus",
      sampleRate: 48000,
      channels,
      bitDepth: null,
      claimedKbps: null,
      vbr: true,
    };
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
      channels = validChannels(bytes[i + 11]);
      sampleRate = validRate(readU32(bytes, i + 12, false));
      break;
    }
    return { codec: "Vorbis", sampleRate, channels, bitDepth: null, claimedKbps: null, vbr: true };
  }
  // Ogg FLAC: first packet is 0x7F "FLAC" + version + header count, then a
  // native "fLaC" stream marker and STREAMINFO.
  const oggFlac = findAscii(bytes.subarray(0, 256), "\x7fFLAC");
  if (oggFlac >= 0) {
    const info = parseFlac(bytes.subarray(oggFlac + 9));
    if (info) return info;
  }
  return {
    codec: "Ogg",
    sampleRate: null,
    channels: null,
    bitDepth: null,
    claimedKbps: null,
    vbr: true,
  };
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

const AIFC_PCM = new Set([
  "NONE",
  "none",
  "sowt",
  "twos",
  "raw ",
  "in24",
  "in32",
  "fl32",
  "fl64",
  "FL32",
  "FL64",
]);

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
      // COMM body: numChannels(2) numSampleFrames(4) sampleSize(2)
      // sampleRate(80-bit extended, 10); AIFC appends compressionType(4cc).
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const body = i + 8;
      const channels = view.getUint16(body, false);
      const bitDepth = view.getUint16(body + 6, false);
      const sampleRate = readExtended(view, body + 8);
      let codec = "AIFF";
      if (form === "AIFC" && size >= 22 && body + 22 <= bytes.length) {
        const comp = ascii(bytes, body + 18, 4);
        // Only uncompressed AIFC keeps the lossless "AIFF" label.
        if (!AIFC_PCM.has(comp)) codec = comp.trim().toUpperCase() || "AIFC";
      }
      return {
        codec,
        sampleRate: validRate(sampleRate),
        channels: channels >= 1 && channels <= 8 ? channels : null,
        bitDepth: bitDepth >= 1 && bitDepth <= 64 ? bitDepth : null,
        claimedKbps: null,
        vbr: false,
      };
    }
    // Chunks are word-aligned: odd sizes carry one pad byte.
    const next = i + 8 + size + (size % 2);
    if (!(next > i)) break;
    i = next;
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

const CAF_CODECS: Record<string, string> = {
  lpcm: "CAF",
  alac: "ALAC",
  "aac ": "AAC",
  opus: "Opus",
  ".mp3": "MP3",
};

function parseCaf(bytes: Uint8Array): ContainerInfo | null {
  if (ascii(bytes, 0, 4) !== "caff") return null;
  // File header: 'caff' + version(2) + flags(2). Chunk headers use a
  // big-endian u64 size: 4cc + 8 bytes.
  let i = 8;
  while (i + 12 <= bytes.length) {
    const id = ascii(bytes, i, 4);
    const size = readU32(bytes, i + 4) * 4294967296 + readU32(bytes, i + 8);
    if (id === "desc" && size >= 32 && i + 12 + 32 <= bytes.length) {
      // CAFAudioDescription: mSampleRate f64, mFormatID 4cc, mFormatFlags,
      // mBytesPerPacket, mFramesPerPacket, mChannelsPerFrame,
      // mBitsPerChannel (all big-endian).
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const o = i + 12;
      const formatId = ascii(bytes, o + 8, 4);
      const flags = view.getUint32(o + 12, false);
      const bytesPerPacket = view.getUint32(o + 16, false);
      const channels = view.getUint32(o + 24, false);
      let bitDepth: number | null = view.getUint32(o + 28, false);
      if (formatId === "alac") {
        // ALAC carries its depth in the format flags (1=16, 2=20, 3=24, 4=32).
        bitDepth = [0, 16, 20, 24, 32][flags] ?? null;
      }
      const codec = CAF_CODECS[formatId] ?? (formatId.trim().toUpperCase() || "Audio");
      const sampleRate = codec === "Opus" ? 48000 : validRate(view.getFloat64(o, false));
      return {
        codec,
        sampleRate,
        channels: channels >= 1 && channels <= 8 ? channels : null,
        bitDepth: bitDepth && bitDepth >= 1 && bitDepth <= 64 ? bitDepth : null,
        claimedKbps: null,
        vbr: formatId === "lpcm" ? false : bytesPerPacket === 0,
      };
    }
    const next = i + 12 + size;
    if (!(next > i)) break;
    i = next;
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

/** EBML variable-length integer at `i`: [value, width], or null if invalid. */
function ebmlVint(
  bytes: Uint8Array,
  i: number,
  keepMarker: boolean,
): [value: number, width: number] | null {
  const first = bytes[i];
  if (first === undefined || first === 0) return null;
  let width = 1;
  while (width <= 8 && !(first & (0x80 >> (width - 1)))) width++;
  if (width > 8 || i + width > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> width);
  let allOnes = value === 0xff >> width;
  for (let k = 1; k < width; k++) {
    const b = bytes[i + k]!;
    if (b !== 0xff) allOnes = false;
    value = value * 256 + b;
  }
  // An all-ones size means "unknown" (live WebM / MediaRecorder): -1.
  return [!keepMarker && allOnes ? -1 : value, width];
}

const EBML_SEGMENT = 0x18538067;
const EBML_TRACKS = 0x1654ae6b;
const EBML_CLUSTER = 0x1f43b675;
const EBML_TRACK_ENTRY = 0xae;
const EBML_TRACK_TYPE = 0x83;
const EBML_CODEC_ID = 0x86;
const EBML_AUDIO = 0xe1;
const EBML_SAMPLING_FREQ = 0xb5;
const EBML_OUTPUT_SAMPLING_FREQ = 0x78b5;
const EBML_CHANNELS = 0x9f;

const MKV_CODECS: Record<string, string> = {
  A_ALAC: "ALAC",
  A_TRUEHD: "TrueHD",
  A_AC3: "AC-3",
  A_EAC3: "E-AC-3",
};

type EbmlEl = { id: number; body: number; end: number; unknownSize: boolean };

function* ebmlElements(bytes: Uint8Array, from: number, to: number, max = 512): Generator<EbmlEl> {
  let i = from;
  for (let n = 0; n < max && i < to; n++) {
    const id = ebmlVint(bytes, i, true);
    if (!id || id[1] > 4) return;
    const size = ebmlVint(bytes, i + id[1], false);
    if (!size) return;
    const body = i + id[1] + size[1];
    const unknownSize = size[0] < 0;
    const end = unknownSize ? to : Math.min(to, body + size[0]);
    if (body > to) return;
    yield { id: id[0], body, end, unknownSize };
    if (unknownSize) return;
    i = end;
  }
}

function ebmlUint(bytes: Uint8Array, el: EbmlEl): number | null {
  const len = el.end - el.body;
  if (len < 1 || len > 6) return null;
  let v = 0;
  for (let k = el.body; k < el.end; k++) v = v * 256 + bytes[k]!;
  return v;
}

/**
 * WebM / Matroska (EBML magic 1A 45 DF A3). Must run before parseMp3: compressed
 * cluster data is full of 0xFFEx pairs. Walks Segment → Tracks → TrackEntry
 * (audio) for CodecID, SamplingFrequency and Channels; anything that doesn't
 * walk cleanly leaves the rate null rather than guessing.
 */
function parseEbml(bytes: Uint8Array): ContainerInfo | null {
  if (bytes.length < 4 || readU32(bytes, 0) !== 0x1a45dfa3) return null;
  // Tracks precede the clusters in every muxer we care about; 1 MB is plenty.
  const to = Math.min(bytes.length, 1024 * 1024);
  let codecId: string | null = null;
  let sampleRate: number | null = null;
  let channels: number | null = null;

  const top = [...ebmlElements(bytes, 0, to, 8)];
  const segment = top.find((el) => el.id === EBML_SEGMENT);
  if (segment) {
    outer: for (const el of ebmlElements(bytes, segment.body, segment.end, 256)) {
      if (el.id === EBML_CLUSTER) break;
      if (el.id !== EBML_TRACKS || el.unknownSize) continue;
      for (const entry of ebmlElements(bytes, el.body, el.end, 64)) {
        if (entry.id !== EBML_TRACK_ENTRY || entry.unknownSize) continue;
        let type: number | null = null;
        let id: string | null = null;
        let rate: number | null = null;
        let outRate: number | null = null;
        let ch: number | null = null;
        for (const f of ebmlElements(bytes, entry.body, entry.end, 64)) {
          if (f.id === EBML_TRACK_TYPE) type = ebmlUint(bytes, f);
          else if (f.id === EBML_CODEC_ID)
            id = ascii(bytes, f.body, Math.min(32, f.end - f.body)).replace(/\0+$/, "");
          else if (f.id === EBML_AUDIO && !f.unknownSize) {
            for (const a of ebmlElements(bytes, f.body, f.end, 32)) {
              const len = a.end - a.body;
              if (
                (a.id === EBML_SAMPLING_FREQ || a.id === EBML_OUTPUT_SAMPLING_FREQ) &&
                (len === 4 || len === 8)
              ) {
                const view = new DataView(bytes.buffer, bytes.byteOffset + a.body, len);
                const hz = len === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
                const v = Number.isInteger(hz) ? validRate(hz) : null;
                if (a.id === EBML_SAMPLING_FREQ) rate = v;
                else outRate = v;
              } else if (a.id === EBML_CHANNELS) {
                const v = ebmlUint(bytes, a);
                ch = v !== null && v >= 1 && v <= 8 ? v : null;
              }
            }
          }
        }
        // TrackType 2 = audio; also accept an untyped entry with an A_ codec.
        if (type === 2 || (type === null && id?.startsWith("A_"))) {
          codecId = id;
          // Opus always decodes at 48 kHz. Otherwise OutputSamplingFrequency
          // (the post-SBR rate) wins; HE-AAC without it stores the halved
          // core rate in SamplingFrequency, so leave AAC unknown rather than
          // resample away the SBR band.
          sampleRate =
            id === "A_OPUS"
              ? 48000
              : outRate !== null
                ? outRate
                : id?.startsWith("A_AAC")
                  ? null
                  : rate;
          channels = ch;
          break outer;
        }
      }
    }
  }

  let codec: string;
  if (codecId) {
    codec =
      codecId === "A_OPUS"
        ? "Opus"
        : codecId === "A_VORBIS"
          ? "Vorbis"
          : codecId === "A_FLAC"
            ? "FLAC"
            : codecId.startsWith("A_AAC")
              ? "AAC"
              : codecId === "A_MPEG/L3"
                ? "MP3"
                : codecId.startsWith("A_PCM")
                  ? "PCM"
                  : (MKV_CODECS[codecId] ?? (codecId.startsWith("A_DTS") ? "DTS" : "WebM"));
  } else {
    // Header didn't walk: fall back to codec-ID / codec-private strings in
    // the head, which only ever name the codec — never a rate.
    const head = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
    codec =
      findAscii(head, "A_OPUS") >= 0 || findAscii(head, "OpusHead") >= 0
        ? "Opus"
        : findAscii(head, "A_VORBIS") >= 0
          ? "Vorbis"
          : "WebM";
    sampleRate = null;
  }
  return { codec, sampleRate, channels, bitDepth: null, claimedKbps: null, vbr: true };
}

function fromExt(name: string, mime: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
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
  // Zero-copy views — never copy the whole file here (decodeAudioData gets
  // its own copy later). Chunked formats only need the head; MP4 walks its
  // top-level boxes across the full buffer (moov is often at the end), and
  // MP3 / FLAC need room past a large ID3 tag (embedded cover art); FLAC
  // reads only the STREAMINFO bytes where the tag ends.
  const full = new Uint8Array(buffer);
  const bytes = full.subarray(0, Math.min(full.length, 512 * 1024));
  const parsed =
    parseWav(bytes) ??
    parseFlac(full) ??
    parseOgg(bytes) ??
    parseMp4(full) ??
    parseAiff(bytes) ??
    parseCaf(bytes) ??
    parseEbml(full) ??
    parseMp3(full);

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
