// DSP worker: runs the pure analysis core (runDsp) off the main thread.
// Decode stays on main (AudioBuffer is not transferable); the mono mix
// crosses threads once via transferables. Progress maps 1:1 onto the
// onProgress callback used by the legacy main-thread path.
import { runDsp, type DspSpans } from "./analyze";

type AnalyzeMessage = {
  jobId: number;
  mono: Float32Array;
  sampleRate: number;
  clipFraction: number;
  spans?: DspSpans;
};

type WorkerScope = {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  onmessage: ((e: MessageEvent<AnalyzeMessage>) => void) | null;
};

const scope = self as unknown as WorkerScope;

scope.onmessage = async (e: MessageEvent<AnalyzeMessage>) => {
  const { jobId, mono, sampleRate, clipFraction, spans } = e.data;
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
    );
    post({ jobId, type: "done", result }, [
      result.meanDb.buffer,
      result.spectrogram.frames.buffer,
    ]);
  } catch (err) {
    post({
      jobId,
      type: "error",
      message: err instanceof Error ? err.message : "Analysis failed in worker.",
    });
  }
};

export {};
