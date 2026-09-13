import { AudioLines, Info, Pause, Play, Trophy, Volume1, Volume2, VolumeX } from "lucide-react";
import * as Slider from "@radix-ui/react-slider";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { FileSlot, type Outcome, type SlotState } from "@/components/file-slot";
import { SpectrumPlot } from "@/components/spectrum-plot";
import { Button } from "@/components/ui/button";
import { analyzeFile, compareAnalyses } from "@/lib/audio/analyze";
import { makeDemoFiles } from "@/lib/audio/demo";
import { formatHz } from "@/lib/audio/format";
import type { Analysis, Comparison, SlotId } from "@/lib/audio/types";
import { cn } from "@/lib/utils";

type Slots = { a: SlotState; b: SlotState };

const idle: SlotState = { status: "idle" };

function analysisOf(s: SlotState): Analysis | null {
  return s.status === "ready" ? s.analysis : null;
}

/**
 * iOS tabs (and other ≤4 GB devices) get OOM-killed by two parallel
 * full-song decodes, so analyses serialize there. Everywhere else they run
 * in parallel. Feature-detected once per session.
 */
function deviceNeedsSerialAnalysis(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { deviceMemory?: number; maxTouchPoints?: number };
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory <= 4) return true;
  const ua = nav.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports as Macintosh — multi-touch gives it away.
  if (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 2) return true;
  return false;
}

const serialQueue: { tail: Promise<void> } = { tail: Promise.resolve() };

