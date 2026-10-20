// Run: node --experimental-strip-types --no-warnings \
//   --loader ./scripts/corpus/ts-resolve.mjs --test src/lib/audio/sniff.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sniffContainer } from "./sniff.ts";

// ── Byte builders ───────────────────────────────────────────────────────────

const bytesOf = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const u16 = (v: number) => [(v >>> 8) & 255, v & 255];
const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

/** A structurally valid MP4 box: u32 size + fourcc + payload. */
const box = (type: string, ...payload: (number[] | Uint8Array)[]): number[] => {
  const body = payload.flatMap((p) => [...p]);
  return [...u32(8 + body.length), ...bytesOf(type), ...body];
};
const fullBox = (type: string, version: number, ...payload: number[][]) =>
  box(type, [version, 0, 0, 0], ...payload);

const mdhd = (timescale: number) =>
  fullBox("mdhd", 0, u32(0), u32(0), u32(timescale), u32(timescale * 200), u16(0x55c4), u16(0));
const hdlr = (handler: string) =>
  fullBox("hdlr", 0, u32(0), bytesOf(handler), u32(0), u32(0), u32(0), [0]);

/** AudioSampleEntry v0 with channel count, sample size and 16.16 rate. */
const sampleEntry = (
  fourcc: string,
  ch: number,
  bits: number,
  rate: number,
  ...children: number[][]
) =>
  box(
    fourcc,
    [0, 0, 0, 0, 0, 0],
    u16(1),
    u16(0),
    u16(0),
    u32(0),
    u16(ch),
    u16(bits),
    u16(0),
    u16(0),
    u32(rate * 65536),
    ...children,
  );

const trak = (timescale: number, entry: number[]) =>
  box(
    "trak",
    box(
      "mdia",
      mdhd(timescale),
      hdlr("soun"),
      box("minf", box("stbl", fullBox("stsd", 0, u32(1), entry))),
    ),
  );

/** ALACSpecificConfig behind its full-box header. */
const alacCookie = (bitDepth: number, ch: number, rate: number) =>
  fullBox("alac", 0, u32(4096), [0, bitDepth, 40, 10, 14, ch], u16(255), u32(0), u32(0), u32(rate));

/** esds: ES_Descriptor → DecoderConfigDescriptor(AAC, max, avg). */
const esds = (maxBps: number, avgBps: number) =>
  fullBox(
    "esds",
    0,
    [0x03, 25, 0, 1, 0],
    [0x04, 17, 0x40, 0x15, 0, 0, 0],
    u32(maxBps),
    u32(avgBps),
    [0x05, 2, 0x12, 0x10],
    [0x06, 1, 2],
  );

const ftyp = () =>
  box("ftyp", bytesOf("M4A "), u32(0), bytesOf("M4A "), bytesOf("mp42"), bytesOf("isom"));

const toBuffer = (arr: number[] | Uint8Array) => new Uint8Array(arr).buffer;

/** Deterministic PRNG (mulberry32) so random-payload trials are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const noise = (n: number, rand: () => number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(rand() * 256);
  return b;
};

// ── EBML builders ───────────────────────────────────────────────────────────

/** EBML element with an 8-byte size vint (simple and always valid). */
const ebml = (id: number[], ...payload: (number[] | Uint8Array)[]): number[] => {
  const body = payload.flatMap((p) => [...p]);
  const len = body.length;
  const size = [0x01, 0, 0, (len / 2 ** 32) & 255, ...u32(len)];
  return [...id, ...size, ...body];
};
const f64 = (v: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, false);
  return [...b];
};

