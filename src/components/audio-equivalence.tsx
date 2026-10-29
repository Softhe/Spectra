import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { verifyAudioFiles } from "@/lib/audio/equivalence-browser";
import type { EquivalenceResult } from "@/lib/audio/equivalence";

const HEADLINES = {
  exact: "The decoded audio matches exactly",
  tolerance: "The decoded audio matches within tolerance",
  different: "The decoded audio differs",
  unavailable: "Audio equivalence could not be verified",
};

export function AudioEquivalence({
  a,
  b,
  disabled = false,
  onResult,
}: {
  a: File;
  b: File;
  disabled?: boolean;
  onResult: (result: EquivalenceResult | null) => void;
}) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<EquivalenceResult | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = null;
    },
    [],
  );
  useEffect(() => {
    if (disabled) controller.current?.abort();
  }, [disabled]);

  async function run() {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    const timer = window.setTimeout(() => current.abort(), 120000);
    setRunning(true);
    setProgress(0);
    setResult(null);
    setCancelled(false);
    onResult(null);
    try {
      const next = await verifyAudioFiles(
        a,
        b,
        (value) => {
          if (!current.signal.aborted) setProgress(value);
        },
        current.signal,
      );
      if (current.signal.aborted) return;
      setResult(next);
      onResult(next);
    } catch {
      if (controller.current === current) setCancelled(true);
    } finally {
      window.clearTimeout(timer);
      if (controller.current === current) setRunning(false);
    }
  }

  return (
    <section className="mt-4 rounded-lg border border-border p-3" aria-label="Complete audio check">
      <h3 className="text-sm font-medium text-fg">Check the complete audio</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Compare every decoded sample in mono or stereo WAV and FLAC files, up to ten minutes long.
        WAV is read in chunks. FLAC decoding has a separate memory limit. No files are changed.
      </p>
      <details className="mt-2 text-xs text-muted">
        <summary className="cursor-pointer">File and memory limits</summary>
        <p className="mt-1">
          WAV files can be up to 1 GiB. FLAC files can be up to 32 MiB each. The combined decoded
          FLAC data must fit within 64 MiB, or 32 MiB on low-memory devices. Files must have a known
          sample count. Results received after two minutes are discarded.
        </p>
      </details>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          disabled={running || disabled}
          onClick={() => void run()}
        >
          {running ? "Checking audio" : "Check whether the audio is identical"}
        </Button>
        {running && (
          <Button size="sm" variant="outline" onClick={() => controller.current?.abort()}>
            Cancel check
          </Button>
        )}
        {disabled && (
          <span className="text-xs text-muted">
            Available after shared-passage analysis finishes.
          </span>
        )}
      </div>
      <div role="status" className="mt-2 text-xs leading-relaxed text-muted">
        {running &&
          (progress === 0
            ? "Reading and decoding the files."
            : `Checked ${Math.floor(progress * 100)}% of the audio.`)}
        {cancelled && "The check stopped before completion. No equivalence result was recorded."}
        {result && (
          <>
            <p className="font-medium text-fg">{HEADLINES[result.status]}</p>
            <p>{result.detail}</p>
            {result.framesCompared > 0 && (
              <p>Checked {result.framesCompared.toLocaleString()} samples in each channel.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
