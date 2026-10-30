/** Shared between the per-slot and window-level drop paths (and the A/B
 * session bookkeeping); kept out of the component files for Fast Refresh. */

/** A slot's preview paused or ended (detail = slot id). */
export const STOP_EVENT = "spectra:stopped";

// Filename fallback covers OSes that hand drops a non-audio MIME type
// (Linux file managers and email clients serve application/octet-stream),
// not just an empty one — a .m4a must never be filtered out. Type and name
// are tested independently: a bad MIME must not hide a known extension.
// Both are anchored: substring matching let "audio-notes.txt" through and
// still missed "song.mp3" (no "mp3" in the old alternation).
const AUDIO_MIME_RE = /^(audio\/|video\/(mp4|webm|ogg|x-matroska)$|application\/ogg$)/i;
const AUDIO_EXT_RE =
  /\.(mp3|m4a|m4b|aac|mp4|wav|wave|flac|ogg|oga|opus|aif|aiff|aifc|caf|webm|mka)$/i;

export function isAudioFile(f: { type: string; name: string }): boolean {
  return AUDIO_MIME_RE.test(f.type) || AUDIO_EXT_RE.test(f.name);
}

/** Shared by the per-slot and window-level drop paths. */
export function audioFilesFrom(files: FileList | File[] | null | undefined): File[] {
  return [...(files ?? [])].filter(isAudioFile);
}

export const NOT_AUDIO_NOTICE =
  "Choose an audio file such as MP3, M4A, WAV, FLAC, OGG, AIFF or WebM.";