function enqueueAnalysis<T>(work: () => Promise<T>): Promise<T> {
  if (!deviceNeedsSerialAnalysis()) return work();
  const run = serialQueue.tail.then(work);
  // The chain survives individual failures; callers still get their error.
  serialQueue.tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function Analyzer() {
  const [slots, setSlots] = useState<Slots>({ a: idle, b: idle });
  const [demoBusy, setDemoBusy] = useState(false);
  const gens = useRef({ a: 0, b: 0 });
  const urls = useRef({ a: null as string | null, b: null as string | null });

  const release = useCallback((id: SlotId) => {
    // Stop any in-flight playback first: revoking a blob URL out from under
    // a playing element kills seeks and can stall the element.
    document.querySelectorAll("audio").forEach((el) => {
      if (!el.paused) el.pause();
    });
    const url = urls.current[id];
    if (url) URL.revokeObjectURL(url);
    urls.current[id] = null;
  }, []);

  const run = useCallback(
    async (id: SlotId, file: File) => {
      const gen = ++gens.current[id];
      release(id);
      setSlots((s) => ({
        ...s,
        [id]: { status: "loading", fileName: file.name, progress: 0.02, phase: "Starting" },
      }));
      try {
        const analysis = await enqueueAnalysis(async () => {
          // A newer file may have arrived while queued on serial devices.
          if (gens.current[id] !== gen) throw new Error("superseded");
          return analyzeFile(file, (phase, amount) => {
            if (gens.current[id] !== gen) return;
            setSlots((s) => ({
              ...s,
              [id]: { status: "loading", fileName: file.name, progress: amount, phase },
            }));
          });
        });
        if (gens.current[id] !== gen) {
          URL.revokeObjectURL(analysis.objectUrl);
          return;
        }
        urls.current[id] = analysis.objectUrl;
        setSlots((s) => ({ ...s, [id]: { status: "ready", analysis } }));
      } catch (err) {
        if (gens.current[id] !== gen) return;
        const message = err instanceof Error ? err.message : "Could not analyze that file.";
        setSlots((s) => ({ ...s, [id]: { status: "error", message } }));
      }
    },
    [release],
  );

  const clear = useCallback(
    (id: SlotId) => {
      gens.current[id]++;
      release(id);
      setSlots((s) => ({ ...s, [id]: idle }));
    },
    [release],
  );

  const loadDemo = useCallback(async () => {
    setDemoBusy(true);
    try {
      await new Promise((r) => setTimeout(r, 40));
      const files = await makeDemoFiles();
      await Promise.all([run("a", files.a), run("b", files.b)]);
    } finally {
      setDemoBusy(false);
    }
  }, [run]);

  const onWindowDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const files = [...e.dataTransfer.files].filter((f) =>
        /audio|mpeg|mp4|ogg|wav|flac/i.test(f.type || f.name),
      );
      if (files.length === 0) return;
      if (files.length >= 2) {
        void run("a", files[0]!);
        void run("b", files[1]!);
        return;
      }
      const target: SlotId =
        slots.a.status === "idle" ? "a" : slots.b.status === "idle" ? "b" : "a";
      void run(target, files[0]!);
    },
    [run, slots.a.status, slots.b.status],
  );

  const a = analysisOf(slots.a);
  const b = analysisOf(slots.b);
  const comparison: Comparison | null = useMemo(
    () => (a && b ? compareAnalyses(a, b) : null),
    [a, b],
  );

  // A/B compare: which slot the verdict button started (null = manual play).
  const [abPlaying, setAbPlaying] = useState<SlotId | null>(null);
  const abArmed = useRef(false);
  const abAnalyses = useRef<{ a: Analysis; b: Analysis } | null>(null);

  // One global volume for both previews (persisted). Fresh sessions start at
  // 75% — clearly audible but never ear-splitting. The A/B loudness match
  // lives separately as per-slot ratios, so switching never moves this.
  const [volume, setVolume] = useState<number>(() => {
    try {
      const raw = localStorage.getItem("spectra:volume");
      if (raw == null) return 0.75;
      const v = Number(raw);
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.75;
    } catch {
      return 0.75;
    }
  });
  const matchRef = useRef<{ a: number; b: number }>({ a: 1, b: 1 });

  const applyVolumes = useCallback(() => {
    const els = [...document.querySelectorAll("audio[data-slot]")] as HTMLAudioElement[];
    for (const el of els) {
      const id = el.dataset.slot as SlotId | undefined;
      const m = id ? (matchRef.current[id] ?? 1) : 1;
      el.volume = Math.min(1, Math.max(0, volume * m));
    }
  }, [volume]);

  // Keep every preview element on the global level, including freshly
  // mounted ones after a file loads.
  useEffect(() => {
    applyVolumes();
  }, [applyVolumes, a, b]);

  const handleVolumeChange = useCallback((v: number) => {
    setVolume(v);
    try {
      localStorage.setItem("spectra:volume", String(v));
    } catch {
      // Private mode: session-only volume.
    }
  }, []);

  // Manual slot playback cancels A/B mode (unless this event IS the switch).
  useEffect(() => {
    const onPlay = (e: Event) => {
      if (abArmed.current) {
        abArmed.current = false;
        setAbPlaying((e as CustomEvent<SlotId>).detail);
      } else {
        setAbPlaying(null);
      }
    };
    window.addEventListener("spectra:now-playing", onPlay);
    return () => window.removeEventListener("spectra:now-playing", onPlay);
  }, []);

  // New files invalidate any A/B session and its loudness match.
  useEffect(() => {
    setAbPlaying(null);
    matchRef.current = { a: 1, b: 1 };
    abAnalyses.current = a && b ? { a, b } : null;
  }, [a, b]);

  // Fade bookkeeping so rapid successive switches never strand audio:
  // only the newest fade on an element may pause it.
  const fadeSeq = useRef({ a: 0, b: 0 });

  const fadeOutThenPause = useCallback((el: HTMLAudioElement, id: SlotId, holdVolume: number) => {
    const seq = ++fadeSeq.current[id];
    const ms = 70;
    const t0 = performance.now();
    const step = () => {
      if (fadeSeq.current[id] !== seq) return; // superseded by a newer fade
      const k = 1 - Math.min(1, (performance.now() - t0) / ms);
      try {
        el.volume = Math.max(0, holdVolume * k);
      } catch {
        // Element gone mid-fade: nothing to pause.
        return;
      }
      if (k > 0) {
        requestAnimationFrame(step);
      } else {
        el.pause();
        try {
          el.volume = holdVolume;
        } catch {
          // Already removed.
        }
      }
    };
    requestAnimationFrame(step);
  }, []);

  const abSwitch = useCallback(
    (target: SlotId) => {
      const pair = abAnalyses.current;
      if (!pair) return;
      const els = [...document.querySelectorAll("audio[data-slot]")] as HTMLAudioElement[];
      const targetEl = els.find((el) => el.dataset.slot === target);
      const otherEl = els.find((el) => el.dataset.slot !== target) ?? null;
      if (!targetEl) return;
      // Continue where the other preview left off. The seek is issued below
      // (once, after the crossfade starts) so decode stalls stay silent.
      const otherTime = otherEl && !otherEl.paused ? otherEl.currentTime : null;
      const t = otherTime ?? targetEl.currentTime;
      // Loudness match on RMS so the switch compares quality, not volume.
      // Stored as ratios against the global volume (which never moves here),
      // so the user's level is retained across switches. The louder side is
      // attenuated to the quieter one, never the reverse.
      const rmsT = target === "a" ? pair.a.rmsDb : pair.b.rmsDb;
      const rmsO = target === "a" ? pair.b.rmsDb : pair.a.rmsDb;
      const diffDb = rmsO - rmsT;
      const ratio = Math.max(0.05, Math.min(1, Math.pow(10, -Math.abs(diffDb) / 20)));
      const targetIsLouder = diffDb <= 0;
      const tRatio = targetIsLouder ? ratio : 1;
      const oRatio = targetIsLouder ? 1 : ratio;
      matchRef.current = target === "a" ? { a: tRatio, b: oRatio } : { a: oRatio, b: tRatio };
      const targetVolume = Math.min(1, Math.max(0, volume * tRatio));
      const otherVolume = Math.min(1, Math.max(0, volume * oRatio));
      targetEl.volume = targetVolume;

      const startTarget = () => {
        abArmed.current = true;
        targetEl.play().catch(() => {
          abArmed.current = false;
          setAbPlaying(null);
        });
      };

      if (otherEl && !otherEl.paused) {
        // Crossfade: the old side fades out while the new side seeks (its
        // decode stall happens silently) and starts only once positioned.
        otherEl.volume = otherVolume;
        fadeOutThenPause(otherEl, otherEl.dataset.slot === "a" ? "a" : "b", otherVolume);
        const hasDuration =
          Number.isFinite(targetEl.duration) && targetEl.duration > 0;
        const seekTo = hasDuration
          ? Math.max(0, Math.min(t, Math.max(0, targetEl.duration - 0.1)))
          : null;
        if (seekTo == null || Math.abs(targetEl.currentTime - seekTo) < 0.05) {
          startTarget();
        } else {
          targetEl.currentTime = seekTo;
          let done = false;
          const go = () => {
            if (done) return;
            done = true;
            targetEl.removeEventListener("seeked", go);
            startTarget();
          };
          targetEl.addEventListener("seeked", go);
          // Never hang on a missing event: bound the wait.
          window.setTimeout(go, 400);
        }
      } else {
        if (otherEl) {
          otherEl.volume = otherVolume;
          otherEl.pause();
        }
        startTarget();
      }
    },
    [volume, fadeOutThenPause],
  );

  const outcomeFor = useCallback(
    (id: SlotId): Outcome => {
      if (!comparison) return null;
      if (comparison.winner === "tie") return "tie";
      return comparison.winner === id ? "win" : "lose";
    },
    [comparison],
  );

  // Declare the winner everywhere, including the tab title.
  useEffect(() => {
    if (!comparison) {
      document.title = "Spectra";
    } else if (comparison.winner === "tie") {
      document.title = "Toss-up · Spectra";
    } else {
      document.title = `File ${comparison.winner.toUpperCase()} wins · Spectra`;
    }
  }, [comparison]);

  return (
    <div
      className="min-h-dvh bg-bg text-fg"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onWindowDrop}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
        <header className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-xl">
            <p className="font-mono text-[11px] tracking-[0.22em] text-muted uppercase">
              Spectra
            </p>
            <h1 className="mt-2 text-3xl leading-tight font-medium tracking-tight text-fg sm:text-4xl">
              Which copy kept the air?
            </h1>
            <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted">
              Encoders write a bitrate in the header. That is a claim. Spectra
              reads the audio itself — a 320 kbps file upconverted from 128 still
              dies at 16 kHz.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={() => void loadDemo()}
              disabled={demoBusy || slots.a.status === "loading" || slots.b.status === "loading"}
            >
              <AudioLines className="size-4" />
              {demoBusy ? "Building demo" : "Load a demo comparison"}
            </Button>
          </div>
        </header>

        {comparison && (
          <Verdict
            comparison={comparison}
            a={a!}
            b={b!}
            abPlaying={abPlaying}
            onAbSwitch={(target) => abSwitch(target)}
            volume={volume}
            onVolumeChange={handleVolumeChange}
          />
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <FileSlot
            id="a"
            state={slots.a}
            outcome={outcomeFor("a")}
            onFile={(f) => void run("a", f)}
            onClear={() => clear("a")}
          />
          <FileSlot
            id="b"
            state={slots.b}
            outcome={outcomeFor("b")}
            onFile={(f) => void run("b", f)}
            onClear={() => clear("b")}
          />
        </div>

        <SpectrumPlot a={a} b={b} winnerId={comparison?.winner ?? null} />

        {a && b && <CompareTable a={a} b={b} winner={comparison?.winner ?? "tie"} />}

        <HowTo />
      </div>
    </div>
  );
}