function webm(codecId: string, rate: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = ebml([0x1a, 0x45, 0xdf, 0xa3], ebml([0x42, 0x82], bytesOf("webm")));
  const tracks = ebml(
    [0x16, 0x54, 0xae, 0x6b],
    ebml(
      [0xae],
      ebml([0xd7], [1]),
      ebml([0x83], [2]),
      ebml([0x86], bytesOf(codecId)),
      ebml([0xe1], ebml([0xb5], f64(rate)), ebml([0x9f], [2])),
    ),
  );
  const cluster = ebml([0x1f, 0x43, 0xb6, 0x75], ebml([0xa3], payload));
  // Segment with "unknown" size, as MediaRecorder writes it.
  const segment = [
    0x18,
    0x53,
    0x80,
    0x67,
    0x01,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    ...tracks,
    ...cluster,
  ];
  return new Uint8Array([...header, ...segment]);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("sniffContainer: MP4 box walk", () => {
  it("finds a moov written after a >512 KB mdat (FFmpeg default) and reads ALAC from stsd", () => {
    const mdat = new Uint8Array(900 * 1024);
    mdat.set([...u32(mdat.length), ...bytesOf("mdat")], 0);
    const moov = box(
      "moov",
      fullBox("mvhd", 0, new Array(96).fill(0)),
      trak(44100, sampleEntry("alac", 2, 16, 44100, alacCookie(16, 2, 44100))),
    );
    const file = new Uint8Array([...ftyp(), ...mdat, ...moov]);
    const r = sniffContainer(file.buffer, "song.m4a", "audio/mp4");
    assert.equal(r.codec, "ALAC");
    assert.equal(r.sampleRate, 44100);
    assert.equal(r.channels, 2);
    assert.equal(r.bitDepth, 16, "bit depth comes from the ALAC config, not a guess");
  });

  it("handles a 64-bit largesize mdat before the moov", () => {
    const payload = new Uint8Array(600 * 1024);
    const mdat = [...u32(1), ...bytesOf("mdat"), ...u32(0), ...u32(16 + payload.length)];
    const moov = box("moov", trak(48000, sampleEntry("mp4a", 2, 16, 48000, esds(320000, 256000))));
    const file = new Uint8Array([...ftyp(), ...mdat, ...payload, ...moov]);
    const r = sniffContainer(file.buffer, "song.m4a", "audio/mp4");
    assert.deepEqual([r.codec, r.sampleRate, r.claimedKbps], ["AAC", 48000, 256]);
  });

  it("calls an AAC track AAC even when metadata says 'Palace'", () => {
    const ilst = box(
      "ilst",
      box("\xa9nam", box("data", u32(1), u32(0), bytesOf("Palace of Balaclava"))),
    );
    const udta = box("udta", fullBox("meta", 0, hdlr("mdir"), ilst));
    const moov = box(
      "moov",
      trak(44100, sampleEntry("mp4a", 2, 16, 44100, esds(192000, 128000))),
      udta,
    );
    const file = [...ftyp(), ...moov, ...box("mdat", new Array(2048).fill(0))];
    const r = sniffContainer(toBuffer(file), "palace.m4a", "audio/mp4");
    assert.equal(r.codec, "AAC");
    assert.equal(r.sampleRate, 44100);
    assert.equal(r.claimedKbps, 128, "avgBitrate, not maxBitrate");
    assert.equal(r.channels, 2);
  });

  it("refuses a rate when mdhd and the sample entry disagree", () => {
    const moov = box("moov", trak(90000, sampleEntry("mp4a", 2, 16, 48000, esds(0, 0))));
    const r = sniffContainer(toBuffer([...ftyp(), ...moov]), "odd.m4a", "audio/mp4");
    assert.equal(r.codec, "AAC");
    assert.equal(r.sampleRate, null);
  });

  it("reads Opus from the sample entry fourcc", () => {
    const dOps = box("dOps", [0, 2], u16(312), u32(48000), u16(0), [0]);
    const moov = box("moov", trak(48000, sampleEntry("Opus", 2, 16, 48000, dOps)));
    const r = sniffContainer(toBuffer([...ftyp(), ...moov]), "song.m4a", "audio/mp4");
    assert.deepEqual([r.codec, r.sampleRate, r.channels], ["Opus", 48000, 2]);
  });
});

describe("sniffContainer: WebM / Matroska", () => {
  it("never calls random-payload WebM 'MP3' nor invents a rate", () => {
    const rand = rng(0x5eed);
    for (let t = 0; t < 300; t++) {
      const payload = noise(32 * 1024 + Math.floor(rand() * 32 * 1024), rand);
      // Header-less EBML: magic followed by noise — nothing parses.
      const bare = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...payload]);
      const r = sniffContainer(bare.buffer, "clip.webm", "audio/webm");
      assert.notEqual(r.codec, "MP3", `trial ${t}`);
      assert.equal(r.sampleRate, null, `trial ${t}`);
    }
  });

  it("reads codec and SamplingFrequency from a real Tracks element", () => {
    const rand = rng(42);
    for (let t = 0; t < 50; t++) {
      const r = sniffContainer(webm("A_OPUS", 48000, noise(48 * 1024, rand)).buffer, "rec", "");
      assert.deepEqual([r.codec, r.sampleRate, r.channels], ["Opus", 48000, 2], `trial ${t}`);
    }
    const v = sniffContainer(
      webm("A_VORBIS", 44100, noise(4096, rand)).buffer,
      "a.webm",
      "audio/webm",
    );
    assert.deepEqual([v.codec, v.sampleRate], ["Vorbis", 44100]);
  });
});

