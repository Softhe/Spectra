// Client for the DSP worker. Same signature/semantics as runDsp; falls back
// to the main-thread legacy path when workers are unavailable, when
// ?worker=0 is set (debug hatch), or when the worker fails to boot.
import {
  runDsp,
  type DspResult,
  type DspSpans,
} from "./analyze";

let jobSeq = 0;
let probe: Promise<boolean> | null = null;

function workerSupported(): boolean {
  if (typeof window === "undefined" || typeof Worker === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get("worker") === "0") return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * One-time capability probe: old engines (Safari <15) accept the Worker
 * constructor but fail module scripts. Ping first with no transferable, so
 * a negative result still leaves mono intact for the legacy path.
 */
function probeWorker(): Promise<boolean> {
  if (!workerSupported()) return Promise.resolve(false);
  if (!probe) {
    probe = new Promise((resolve) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL("./dsp.worker.ts", import.meta.url), {
          type: "module",
        });
      } catch {
        resolve(false);
        return;
      }
      const timer = window.setTimeout(() => {
        worker.terminate();
        resolve(false);
      }, 2500);
      worker.onmessage = (e: MessageEvent) => {
        if (e.data?.type === "pong") {
          window.clearTimeout(timer);
          worker.terminate();
          resolve(true);
        }
      };
      worker.onerror = () => {
        window.clearTimeout(timer);
        worker.terminate();
        resolve(false);
      };
      worker.postMessage({ jobId: 0, ping: true });
    });
  }
  return probe;
}

export async function runDspParallel(
  mono: Float32Array,
  sampleRate: number,
  clipFraction: number,
  onProgress?: (phase: string, amount: number) => void,
  spans?: DspSpans,
): Promise<DspResult> {
  if (!(await probeWorker())) {
    return runDsp(mono, sampleRate, clipFraction, onProgress, spans);
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL("./dsp.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    return runDsp(mono, sampleRate, clipFraction, onProgress, spans);
  }

  const jobId = ++jobSeq;
  try {
    return await new Promise<DspResult>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => {
        const d = e.data as {
          jobId?: number;
          type?: string;
          phase?: string;
          amount?: number;
          result?: DspResult;
          message?: string;
        };
        if (!d || d.jobId !== jobId) return;
        if (d.type === "progress") {
          onProgress?.(d.phase ?? "", d.amount ?? 0);
        } else if (d.type === "done" && d.result) {
          resolve(d.result);
        } else if (d.type === "error") {
          reject(new Error(d.message || "Analysis failed in worker."));
        }
      };
      worker.onerror = () => {
        reject(new Error("Analysis worker failed to start."));
      };
      // Zero-copy handoff: the main thread must not touch mono afterwards.
      worker.postMessage(
        { jobId, mono, sampleRate, clipFraction, spans },
        [mono.buffer],
      );
    });
  } finally {
    worker.terminate();
  }
}