function Verdict({
  comparison,
  a,
  b,
  abPlaying,
  onAbSwitch,
  volume,
  onVolumeChange,
}: {
  comparison: Comparison;
  a: Analysis;
  b: Analysis;
  abPlaying: SlotId | null;
  onAbSwitch: (target: SlotId) => void;
  volume: number;
  onVolumeChange: (v: number) => void;
}) {
  const decided = comparison.winner !== "tie";
  const winnerSlot = decided ? comparison.winner.toUpperCase() : null;
  const tone = decided
    ? "bg-bg-elevated shadow-[0_0_0_1.5px_var(--color-win),0_0_60px_-16px_var(--color-win)]"
    : "bg-bg-elevated";
  const next = abPlaying === "a" ? "b" : "a";

  return (
    <aside aria-live="polite" className={cn("rounded-xl px-5 py-4 sm:px-6 sm:py-5", tone)}>
      <p className="flex items-center gap-1.5 font-mono text-[11px] tracking-widest text-muted uppercase">
        {decided && <Trophy className="size-3.5 text-win" />}
        {decided
          ? `Winner · File ${winnerSlot} · ${comparison.confidence} confidence`
          : "Toss-up · no winner"}
      </p>
      <h2 className="mt-1 text-xl font-medium tracking-tight text-fg sm:text-2xl">
        {comparison.headline}
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
        {comparison.detail}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          variant="default"
          onClick={() => onAbSwitch(next)}
          className="shadow-[0_0_24px_-6px_var(--color-accent)] hover:shadow-[0_0_32px_-4px_var(--color-accent)]"
          aria-label={
            abPlaying
              ? `Now previewing File ${abPlaying.toUpperCase()} — switch to File ${next.toUpperCase()} at the same position`
              : "Preview A and B back to back at matched loudness"
          }
        >
          {abPlaying ? (
            <Pause className="size-4" />
          ) : (
            <Play className="size-4 ml-0.5" />
          )}
          {abPlaying
            ? `Previewing ${abPlaying.toUpperCase()} — switch to ${next.toUpperCase()}`
            : "A/B compare by ear"}
        </Button>
        <span className="text-xs text-faint">
          Same position, matched loudness.
        </span>
        <VolumeControl volume={volume} onVolumeChange={onVolumeChange} />
      </div>
      <div className="mt-4 grid max-w-3xl gap-3 sm:grid-cols-2">
        <ScoreBar
          label="File A"
          score={a.score}
          cutoffHz={a.cutoffHz}
          highlighted={comparison.winner === "a"}
          dimmed={decided && comparison.winner !== "a"}
        />
        <ScoreBar
          label="File B"
          score={b.score}
          cutoffHz={b.cutoffHz}
          highlighted={comparison.winner === "b"}
          dimmed={decided && comparison.winner !== "b"}
        />
      </div>
    </aside>
  );
}

