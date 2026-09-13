/** Sage-to-ice heat map. Values expected in dB. */
const STOPS: { t: number; r: number; g: number; b: number }[] = [
  { t: 0.0, r: 7, g: 8, b: 10 },
  { t: 0.12, r: 14, g: 28, b: 32 },
  { t: 0.32, r: 22, g: 72, b: 74 },
  { t: 0.55, r: 56, g: 148, b: 132 },
  { t: 0.78, r: 168, g: 214, b: 188 },
  { t: 1.0, r: 242, g: 239, b: 230 },
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export const DB_MIN = -88;
export const DB_MAX = -18;

export function dbToColor(db: number, out: Uint8ClampedArray, i: number): void {
  const t = Math.max(0, Math.min(1, (db - DB_MIN) / (DB_MAX - DB_MIN)));
  let a = STOPS[0]!;
  let b = STOPS[STOPS.length - 1]!;
  for (let s = 0; s < STOPS.length - 1; s++) {
    if (t >= STOPS[s]!.t && t <= STOPS[s + 1]!.t) {
      a = STOPS[s]!;
      b = STOPS[s + 1]!;
      break;
    }
  }
  const span = b.t - a.t || 1;
  const u = (t - a.t) / span;
  out[i] = lerp(a.r, b.r, u);
  out[i + 1] = lerp(a.g, b.g, u);
  out[i + 2] = lerp(a.b, b.b, u);
  out[i + 3] = 255;
}

export function buildLut(): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const db = DB_MIN + (i / 255) * (DB_MAX - DB_MIN);
    dbToColor(db, lut, i * 4);
  }
  return lut;
}
