import { AudioLines, Crosshair, EyeOff, Pause, Play, Trophy, Upload, X } from "lucide-react";
import * as Slider from "@radix-ui/react-slider";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { audioFilesFrom, STOP_EVENT } from "@/components/audio-drop";
import { SpectrogramCanvas } from "@/components/spectrogram-canvas";
import { Button } from "@/components/ui/button";
import { bitrateDescription } from "@/lib/audio/presentation";
import { QUALITY_LABEL, ROLLOFF_LABEL } from "@/lib/audio/analyze";
import {
  channelLabel,
  formatBytes,
  formatDb,
  formatDuration,
  formatHz,
  formatKbps,
  formatSampleRate,
} from "@/lib/audio/format";
import type { RefinedMetrics } from "@/lib/audio/refine";
import type { Analysis, SlotId, SpectrogramData } from "@/lib/audio/types";
import { cn } from "@/lib/utils";

export type SlotState =
  | { status: "idle" }
  | { status: "loading"; fileName: string; progress: number; phase: string; eta?: string }
  | { status: "error"; message: string }
  | { status: "ready"; analysis: Analysis };

export type Outcome = "win" | "lose" | "tie" | null;

export const SLOT_LABELS: Record<SlotId, string> = {
  a: "File A",
  b: "File B",
  c: "File C",
  d: "File D",
};

const TRACE_CLASS: Record<SlotId, string> = {
  a: "text-trace-a",
  b: "text-trace-b",
  c: "text-trace-c",
  d: "text-trace-d",
};

/** Blind-mode display names: the slot letters turn into anonymous clips. */
export const CLIP_LABELS: Record<SlotId, string> = {
  a: "Clip 1",
  b: "Clip 2",
  c: "Clip 3",
  d: "Clip 4",
};

export type ScanState = { busy: boolean; progress: number; phase: string } | null;

type Props = {
  id: SlotId;
  state: SlotState;
  outcome: Outcome;
  onFile: (file: File) => void;
  onClear: () => void;
  /** A drop onto this slot carried no audio-like file. */
  onRejectedDrop: () => void;
  /** Double-blind mode: hide identity, numbers, and pictures until reveal. */
  masked?: boolean;
  /** Shared-window re-measurement, when the refinement pass succeeded. */
  refined?: RefinedMetrics | null;
  loopWindow?: { start: number; length: number } | null;
  /** Excerpt re-scan at the playhead (disabled while another scan runs). */
  scanState?: ScanState;
  onScan?: (seekSec: number) => void;
  /** A completed pinned excerpt replaces the default spectrogram picture. */
  override?: SpectrogramData | null;
  onResetOverride?: () => void;
};

const LOOP_WRAP_BACK = 0.75; // s. tolerate a small overshoot before re-wrapping

const ACCEPT = "audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg,.opus,.aiff,.aif,.mp4,.caf,.webm";

/** Cross-slot exclusivity: when one preview starts, the other pauses. */
const PLAY_EVENT = "spectra:now-playing";
function dragHasFiles(e: DragEvent): boolean {
  return [...(e.dataTransfer?.types ?? [])].includes("Files");
}