function VolumeControl({
  volume,
  onVolumeChange,
}: {
  volume: number;
  onVolumeChange: (v: number) => void;
}) {
  const lastAudible = useRef(0.75);
  useEffect(() => {
    if (volume > 0) lastAudible.current = volume;
  }, [volume]);

  const Icon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => onVolumeChange(volume === 0 ? lastAudible.current : 0)}
        className="inline-flex size-9 items-center justify-center rounded-sm text-muted hover:bg-bg-subtle hover:text-fg"
        aria-label={volume === 0 ? "Unmute previews" : "Mute previews"}
      >
        <Icon className="size-4" />
      </button>
      <Slider.Root
        value={[volume]}
        max={1}
        step={0.01}
        onValueChange={([v]) => onVolumeChange(v ?? 1)}
        className="relative flex h-9 w-32 touch-none items-center sm:w-40"
        aria-label="Preview volume"
      >
        <Slider.Track className="relative h-1 grow rounded-full bg-bg-subtle">
          <Slider.Range className="absolute h-full rounded-full bg-accent" />
        </Slider.Track>
        <Slider.Thumb
          className="block size-4 rounded-full bg-accent shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          aria-label="Volume level"
        />
      </Slider.Root>
      <span className="w-10 font-mono text-xs text-muted tabular-nums">
        {Math.round(volume * 100)}%
      </span>
    </div>
  );
}

