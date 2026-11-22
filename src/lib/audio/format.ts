export function formatHz(hz: number): string {
  if (!Number.isFinite(hz)) return "Not available";
  if (hz >= 1000) return `${(hz / 1000).toFixed(1)} kHz`;
  return `${Math.round(hz)} Hz`;
}

export function formatKbps(kbps: number | null | undefined): string {
  if (kbps == null || !Number.isFinite(kbps) || kbps <= 0) return "Not available";
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(2)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "Not available";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDb(db: number, digits = 1): string {
  if (!Number.isFinite(db)) return "Not available";
  const v = Math.max(-96, db);
  return `${v.toFixed(digits)} dB`;
}

export function formatSampleRate(hz: number): string {
  if (!Number.isFinite(hz)) return "Not available";
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz`;
  return `${Math.round(hz)} Hz`;
}

export function channelLabel(n: number): string {
  if (n <= 1) return "Mono";
  if (n === 2) return "Stereo";
  return `${n} ch`;
}

/** Codecs that store decoded samples exactly (no perceptual coding). */
export function isLosslessCodec(codec: string): boolean {
  return /FLAC|PCM|ALAC|WAV|AIFF|CAF/i.test(codec);
}

/**
 * Frequency-axis ticks in kHz for a 0..maxHz axis: every 5 kHz up to the CD
 * band, every 10 kHz on hi-res ranges so labels never crowd.
 */
export function frequencyTicksKHz(maxHz: number): number[] {
  const step = maxHz > 26000 ? 10 : 5;
  const ticks: number[] = [];
  for (let k = step; k * 1000 <= maxHz + 50; k += step) ticks.push(k);
  return ticks;
}