export function FileSlot({
  id,
  state,
  outcome,
  onFile,
  onClear,
  onRejectedDrop,
  masked,
  refined,
  loopWindow,
  scanState,
  onScan,
  override,
  onResetOverride,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [over, setOver] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const label = masked ? CLIP_LABELS[id] : SLOT_LABELS[id];
  const trace = TRACE_CLASS[id];

  const readyId = state.status === "ready" ? state.analysis.id : "";
  useEffect(() => {
    setPlaying(false);
    setPlayError(null);
    setPosition(0);
    setMediaDuration(null);
  }, [readyId]);

  // Pause this preview when the other slot starts playing.
  useEffect(() => {
    const onOtherPlay = (e: Event) => {
      if ((e as CustomEvent<SlotId>).detail !== id) audioRef.current?.pause();
    };
    window.addEventListener(PLAY_EVENT, onOtherPlay);
    return () => window.removeEventListener(PLAY_EVENT, onOtherPlay);
  }, [id]);

  // Never leave orphan audio running if this slot is cleared or replaced.
  useEffect(() => {
    const el = audioRef.current;
    return () => {
      el?.pause();
    };
  }, [readyId]);

  function pick(files: FileList | File[] | null) {
    const file = files?.[0];
    if (file) onFile(file);
  }

  // The whole card is a drop target in every state, so a drop always lands
  // in the slot it was aimed at (the window-level handler only sees drops
  // that miss both cards).
  //
  // Highlight via an enter/leave depth counter: moving between child
  // elements fires leave on the card too, and Safari reports
  // relatedTarget = null on dragleave, so a containment check flickers.
  const dragDepth = useRef(0);

  // A drag that ends elsewhere (dropped on the other card / window, or
  // cancelled) must never leave this card stuck highlighted.
  useEffect(() => {
    const reset = () => {
      dragDepth.current = 0;
      setOver(false);
    };
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
    };
  }, []);

  function handleDragEnter(e: DragEvent<HTMLElement>) {
    dragDepth.current++;
    handleDragOver(e);
  }

  function handleDragOver(e: DragEvent<HTMLElement>) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    if (!over) setOver(true);
  }

  function handleDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setOver(false);
  }

  function handleDrop(e: DragEvent<HTMLElement>) {
    dragDepth.current = 0;
    setOver(false);
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const file = audioFilesFrom(e.dataTransfer.files)[0];
    if (file) onFile(file);
    else onRejectedDrop();
  }

  function togglePlay() {
    const el = audioRef.current;
    if (!el) return;
    setPlayError(null);
    if (el.paused) {
      // State syncs via onPlay/onPause; a rejection (e.g. interrupted load)
      // surfaces as an error line instead of a stuck pause icon.
      el.play().catch(() => {
        setPlaying(false);
        setPlayError("Preview could not start. Retry.");
      });
    } else {
      el.pause();
    }
  }

  function handlePlay() {
    setPlaying(true);
    // Claim exclusivity only once actually playing, so a failed play()
    // never silences the other slot.
    window.dispatchEvent(new CustomEvent<SlotId>(PLAY_EVENT, { detail: id }));
  }

  function handleStop() {
    setPlaying(false);
    window.dispatchEvent(new CustomEvent<SlotId>(STOP_EVENT, { detail: id }));
  }

  // A/B loop: when active, this preview's playhead wraps to the pinned start
  // (pair-aligned upstream) so identical positions repeat until stopped.
  function handleTime(tRaw: number) {
    const el = audioRef.current;
    if (!el || !loopWindow || !playing) {
      setPosition(tRaw);
      return;
    }
    const { start, length } = loopWindow;
    if (tRaw === tRaw && (tRaw > start + length || tRaw < start - LOOP_WRAP_BACK)) {
      try {
        el.currentTime = start;
      } catch {
        // Not seekable yet.
      }
      setPosition(start);
      return;
    }
    setPosition(tRaw);
  }

  return (
    <section
      aria-label={`${label}${outcome === "win" ? " (preferred)" : outcome === "lose" ? " (other copy)" : ""}`}
      data-drop-over={over || undefined}
      style={masked ? { transition: "none" } : undefined}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        "flex min-w-0 flex-col rounded-xl bg-bg-elevated p-4 outline-offset-2 transition-[box-shadow,outline-color] sm:p-5",
        outcome === "win" &&
          "shadow-[0_0_0_1.5px_var(--color-win),0_0_44px_-12px_var(--color-win)]",
        outcome === "lose" && "opacity-95 shadow-[0_0_0_1px_var(--color-border)]",
        over && "outline-2 outline-dashed outline-accent",
      )}
    >
      <header className="mb-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={cn("font-mono text-xs tracking-widest uppercase", trace)}>{label}</span>
          {outcome === "win" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-win px-2 py-0.5 text-[10px] font-semibold tracking-wide text-win-fg uppercase">
              <Trophy className="size-3" />
              Preferred
            </span>
          )}
          {outcome === "lose" && (
            <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted uppercase">
              Other copy
            </span>
          )}
          {outcome === "tie" && (
            <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted uppercase">
              No preference
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state.status === "ready" && state.analysis.liteAnalysis && !masked && (
            <span className="rounded-md bg-bg-subtle px-2 py-0.5 font-mono text-xs text-warn">
              Lite
            </span>
          )}
          {state.status === "ready" && refinedChanged(state.analysis, refined) && (
            <span
              className="rounded-md bg-info/15 px-2 py-0.5 font-mono text-[10px] text-info"
              title="Re-measured over common passages; at least one displayed measurement changed"
            >
              Refined
            </span>
          )}
          {state.status !== "idle" && (
            <button
              type="button"
              onClick={onClear}
              className="inline-flex size-9 items-center justify-center rounded-sm text-muted hover:bg-bg-subtle hover:text-fg"
              aria-label={`Remove ${label}`}
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      </header>

      {state.status === "idle" && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className={cn(
            "flex min-h-52 flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-4 text-center transition-colors duration-150",
            over && "border-accent bg-bg-subtle",
          )}
        >
          <span className="flex size-11 items-center justify-center rounded-md bg-bg-subtle text-muted">
            <Upload className="size-5" />
          </span>
          <span className="text-sm text-fg">Drop MP3, M4A, WAV, FLAC, OGG, AIFF, or WebM</span>
          <span className="text-xs text-muted">or choose a file</span>
        </button>
      )}

      {state.status === "loading" && (
        <div className="flex min-h-52 flex-1 flex-col items-center justify-center gap-3 px-4">
          <AudioLines className="size-6 text-muted" />
          <p className="max-w-full text-center text-sm text-fg [overflow-wrap:anywhere]">
            Reading {masked ? "hidden clip" : state.fileName}
          </p>
          <p aria-live="polite" className="font-mono text-xs text-muted">
            {state.phase}
          </p>
          <div
            role="progressbar"
            aria-label={masked ? "Analyzing hidden clip" : `Analyzing ${state.fileName}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(state.progress * 100)}
            aria-valuetext={`${state.phase}, ${Math.round(state.progress * 100)}%`}
            className="h-1 w-40 overflow-hidden rounded-full bg-bg-subtle"
          >
            <div
              className="h-full bg-accent transition-[width] duration-200 ease-out"
              style={{ width: `${Math.round(state.progress * 100)}%` }}
            />
          </div>
          {state.eta && (
            <p className="font-mono text-[11px] text-faint tabular-nums">~{state.eta} left</p>
          )}
        </div>
      )}

      {state.status === "error" && (
        <div className="flex min-h-52 flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <p role="alert" className="text-sm text-loss">
            {state.message}
          </p>
          <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
            Try another file
          </Button>
        </div>
      )}

      {state.status === "ready" && (
        <div className="flex flex-col gap-4">
          {masked ? (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-fg" aria-label="Identity hidden">
                  Identity hidden until reveal
                </p>
                <p className="mt-0.5 flex items-center gap-1 font-mono text-xs text-muted">
                  <EyeOff className="size-3.5" /> blind test · listen and judge by ear
                </p>
              </div>
              <Button
                variant="subtle"
                size="icon-sm"
                onClick={togglePlay}
                aria-label={playing ? `Pause ${label} preview` : `Play ${label} preview`}
                aria-pressed={playing}
                className={cn("shrink-0", playing && "ring-1 ring-win/60")}
              >
                {playing ? <Pause className="size-4" /> : <Play className="size-4 ml-0.5" />}
              </Button>
            </div>
          ) : (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-fg" title={state.analysis.fileName}>
                  {state.analysis.fileName}
                </p>
                <p className="mt-0.5 font-mono text-xs text-muted">
                  {state.analysis.container.codec}
                  {" · "}
                  {formatBytes(state.analysis.fileSize)}
                  {" · "}
                  {formatDuration(state.analysis.durationSec)}
                </p>
              </div>
              <Button
                variant="subtle"
                size="icon-sm"
                onClick={togglePlay}
                aria-label={playing ? `Pause ${label} preview` : `Play ${label} preview`}
                aria-pressed={playing}
                className={cn("shrink-0", playing && "ring-1 ring-win/60")}
              >
                {playing ? <Pause className="size-4" /> : <Play className="size-4 ml-0.5" />}
              </Button>
            </div>
          )}
          <audio
            ref={audioRef}
            src={state.analysis.objectUrl}
            data-slot={id}
            preload="auto"
            onEnded={handleStop}
            onPause={handleStop}
            onPlay={handlePlay}
            onTimeUpdate={(e) => handleTime(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              if (Number.isFinite(d) && d > 0) setMediaDuration(d);
            }}
            onSeeked={(e) => setPosition(e.currentTarget.currentTime)}
            onError={() => {
              setPlaying(false);
              setPlayError("Preview failed to load that file.");
            }}
          />
          <SeekBar
            label={label}
            position={position}
            duration={mediaDuration ?? state.analysis.durationSec}
            hideTotal={masked}
            onSeek={(t) => {
              const el = audioRef.current;
              if (el && Number.isFinite(t)) {
                try {
                  el.currentTime = t;
                } catch {
                  // Not yet seekable.
                }
                setPosition(t);
              }
            }}
          />
          {playError && (
            <p role="alert" className="text-xs text-loss">
              {playError}
            </p>
          )}

          {masked ? (
            <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-md bg-bg-inset text-center sm:h-64">
              <EyeOff className="size-5 text-faint" />
              <p className="max-w-60 text-xs leading-relaxed text-muted">
                Names and measurements stay hidden until you reveal the copies.
              </p>
            </div>
          ) : (
            <>
              {scanState?.busy ? (
                <div className="flex h-48 flex-col items-center justify-center gap-3 rounded-md bg-bg-inset sm:h-64">
                  <Crosshair className="size-5 text-accent" />
                  <p aria-live="polite" className="font-mono text-xs text-muted">
                    {scanState.phase}
                  </p>
                  <div
                    role="progressbar"
                    aria-label={`Scanning excerpt at the playhead`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(scanState.progress * 100)}
                    className="h-1 w-40 overflow-hidden rounded-full bg-bg-subtle"
                  >
                    <div
                      className="h-full bg-accent"
                      style={{ width: `${Math.round(scanState.progress * 100)}%` }}
                    />
                  </div>
                </div>
              ) : (
                <SpectrogramCanvas
                  analysis={state.analysis}
                  override={override}
                  onResetOverride={onResetOverride}
                />
              )}
              {onScan && (
                <div className="flex items-center justify-between gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onScan(position)}
                    disabled={Boolean(scanState?.busy)}
                    aria-label={`Re-scan a ~12 s excerpt at the ${label} playhead (${formatDuration(position)})`}
                  >
                    <Crosshair className="size-4" />
                    Re-scan at playhead ({formatDuration(position)})
                  </Button>
                </div>
              )}

              <dl className="grid grid-cols-1 gap-x-4 gap-y-3 text-sm min-[360px]:grid-cols-2">
                <Stat
                  label="Spectral ceiling"
                  value={formatHz(refined?.cutoffHz ?? state.analysis.cutoffHz)}
                  emphasize
                  note={
                    refined && Math.abs(refined.cutoffHz - state.analysis.cutoffHz) >= 50
                      ? `${formatHz(state.analysis.cutoffHz)} before lining up`
                      : undefined
                  }
                />
                <Stat
                  label="Spectral character"
                  value={QUALITY_LABEL[refined?.qualityClass ?? state.analysis.qualityClass]}
                  note={
                    refined && refined.qualityClass !== state.analysis.qualityClass
                      ? "judged on the shared passages"
                      : undefined
                  }
                />
              </dl>
              <details className="rounded-md border border-border px-3">
                <summary className="min-h-11 cursor-pointer py-3 text-xs font-medium text-fg focus-visible:outline-2 focus-visible:outline-accent">
                  Analysis details · {label}
                </summary>
                {state.analysis.liteAnalysis && (
                  <p className="mb-3 text-xs leading-relaxed text-warn">
                    This long file was analyzed from selected loud passages to limit memory use.
                  </p>
                )}
                <dl className="grid grid-cols-1 gap-x-4 gap-y-3 pb-4 min-[360px]:grid-cols-2">
                  <Stat
                    label="File-size average, including metadata"
                    value={formatKbps(state.analysis.containerKbps)}
                  />
                  <Stat
                    label={bitrateDescription(state.analysis).label}
                    value={bitrateDescription(state.analysis).value}
                  />
                  <Stat
                    label="Bit depth"
                    value={bitDepthLabel(state.analysis)}
                    note={
                      state.analysis.effectiveBits != null &&
                      typeof state.analysis.container.bitDepth === "number" &&
                      state.analysis.effectiveBits < state.analysis.container.bitDepth
                        ? `${state.analysis.effectiveBits}-bit content padded into the bigger container`
                        : undefined
                    }
                  />
                  <Stat label="Rolloff" value={ROLLOFF_LABEL[state.analysis.rolloff]} />
                  <Stat
                    label="Sample rate"
                    value={`${formatSampleRate(state.analysis.sampleRate)} · ${channelLabel(state.analysis.channels)}`}
                  />
                  <Stat
                    label="Peak / RMS"
                    value={`${formatDb(state.analysis.peakDb)} / ${formatDb(state.analysis.rmsDb)}`}
                  />
                  <Stat label="Crest" value={formatDb(state.analysis.crestDb)} />
                </dl>
              </details>
            </>
          )}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        // Opened by the slot's own buttons; as a tab stop it is an invisible,
        // unlabeled focus target.
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = "";
        }}
      />
    </section>
  );
}

/** Whether re-measuring over the shared passages moved any shown number. */
function refinedChanged(a: Analysis, r: RefinedMetrics | null | undefined): boolean {
  return Boolean(
    r &&
    (Math.abs(r.cutoffHz - a.cutoffHz) >= 50 ||
      Math.round(r.score) !== Math.round(a.score) ||
      r.qualityClass !== a.qualityClass),
  );
}

/** Lossless bit depth line: container vs the integer grid the content sits on. */
function bitDepthLabel(a: Analysis): string {
  const bits = a.container.bitDepth;
  const eff = a.effectiveBits;
  if (bits == null) return "Not available";
  if (typeof eff === "number" && eff < bits) {
    return `${bits}-bit container · ${eff}-bit content`;
  }
  return `${bits}-bit`;
}

function SeekBar({
  label,
  position,
  duration,
  hideTotal,
  onSeek,
}: {
  /** Blind rounds: copies of one song often differ in length, which would name them. */
  hideTotal?: boolean;
  label: string;
  position: number;
  duration: number;
  onSeek: (t: number) => void;
}) {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const clamped = Math.max(0, Math.min(position, safeDuration));
  // While dragging, show the dragged value and only hit the media element
  // on commit. one seek per gesture instead of dozens per second (each
  // restarts decode and stutters the A/B comparison).
  const [dragValue, setDragValue] = useState<number | null>(null);
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 font-mono text-[11px] text-faint tabular-nums">
        {formatDuration(dragValue ?? clamped)}
      </span>
      <Slider.Root
        value={[dragValue ?? clamped]}
        max={Math.max(safeDuration, 0.01)}
        step={0.1}
        disabled={safeDuration <= 0}
        onValueChange={([v]) => {
          if (v != null) setDragValue(v);
        }}
        onValueCommit={([v]) => {
          setDragValue(null);
          if (v != null) onSeek(v);
        }}
        className="relative flex h-6 flex-1 touch-none items-center disabled:pointer-events-none disabled:opacity-40"
      >
        <Slider.Track className="relative h-1 grow rounded-full bg-bg-subtle">
          <Slider.Range className="absolute h-full rounded-full bg-trace-a" />
        </Slider.Track>
        <Slider.Thumb
          className="block size-3.5 rounded-full bg-fg shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          aria-label={`Seek ${label} preview`}
        />
      </Slider.Root>
      <span className="w-10 shrink-0 text-right font-mono text-[11px] text-faint tabular-nums">
        {hideTotal ? "–:––" : formatDuration(safeDuration)}
      </span>
    </div>
  );
}

function Stat({
  label,
  value,
  emphasize,
  note,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
  note?: string;
}) {
  return (
    <div>
      <dt className="text-xs tracking-wide text-faint uppercase">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 font-mono text-xs tabular-nums",
          emphasize ? "text-fg" : "text-muted",
        )}
      >
        {value}
        {note && <span className="ml-1.5 text-[10px] text-info normal-case">{note}</span>}
      </dd>
    </div>
  );
}