function ScoreBar({
  label,
  score,
  cutoffHz,
  highlighted,
  dimmed,
}: {
  label: string;
  score: number;
  cutoffHz: number;
  highlighted: boolean;
  dimmed: boolean;
}) {
  return (
    <div className={cn(dimmed && "opacity-60")}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-mono text-xs text-muted">
          {highlighted && <Trophy className="size-3 text-win" />}
          {label}
        </span>
        <span className="font-mono text-xs text-faint tabular-nums">
          {score.toFixed(0)}/100 · {formatHz(cutoffHz)}
        </span>
      </div>
      <div
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bg-subtle"
        role="img"
        aria-label={`${label} quality score ${score.toFixed(0)} out of 100`}
      >
        <div
          className={cn("h-full rounded-full", highlighted ? "bg-win" : "bg-muted/60")}
          style={{ width: `${Math.max(2, Math.min(100, score))}%` }}
        />
      </div>
    </div>
  );
}

function CompareTable({
  a,
  b,
  winner,
}: {
  a: Analysis;
  b: Analysis;
  winner: SlotId | "tie";
}) {
  const rows: { label: string; av: string; bv: string; better?: SlotId | "tie" }[] = [
    {
      label: "Winner",
      av: winner === "a" ? "Winner" : winner === "tie" ? "Tie" : "Runner-up",
      bv: winner === "b" ? "Winner" : winner === "tie" ? "Tie" : "Runner-up",
      better: winner,
    },
    {
      label: "Quality score",
      av: `${a.score.toFixed(0)} / 100`,
      bv: `${b.score.toFixed(0)} / 100`,
      better: Math.abs(a.score - b.score) < 3 ? "tie" : a.score > b.score ? "a" : "b",
    },
    {
      label: "Spectral ceiling",
      av: formatHz(a.cutoffHz),
      bv: formatHz(b.cutoffHz),
      better: Math.abs(a.cutoffHz - b.cutoffHz) < 400 ? "tie" : a.cutoffHz > b.cutoffHz ? "a" : "b",
    },
    {
      label: "Container bitrate",
      av: `${Math.round(a.containerKbps)} kbps`,
      bv: `${Math.round(b.containerKbps)} kbps`,
    },
    {
      label: "Header bitrate",
      av: a.container.claimedKbps ? `${a.container.claimedKbps} kbps` : "—",
      bv: b.container.claimedKbps ? `${b.container.claimedKbps} kbps` : "—",
    },
    {
      label: "High-frequency occupancy",
      av: `${Math.round(a.hfOccupancy * 100)}%`,
      bv: `${Math.round(b.hfOccupancy * 100)}%`,
      better: Math.abs(a.hfOccupancy - b.hfOccupancy) < 0.04 ? "tie" : a.hfOccupancy > b.hfOccupancy ? "a" : "b",
    },
    {
      label: "Dynamic range (crest)",
      av: `${a.crestDb.toFixed(1)} dB`,
      bv: `${b.crestDb.toFixed(1)} dB`,
      better: Math.abs(a.crestDb - b.crestDb) < 1 ? "tie" : a.crestDb > b.crestDb ? "a" : "b",
    },
    {
      label: "Stereo width",
      av: a.channels < 2 ? "Mono" : a.stereoWidth.toFixed(2),
      bv: b.channels < 2 ? "Mono" : b.stereoWidth.toFixed(2),
    },
    {
      label: "Clipping",
      av: a.clipFraction > 0.0003 ? `${(a.clipFraction * 100).toFixed(2)}%` : "None",
      bv: b.clipFraction > 0.0003 ? `${(b.clipFraction * 100).toFixed(2)}%` : "None",
      better:
        Math.abs(a.clipFraction - b.clipFraction) < 0.0002
          ? "tie"
          : a.clipFraction < b.clipFraction
            ? "a"
            : "b",
    },
  ];

  return (
    <div className="overflow-hidden rounded-xl bg-bg-elevated">
      <div className="grid grid-cols-[minmax(0,1.2fr)_1fr_1fr] border-b border-border px-4 py-3 font-mono text-[11px] tracking-widest text-faint uppercase sm:px-5">
        <span>Metric</span>
        <span className={cn("inline-flex items-center gap-1", winner === "a" && "text-win")}>
          {winner === "a" && <Trophy className="size-3" />}A
        </span>
        <span className={cn("inline-flex items-center gap-1", winner === "b" && "text-win")}>
          {winner === "b" && <Trophy className="size-3" />}B
        </span>
      </div>
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid grid-cols-[minmax(0,1.2fr)_1fr_1fr] border-b border-border/70 px-4 py-3 last:border-b-0 sm:px-5"
        >
          <span className="text-xs text-muted">{row.label}</span>
          <span
            className={cn(
              "font-mono text-xs tabular-nums",
              row.better === "a" ? "text-fg" : "text-muted",
            )}
          >
            {row.av}
          </span>
          <span
            className={cn(
              "font-mono text-xs tabular-nums",
              row.better === "b" ? "text-fg" : "text-muted",
            )}
          >
            {row.bv}
          </span>
        </div>
      ))}
    </div>
  );
}

