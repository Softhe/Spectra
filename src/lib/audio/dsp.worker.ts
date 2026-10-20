// DSP worker: runs the pure analysis core (runDsp) off the main thread.
// Decode stays on main (AudioBuffer is not transferable); the compact mono
// slice buffer (regions + excerpt only, see buildDspInput) is
// structured-cloned in (not transferred, so the client keeps a usable copy
// for its main-thread fallback), and the result's large buffers are
// transferred back. Progress maps 1:1 onto the
// onProgress callback used by the legacy main-thread path.
import { runDsp, type DspOptions, type DspSpans } from "./analyze";

type AnalyzeMessage = {
  jobId: number;
  mono: Float32Array;
  sampleRate: number;
  clipFraction: number;
  spans?: DspSpans;
  options?: DspOptions;
};

type WorkerScope = {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  onmessage: ((e: MessageEvent<AnalyzeMessage>) => void) | null;
};

const scope = self as unknown as WorkerScope;

scope.onmessage = async (e: MessageEvent<AnalyzeMessage>) => {
  const { jobId, mono, sampleRate, clipFraction, spans, options } = e.data;
  const post = scope.postMessage.bind(scope);
  // Capability ping (no transferables): proves module workers execute here.
  if ((e.data as { ping?: boolean }).ping) {
    post({ jobId, type: "pong" });
    return;
  }
  try {
    const result = await runDsp(
      mono,
      sampleRate,
      clipFraction,
      (phase, amount) => {
        post({ jobId, type: "progress", phase, amount });
      },
      spans,
      undefined,
      options,
    );
    post({ jobId, type: "done", result }, [result.meanDb.buffer, result.spectrogram.frames.buffer]);
  } catch (err) {
    post({
      jobId,
      type: "error",
      message: err instanceof Error ? err.message : "Analysis failed in worker.",
    });
  }
};

export {};