describe("sniffContainer: MP3 sync validation", () => {
  it("leaves the rate null for a random buffer with no magic", () => {
    const rand = rng(7);
    for (let t = 0; t < 200; t++) {
      const b = noise(64 * 1024, rand);
      if (b[0] === 0xff) b[0] = 0; // keep offset 0 from being a frame anchor by luck
      const r = sniffContainer(b.buffer, "mystery.bin", "application/octet-stream");
      assert.equal(r.sampleRate, null, `trial ${t}`);
      assert.notEqual(r.codec, "MP3", `trial ${t}`);
    }
  });

  it("parses a valid 2-frame CBR MP3 with rate and kbps", () => {
    // MPEG-1 Layer III, 128 kbps, 44.1 kHz, no padding → 417-byte frames.
    const b = new Uint8Array(417 * 2 + 16);
    b.set([0xff, 0xfb, 0x90, 0x64], 0);
    b.set([0xff, 0xfb, 0x90, 0x64], 417);
    const r = sniffContainer(b.buffer, "track", "");
    assert.deepEqual([r.codec, r.sampleRate, r.claimedKbps], ["MP3", 44100, 128]);
  });

  it("skips a lone false sync and locks onto the real frame chain", () => {
    const b = new Uint8Array(4096);
    b.set([0xff, 0xfb, 0x90, 0x64], 3); // false sync: nothing 417 bytes later
    b.set([0xff, 0xf3, 0x80, 0xc4], 700); // MPEG-2 64 kbps 22.05 kHz → 208-byte frames
    b.set([0xff, 0xf3, 0x80, 0xc4], 908);
    const r = sniffContainer(b.buffer, "x.mp3", "audio/mpeg");
    assert.deepEqual([r.codec, r.sampleRate, r.claimedKbps], ["MP3", 22050, 64]);
  });

  it("finds frames after a large ID3 tag (cover art past 512 KB)", () => {
    const tag = 700 * 1024;
    const b = new Uint8Array(10 + tag + 417 * 2 + 8);
    b.set(
      [
        0x49,
        0x44,
        0x33,
        0x03,
        0,
        0,
        (tag >> 21) & 0x7f,
        (tag >> 14) & 0x7f,
        (tag >> 7) & 0x7f,
        tag & 0x7f,
      ],
      0,
    );
    b.set([0xff, 0xfb, 0x90, 0x64], 10 + tag);
    b.set([0xff, 0xfb, 0x90, 0x64], 10 + tag + 417);
    const r = sniffContainer(b.buffer, "art.mp3", "audio/mpeg");
    assert.deepEqual([r.codec, r.sampleRate, r.claimedKbps], ["MP3", 44100, 128]);
  });
});

// ── Review fixes: Matroska output rate, MP4 tie-break, chunk walks ─────────

const f32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v, false);
  return [...b];
};

/** Matroska with an explicit Audio element body. */
function mka(codecId: string, audio: number[][]): Uint8Array<ArrayBuffer> {
  const header = ebml([0x1a, 0x45, 0xdf, 0xa3], ebml([0x42, 0x82], bytesOf("matroska")));
  const tracks = ebml(
    [0x16, 0x54, 0xae, 0x6b],
    ebml(
      [0xae],
      ebml([0xd7], [1]),
      ebml([0x83], [2]),
      ebml([0x86], bytesOf(codecId)),
      ebml([0xe1], ...audio),
    ),
  );
  return new Uint8Array([...header, ...ebml([0x18, 0x53, 0x80, 0x67], tracks)]);
}

const le32 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const le16 = (v: number) => [v & 255, (v >>> 8) & 255];