function HowTo() {
  return (
    <section className="rounded-xl bg-bg-elevated p-5 sm:p-6">
      <div className="flex items-center gap-2 text-fg">
        <Info className="size-4 text-muted" />
        <h2 className="text-sm font-medium">How to read this</h2>
      </div>
      <ol className="mt-4 grid gap-4 text-sm leading-relaxed text-muted sm:grid-cols-3">
        <li>
          <p className="font-medium text-fg">Ignore the header</p>
          <p className="mt-1">
            File size and tagged bitrate can lie. A transcode of a 128 kbps MP3
            still has a 16 kHz ceiling even if it now says 320.
          </p>
        </li>
        <li>
          <p className="font-medium text-fg">Look for the black band</p>
          <p className="mt-1">
            Brightness is energy. A hard dark strip at the top of the spectrogram
            is the encoder's low-pass — that is the real bitrate.
          </p>
        </li>
        <li>
          <p className="font-medium text-fg">Typical ceilings</p>
          <p className="mt-1">
            ~16 kHz ≈ 128 kbps · ~19 kHz ≈ 192–256 · 20 kHz+ with a natural fade
            into noise is lossless or transparent.
          </p>
        </li>
      </ol>
      <p className="mt-5 text-xs text-faint">
        Files stay in this browser. Nothing is uploaded.
      </p>
    </section>
  );
}
