// Client for the DSP worker. Same signature/semantics as runDsp; falls back
// to the main-thread legacy path when workers are unavailable, when
// ?worker=0 is set (debug hatch), or when the worker fails to boot.
// An AbortSignal kills the worker outright (never falls back mid-abort).
import {
  CancelledError,
  runDsp,
  throwIfAborted,
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
  signal?: AbortSignal,
): Promise<DspResult> {
  throwIfAborted(signal);
  if (!(await probeWorker())) {
    return runDsp(mono, sampleRate, clipFraction, onProgress, spans, signal);
  }
  throwIfAborted(signal);

  const jobId = ++jobSeq;
  // No transfer: the mono buffer is structured-cloned (~100 ms worst case),
  // which keeps the original usable so a wedged worker can fall back to the
  // main-thread path instead of hanging forever on a detached buffer.
  const WORKER_TIMEOUT_MS = 60_000;
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL("./dsp.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    console.warn("[spectra] worker unavailable, analyzing on main thread");
    return runDsp(mono, sampleRate, clipFraction, onProgress, spans, signal);
  }

  const active = worker;
  try {
    return await new Promise<DspResult>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error("worker-timeout"));
      }, WORKER_TIMEOUT_MS);
      const cleanup = () => {
        window.clearTimeout(timer);
        active.onmessage = null;
        active.onerror = null;
        signal?.removeEventListener("abort", onAbort);
        active.terminate();
      };
      // A superseded or cleared slot must not keep burning a full STFT in
      // the background: kill the worker the moment the signal fires.
      const onAbort = () => {
        cleanup();
        reject(new CancelledError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      active.onmessage = (e: MessageEvent) => {
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
          cleanup();
          resolve(d.result);
        } else if (d.type === "error") {
          cleanup();
          reject(new Error(d.message || "Analysis failed in worker."));
        }
      };
      active.onerror = () => {
        cleanup();
        reject(new Error("Analysis worker failed to start."));
      };
      active.postMessage({ jobId, mono, sampleRate, clipFraction, spans });
    });
  } catch (err) {
    // A cancelled run is intentional — never resurrect it as main-thread
    // work (that would exactly duplicate the CPU the abort saved).
    if (err instanceof CancelledError || signal?.aborted) {
      throw err instanceof CancelledError ? err : new CancelledError();
    }
    // A failed worker must never strand an analysis: fall back to the
    // legacy main-thread path (possible because mono was cloned, not
    // transferred). Deterministic DSP bugs surface identically from legacy,
    // so nothing is hidden — timeouts just become retried work instead of a
    // hung spinner.
    console.warn(
      "[spectra]",
      err instanceof Error ? err.message : "worker failed",
      "— retrying on main thread",
    );
    return runDsp(mono, sampleRate, clipFraction, onProgress, spans, signal);
  } finally {
    worker.terminate();
  }
}