/** 80-bit IEEE extended (big-endian) for an integer rate. */
const ext80 = (r: number) => {
  const exp = Math.floor(Math.log2(r));
  return [...u16(16383 + exp), ...u32(r * 2 ** (31 - exp)), ...u32(0)];
};
const aiffChunk = (id: string, body: number[]) => [
  ...bytesOf(id),
  ...u32(body.length),
  ...body,
  ...(body.length % 2 ? [0] : []),
];
const aiff = (form: "AIFF" | "AIFC", comm: number[]) => {
  const chunks = [
    ...(form === "AIFC" ? aiffChunk("FVER", u32(0xa2805140)) : []),
    ...aiffChunk("COMM", comm),
    ...aiffChunk("SSND", [...u32(0), ...u32(0), ...new Array(64).fill(0)]),
  ];
  return [...bytesOf("FORM"), ...u32(4 + chunks.length), ...bytesOf(form), ...chunks];
};

const cafChunk = (id: string, body: number[]) => [
  ...bytesOf(id),
  ...u32(0),
  ...u32(body.length),
  ...body,
];
const caf = (
  rate: number,
  fmt: string,
  flags: number,
  bpp: number,
  fpp: number,
  ch: number,
  bits: number,
) => [
  ...bytesOf("caff"),
  ...u16(1),
  ...u16(0),
  ...cafChunk("desc", [
    ...f64(rate),
    ...bytesOf(fmt),
    ...u32(flags),
    ...u32(bpp),
    ...u32(fpp),
    ...u32(ch),
    ...u32(bits),
  ]),
  ...cafChunk("info", [...u32(1), ...bytesOf("title\0x\0")]),
];

describe("sniffContainer: Matroska output rate", () => {
  it("prefers OutputSamplingFrequency for HE-AAC", () => {
    const r = sniffContainer(
      mka("A_AAC", [ebml([0xb5], f64(24000)), ebml([0x78, 0xb5], f64(48000)), ebml([0x9f], [2])])
        .buffer,
      "he.mka",
      "",
    );
    assert.deepEqual([r.codec, r.sampleRate, r.channels], ["AAC", 48000, 2]);
  });

  it("leaves AAC null without OutputSamplingFrequency (may be the halved SBR core rate)", () => {
    const r = sniffContainer(mka("A_AAC", [ebml([0xb5], f32(24000))]).buffer, "he.mka", "");
    assert.deepEqual([r.codec, r.sampleRate], ["AAC", null]);
  });

  it("forces 48000 for Opus whatever SamplingFrequency says", () => {
    const r = sniffContainer(mka("A_OPUS", [ebml([0xb5], f64(24000))]).buffer, "o.mka", "");
    assert.deepEqual([r.codec, r.sampleRate], ["Opus", 48000]);
  });

  it("maps ALAC / TrueHD codec IDs; only ALAC is lossless-labelled", () => {
    const a = sniffContainer(mka("A_ALAC", [ebml([0xb5], f64(44100))]).buffer, "a.mka", "");
    assert.deepEqual([a.codec, a.sampleRate], ["ALAC", 44100]);
    const t = sniffContainer(mka("A_TRUEHD", [ebml([0xb5], f64(48000))]).buffer, "t.mka", "");
    assert.equal(t.codec, "TrueHD");
  });
});

describe("sniffContainer: MP4 high-rate tie-break", () => {
  it("refuses mdhd 96000 when the sample entry says 48000", () => {
    const moov = box("moov", trak(96000, sampleEntry("mp4a", 2, 16, 48000, esds(0, 0))));
    const r = sniffContainer(toBuffer([...ftyp(), ...moov]), "x.m4a", "audio/mp4");
    assert.equal(r.sampleRate, null);
  });

  it("accepts mdhd 96000 when the entry holds its 16.16 overflow (30464)", () => {
    const moov = box("moov", trak(96000, sampleEntry("alac", 2, 24, 30464)));
    const r = sniffContainer(toBuffer([...ftyp(), ...moov]), "x.m4a", "audio/mp4");
    assert.deepEqual([r.codec, r.sampleRate], ["ALAC", 96000]);
  });
});

