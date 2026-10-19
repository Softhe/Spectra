/** Shared between the per-slot and window-level drop paths (and the A/B
 * session bookkeeping); kept out of the component files for Fast Refresh. */

/** A slot's preview paused or ended (detail = slot id). */
export const STOP_EVENT = "spectra:stopped";

// Filename fallback covers OSes that hand drops a non-audio MIME type
// (Linux file managers and email clients serve application/octet-stream),
// not just an empty one — a .m4a must never be filtered out. Type and name
// are tested independently: a bad MIME must not hide a known extension.
const AUDIO_FILE_RE = /audio|mpeg|mp4|m4a|aac|ogg|opus|wav|flac|aiff|aif|caf|webm/i;

/** Shared by the per-slot and window-level drop paths. */
export function audioFilesFrom(files: FileList | File[] | null | undefined): File[] {
  return [...(files ?? [])].filter((f) => AUDIO_FILE_RE.test(f.type) || AUDIO_FILE_RE.test(f.name));
}

export const NOT_AUDIO_NOTICE =
  "That doesn't look like an audio file — try MP3, M4A, WAV, FLAC, OGG, AIFF or WebM.";
