// Shared carrier for audio slices: the DSP always wants "channel data for a
// sample range". AudioBuffer can answer synchronously from one allocation; a
// chunked WAV reader answers asynchronously by decoding only the requested
// frames — the interface exists so both feed the same analysis passes.

export type SliceSource = {
  sampleRate: number;
  numberOfChannels: number;
  /** Samples per channel. */
  length: number;
  /**
   * Channels 0..N-1 for samples [start, end). Implementations may clamp;
   * ranges are always well inside the file, and one call never allocates
   * more than a few seconds of audio.
   */
  sliceChannels(start: number, end: number): Promise<Float32Array[]>;
};

/** AudioBuffer adapter — slices are subarrays of the live channel storage. */
export function bufferSource(buffer: AudioBuffer): SliceSource {
  return {
    sampleRate: buffer.sampleRate,
    numberOfChannels: buffer.numberOfChannels,
    length: buffer.length,
    async sliceChannels(start: number, end: number): Promise<Float32Array[]> {
      const channels: Float32Array[] = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const data = buffer.getChannelData(c);
        channels.push(data.subarray(Math.max(0, start), Math.min(data.length, end)));
      }
      return channels;
    },
  };
}