describe("sniffContainer: chunked formats", () => {
  it("returns promptly on a WAV chunk size of 0xFFFFFFF8 (no infinite loop)", () => {
    const wav = [
      ...bytesOf("RIFF"),
      ...le32(100),
      ...bytesOf("WAVE"),
      ...bytesOf("junk"),
      ...le32(0xfffffff8),
      ...new Array(64).fill(0),
    ];
    const t0 = performance.now();
    const r = sniffContainer(toBuffer(wav), "bad.wav", "audio/wav");
    assert.ok(performance.now() - t0 < 1000);
    assert.deepEqual([r.codec, r.sampleRate], ["WAV", null]);
  });

  it("still parses a normal WAV fmt chunk", () => {
    const fmt = [...le16(1), ...le16(2), ...le32(44100), ...le32(176400), ...le16(4), ...le16(16)];
    const wav = [
      ...bytesOf("RIFF"),
      ...le32(36),
      ...bytesOf("WAVE"),
      ...bytesOf("fmt "),
      ...le32(16),
      ...fmt,
      ...bytesOf("data"),
      ...le32(0),
    ];
    const r = sniffContainer(toBuffer(wav), "a.wav", "audio/wav");
    assert.deepEqual([r.codec, r.sampleRate, r.channels, r.bitDepth], ["PCM", 44100, 2, 16]);
  });

  it("parses AIFF COMM: 44.1 kHz / 16-bit / stereo", () => {
    const comm = [...u16(2), ...u32(1000), ...u16(16), ...ext80(44100)];
    const r = sniffContainer(toBuffer(aiff("AIFF", comm)), "a.aiff", "audio/aiff");
    assert.deepEqual([r.codec, r.sampleRate, r.channels, r.bitDepth], ["AIFF", 44100, 2, 16]);
  });

  it("parses AIFC COMM (sowt stays AIFF, ima4 is not lossless-labelled)", () => {
    const comm = (c: string) => [
      ...u16(2),
      ...u32(1000),
      ...u16(16),
      ...ext80(48000),
      ...bytesOf(c),
      4,
      ...bytesOf("name"),
    ];
    const s = sniffContainer(toBuffer(aiff("AIFC", comm("sowt"))), "a.aifc", "");
    assert.deepEqual([s.codec, s.sampleRate, s.channels, s.bitDepth], ["AIFF", 48000, 2, 16]);
    const c = sniffContainer(toBuffer(aiff("AIFC", comm("ima4"))), "a.aifc", "");
    assert.equal(c.codec, "IMA4");
    assert.doesNotMatch(c.codec, /FLAC|PCM|ALAC|WAV|AIFF|CAF/i);
  });

  it("returns promptly on an AIFF chunk with a huge size", () => {
    const file = [
      ...bytesOf("FORM"),
      ...u32(100),
      ...bytesOf("AIFF"),
      ...bytesOf("JUNK"),
      ...u32(0xffffffff),
      ...new Array(32).fill(0),
    ];
    const r = sniffContainer(toBuffer(file), "a.aiff", "");
    assert.deepEqual([r.codec, r.sampleRate], ["AIFF", null]);
  });

  it("reads CAF desc: lpcm 48 kHz 24-bit stereo", () => {
    const r = sniffContainer(toBuffer(caf(48000, "lpcm", 0xc, 6, 1, 2, 24)), "a.caf", "");
    assert.deepEqual([r.codec, r.sampleRate, r.channels, r.bitDepth], ["CAF", 48000, 2, 24]);
  });

  it("labels CAF aac as AAC (not a lossless wrapper)", () => {
    const r = sniffContainer(toBuffer(caf(44100, "aac ", 0, 0, 1024, 2, 0)), "a.caf", "");
    assert.deepEqual([r.codec, r.sampleRate, r.channels, r.bitDepth], ["AAC", 44100, 2, null]);
    assert.equal(r.vbr, true);
  });
});

describe("sniffContainer: ID3-tagged FLAC", () => {
  it("keeps the FLAC label past a >512 KB ID3 tag", () => {
    const tag = 700 * 1024;
    const b = new Uint8Array(10 + tag + 64);
    b.set([
      0x49,
      0x44,
      0x33,
      3,
      0,
      0,
      (tag >> 21) & 0x7f,
      (tag >> 14) & 0x7f,
      (tag >> 7) & 0x7f,
      tag & 0x7f,
    ]);
    // fLaC + STREAMINFO header; 44100 Hz, 2 ch, 16-bit at +18..+21.
    b.set(
      [
        ...bytesOf("fLaC"),
        0x80,
        0,
        0,
        34,
        0x10,
        0,
        0x10,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0x0a,
        0xc4,
        0x42,
        0xf0,
      ],
      10 + tag,
    );
    const r = sniffContainer(b.buffer, "t.flac", "audio/flac");
    assert.deepEqual([r.codec, r.sampleRate, r.channels, r.bitDepth], ["FLAC", 44100, 2, 16]);
  });
});

