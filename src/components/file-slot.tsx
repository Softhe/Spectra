import {
  AudioLines,
  Pause,
  Play,
  Trophy,
  Upload,
  X,
} from "lucide-react";
import * as Slider from "@radix-ui/react-slider";
import { useEffect, useRef, useState } from "react";
import { SpectrogramCanvas } from "@/components/spectrogram-canvas";
import { Button } from "@/components/ui/button";
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
import type { Analysis, SlotId } from "@/lib/audio/types";
import { cn } from "@/lib/utils";

export type SlotState =
  | { status: "idle" }
  | { status: "loading"; fileName: string; progress: number; phase: string }
  | { status: "error"; message: string }
  | { status: "ready"; analysis: Analysis };

export type Outcome = "win" | "lose" | "tie" | null;

type Props = {
  id: SlotId;
  state: SlotState;
  outcome: Outcome;
  onFile: (file: File) => void;
  onClear: () => void;
};

const ACCEPT = "audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg,.opus,.aiff,.aif,.mp4";

/** Cross-slot exclusivity: when one preview starts, the other pauses. */
const PLAY_EVENT = "spectra:now-playing";

export function FileSlot({ id, state, outcome, onFile, onClear }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [over, setOver] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const label = id === "a" ? "File A" : "File B";
  const trace = id === "a" ? "text-trace-a" : "text-trace-b";

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

  function togglePlay() {
    const el = audioRef.current;
    if (!el) return;
    setPlayError(null);
    if (el.paused) {
      // State syncs via onPlay/onPause; a rejection (e.g. interrupted load)
      // surfaces as an error line instead of a stuck pause icon.
      el.play().catch(() => {
        setPlaying(false);
        setPlayError("Preview couldn't start — try again.");
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

  return (
    <section
      aria-label={`${label}${outcome === "win" ? " (winner)" : outcome === "lose" ? " (runner-up)" : ""}`}
      className={cn(
        "flex min-w-0 flex-col rounded-xl bg-bg-elevated p-4 transition-shadow sm:p-5",
        outcome === "win" &&
          "shadow-[0_0_0_1.5px_var(--color-win),0_0_44px_-12px_var(--color-win)]",
        outcome === "lose" && "opacity-95 shadow-[0_0_0_1px_var(--color-border)]",
      )}
    >
      <header className="mb-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={cn("font-mono text-xs tracking-widest uppercase", trace)}>
            {label}
          </span>
          {outcome === "win" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-win px-2 py-0.5 text-[10px] font-semibold tracking-wide text-win-fg uppercase">
              <Trophy className="size-3" />
              Winner
            </span>
          )}
          {outcome === "lose" && (
            <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted uppercase">
              Runner-up
            </span>
          )}
          {outcome === "tie" && (
            <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted uppercase">
              Tie
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state.status === "ready" && (
            <span
              className={cn(
                "rounded-md px-2 py-0.5 font-mono text-[11px] tabular-nums",
                outcome === "win" ? "bg-win/15 text-fg" : "bg-bg-subtle text-muted",
              )}
              title="Composite quality score out of 100"
            >
              {state.analysis.score.toFixed(0)}/100
            </span>
          )}
          {state.status === "ready" && state.analysis.liteAnalysis && (
            <span
              className="rounded-md bg-bg-subtle px-2 py-0.5 font-mono text-[11px] text-warn"
              title="Very long file: analyzed from its loudest excerpts to stay within memory limits"
            >
              Lite
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
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(false);
            pick(e.dataTransfer.files);
          }}
          className={cn(
            "flex min-h-52 flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-4 text-center transition-colors duration-150",
            over && "border-accent bg-bg-subtle",
          )}
        >
          <span className="flex size-11 items-center justify-center rounded-md bg-bg-subtle text-muted">
            <Upload className="size-5" />
          </span>
          <span className="text-sm text-fg">Drop MP3, M4A, WAV, FLAC, OGG, or AIFF</span>
          <span className="text-xs text-muted">or click to browse</span>
        </button>
      )}

      {state.status === "loading" && (
        <div className="flex min-h-52 flex-1 flex-col items-center justify-center gap-3 px-4">
          <AudioLines className="size-6 text-muted" />
          <p className="text-sm text-fg">Reading {state.fileName}</p>
          <p aria-live="polite" className="font-mono text-xs text-muted">
            {state.phase}
          </p>
          <div
            role="progressbar"
            aria-label={`Analyzing ${state.fileName}`}
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
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-fg">{state.analysis.fileName}</p>
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
              {playing ? (
                <Pause className="size-4" />
              ) : (
                <Play className="size-4 ml-0.5" />
              )}
            </Button>
            <audio
              ref={audioRef}
              src={state.analysis.objectUrl}
              data-slot={id}
              preload="auto"
              onEnded={() => setPlaying(false)}
              onPause={() => setPlaying(false)}
              onPlay={handlePlay}
              onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
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
          </div>
          <SeekBar
            label={label}
            position={position}
            duration={
              mediaDuration ?? state.analysis.durationSec
            }
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

          <SpectrogramCanvas analysis={state.analysis} />

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Stat
              label="Spectral ceiling"
              value={formatHz(state.analysis.cutoffHz)}
              emphasize
            />
            <Stat label="True class" value={QUALITY_LABEL[state.analysis.qualityClass]} />
            <Stat
              label="Container bitrate"
              value={formatKbps(state.analysis.containerKbps)}
            />
            <Stat
              label="Header bitrate"
              value={
                state.analysis.container.claimedKbps
                  ? `${formatKbps(state.analysis.container.claimedKbps)}${state.analysis.container.vbr ? " VBR" : ""}`
                  : "—"
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
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = "";
        }}
      />
    </section>
  );
}

function SeekBar({
  label,
  position,
  duration,
  onSeek,
}: {
  label: string;
  position: number;
  duration: number;
  onSeek: (t: number) => void;
}) {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const clamped = Math.max(0, Math.min(position, safeDuration));
  // While dragging, show the dragged value and only hit the media element
  // on commit — one seek per gesture instead of dozens per second (each
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
        {formatDuration(safeDuration)}
      </span>
    </div>
  );
}

function Stat({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div>
      <dt className="text-[11px] tracking-wide text-faint uppercase">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 font-mono text-xs tabular-nums",
          emphasize ? "text-fg" : "text-muted",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