describe("sniffContainer: WAV payloads and RF64", () => {
  const wavWith = (magic: string, format: number, extra: number[] = []) => {
    const fmt = [
      ...le16(format),
      ...le16(2),
      ...le32(44100),
      ...le32(16000),
      ...le16(4),
      ...le16(format === 0x55 ? 0 : 16),
      ...extra,
    ];
    return [
      ...bytesOf(magic),
      ...le32(36),
      ...bytesOf("WAVE"),
      ...bytesOf("fmt "),
      ...le32(fmt.length),
      ...fmt,
      ...bytesOf("data"),
      ...le32(0),
    ];
  };

  it("labels an MP3-in-RIFF payload as MP3, not a lossless WAV", () => {
    const r = sniffContainer(toBuffer(wavWith("RIFF", 0x55)), "a.wav", "audio/wav");
    assert.equal(r.codec, "MP3");
    assert.equal(r.bitDepth, null);
    assert.doesNotMatch(r.codec, /FLAC|PCM|ALAC|WAV|AIFF|CAF/i);
  });

  it("reads the SubFormat of WAVE_FORMAT_EXTENSIBLE", () => {
    // cbSize 22, valid bits, channel mask, then the SubFormat GUID (PCM = 1).
    const ext = [...le16(22), ...le16(24), ...le32(3), ...le16(1), ...new Array(14).fill(0)];
    const r = sniffContainer(toBuffer(wavWith("RIFF", 0xfffe, ext)), "a.wav", "audio/wav");
    assert.equal(r.codec, "PCM");
  });

  it("parses RF64 headers like RIFF", () => {
    const r = sniffContainer(toBuffer(wavWith("RF64", 1)), "a.wav", "audio/wav");
    assert.deepEqual([r.codec, r.sampleRate, r.channels], ["PCM", 44100, 2]);
  });
});

describe("sniffContainer: stacked ID3 tags", () => {
  it("skips two consecutive ID3v2 tags before a FLAC stream", () => {
    const id3 = (n: number) => [
      0x49,
      0x44,
      0x33,
      4,
      0,
      0,
      0,
      0,
      (n >> 7) & 0x7f,
      n & 0x7f,
      ...new Array(n).fill(0),
    ];
    const streaminfo = [
      ...bytesOf("fLaC"),
      0x80,
      0,
      0,
      34,
      0x10,
      0,
      0x10,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0x0a,
      0xc4,
      0x42,
      0xf0,
      ...new Array(32).fill(0),
    ];
    const r = sniffContainer(toBuffer([...id3(300), ...id3(500), ...streaminfo]), "t.flac", "");
    assert.deepEqual([r.codec, r.sampleRate], ["FLAC", 44100]);
  });
});

describe("sniffContainer: Ogg", () => {
  it("recognises Ogg FLAC as FLAC with its STREAMINFO rate", () => {
    const page = [...bytesOf("OggS"), 0, 2, ...new Array(20).fill(0), 1, 51];
    const pkt = [
      0x7f,
      ...bytesOf("FLAC"),
      1,
      0,
      0,
      1,
      ...bytesOf("fLaC"),
      0x80,
      0,
      0,
      34,
      0x10,
      0,
      0x10,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0x0a,
      0xc4,
      0x42,
      0xf0,
      ...new Array(20).fill(0),
    ];
    const r = sniffContainer(toBuffer([...page, ...pkt]), "a.oga", "audio/ogg");
    assert.deepEqual([r.codec, r.sampleRate], ["FLAC", 44100]);
  });

  it("drops an implausible Vorbis rate and channel count", () => {
    const page = [...bytesOf("OggS"), 0, 2, ...new Array(20).fill(0), 1, 30];
    const ident = [0x01, ...bytesOf("vorbis"), 0, 0, 0, 0, 0, ...le32(5), ...new Array(16).fill(0)];
    const r = sniffContainer(toBuffer([...page, ...ident]), "a.ogg", "audio/ogg");
    assert.deepEqual([r.codec, r.sampleRate, r.channels], ["Vorbis", null, null]);
  });
});
