import {
  ArrowRightLeft,
  Check,
  CircleHelp,
  Copy,
  Info,
  Play,
  Repeat,
  Scale,
  TriangleAlert,
  Trophy,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import * as Slider from "@radix-ui/react-slider";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AudioEquivalence } from "@/components/audio-equivalence";
import type { EquivalenceResult } from "@/lib/audio/equivalence";
import {
  bitrateDescription,
  coverageDescription,
  preferenceDescription,
} from "@/lib/audio/presentation";
import { SLOT_LABELS, SlotBadge } from "@/components/file-slot";
import { QUALITY_LABEL, ROLLOFF_LABEL } from "@/lib/audio/analyze";
import {
  channelLabel,
  formatBytes,
  formatDuration,
  formatHz,
  formatSampleRate,
} from "@/lib/audio/format";
import type { Analysis, Comparison, ScoreParts, SlotId } from "@/lib/audio/types";
import { cn } from "@/lib/utils";

/** The head-to-head verdict panel: headline, ear controls, pair score bars. */
export function Verdict({
  comparison,
  a,
  b,
  fileA,
  fileB,
  analysisBusy,
  slotA,
  slotB,
  abPlaying,
  loopOn,
  onAbSwitch,
  onToggleLoop,
  onSwap,
  volume,
  onVolumeChange,
}: {
  comparison: Comparison;
  a: Analysis;
  b: Analysis;
  fileA?: File;
  fileB?: File;
  analysisBusy: boolean;
  slotA: SlotId;
  slotB: SlotId;
  abPlaying: SlotId | null;
  loopOn: boolean;
  onAbSwitch: (target: SlotId) => void;
  onToggleLoop: () => void;
  onSwap: () => void;
  volume: number;
  onVolumeChange: (v: number) => void;
}) {
  const [equivalence, setEquivalence] = useState<EquivalenceResult | null>(null);
  const decided = comparison.winner !== "tie";
  const winnerSlot = comparison.winner === "a" ? slotA : slotB;
  const notComparable = comparison.outcome === "not-comparable";
  const tone = decided
    ? "shadow-[0_0_0_1.5px_var(--color-win),0_0_60px_-16px_var(--color-win)]"
    : notComparable
      ? "shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-warn)_45%,transparent)]"
      : "shadow-[var(--shadow-border)]";
  const StatusIcon = decided ? Trophy : notComparable ? TriangleAlert : Scale;
  const statusClass = decided
    ? "bg-win/15 text-win"
    : notComparable
      ? "bg-warn/15 text-warn"
      : "bg-info/15 text-info";

  return (
    <aside
      aria-live="polite"
      className={cn("relative overflow-hidden rounded-xl bg-bg-elevated px-5 py-5 sm:px-6", tone)}
    >
      {decided && (
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 -right-16 size-72 rounded-full bg-win/10 blur-3xl"
        />
      )}
      <div className="relative grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-8">
        <div className="min-w-0">
          <p
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[11px] tracking-widest uppercase",
              statusClass,
            )}
          >
            <StatusIcon className="size-3.5" />
            {decided
              ? `Preferred · ${SLOT_LABELS[winnerSlot]} · ${comparison.confidence} evidence`
              : notComparable
                ? "Not reliably comparable"
                : "No quality preference"}
          </p>
          <h2 className="mt-3 text-xl font-medium tracking-tight text-fg sm:text-2xl">
            {comparison.headline}
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">{comparison.detail}</p>
        </div>
        <EvidenceStrip
          a={a}
          b={b}
          slotA={slotA}
          slotB={slotB}
          winner={comparison.winner === "a" || comparison.winner === "b" ? comparison.winner : null}
        />
      </div>

      <div className="relative mt-5 flex flex-wrap items-center gap-2 rounded-lg bg-bg-inset p-2 shadow-[var(--shadow-border)]">
        <div
          role="group"
          aria-label="Listen to one copy at the aligned position"
          className="flex rounded-md bg-bg-subtle p-0.5"
        >
          {[slotA, slotB].map((slot) => {
            const active = abPlaying === slot;
            return (
              <button
                key={slot}
                type="button"
                // Re-selecting the playing copy must not restart it (with the
                // loop on, abSwitch would seek back to the window start). Same
                // guard as the keyboard path.
                onClick={() => {
                  if (!active) onAbSwitch(slot);
                }}
                aria-pressed={active}
                aria-label={
                  active
                    ? `Now playing ${SLOT_LABELS[slot]}`
                    : abPlaying
                      ? `Switch to ${SLOT_LABELS[slot]} at the same position`
                      : `Play ${SLOT_LABELS[slot]} at matched loudness`
                }
                className={cn(
                  "inline-flex h-9 items-center gap-2 rounded-[6px] px-3 text-sm font-medium transition-[background-color,color,box-shadow] duration-150",
                  active
                    ? "bg-accent text-accent-fg shadow-[0_0_20px_-6px_var(--color-accent)]"
                    : "text-muted hover:bg-bg-elevated hover:text-fg",
                )}
              >
                {active ? (
                  <PlayingBars />
                ) : abPlaying ? (
                  <ArrowRightLeft className="size-3.5" />
                ) : (
                  <Play className="size-3.5" />
                )}
                {SLOT_LABELS[slot]}
              </button>
            );
          })}
        </div>
        <Button
          variant={loopOn ? "default" : "ghost"}
          size="sm"
          onClick={onToggleLoop}
          aria-pressed={loopOn}
        >
          <Repeat className="size-4" />
          {loopOn ? "5 s loop on" : "5 s loop"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onSwap}>
          <ArrowRightLeft className="size-4" />
          Swap {slotA.toUpperCase()}/{slotB.toUpperCase()}
        </Button>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <VolumeControl volume={volume} onVolumeChange={onVolumeChange} />
          <CopyReport
            comparison={comparison}
            a={a}
            b={b}
            slotA={slotA}
            slotB={slotB}
            equivalence={equivalence}
          />
        </div>
      </div>
      <p className="relative mt-2 text-xs text-faint">
        Aligned position and matched RMS level. Press{" "}
        <kbd className="rounded border border-border bg-bg-subtle px-1 py-px font-mono text-[10px] text-muted">
          {slotA.toUpperCase()}
        </kbd>
        /
        <kbd className="rounded border border-border bg-bg-subtle px-1 py-px font-mono text-[10px] text-muted">
          {slotB.toUpperCase()}
        </kbd>{" "}
        to switch.
      </p>

      <ul className="relative mt-4 flex flex-col gap-1.5 text-xs text-muted">
        <li className="flex gap-2">
          <CircleHelp className="mt-px size-3.5 shrink-0 text-faint" aria-hidden />
          <span>
            Recording match: <span className="text-fg">{comparison.identityStatus}</span>.{" "}
            {preferenceDescription(comparison)}
          </span>
        </li>
        <li className="flex gap-2">
          <Info className="mt-px size-3.5 shrink-0 text-faint" aria-hidden />
          <span>{coverageDescription(comparison.coverage)}</span>
        </li>
      </ul>
      {(/FLAC|ALAC/.test(a.container.codec) || /FLAC|ALAC/.test(b.container.codec)) && (
        <p className="mt-2 text-xs text-muted">
          FLAC and ALAC use lossless compression. A smaller file does not imply lower audio quality.
          The format alone does not prove the source's history.
        </p>
      )}
      {fileA && fileB && (
        <AudioEquivalence a={fileA} b={fileB} disabled={analysisBusy} onResult={setEquivalence} />
      )}
      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-muted hover:text-fg">
          Technical score details
        </summary>
        <p className="mt-2 text-xs text-muted">
          Experimental heuristic scores are not percentages of retained fidelity.
        </p>
        <div className="mt-3 grid max-w-3xl gap-3 sm:grid-cols-2">
          <ScoreBar
            label={SLOT_LABELS[slotA]}
            score={a.score}
            parts={a.scoreParts}
            cutoffHz={a.cutoffHz}
            highlighted={comparison.winner === "a"}
            dimmed={decided && comparison.winner !== "a"}
          />
          <ScoreBar
            label={SLOT_LABELS[slotB]}
            score={b.score}
            parts={b.scoreParts}
            cutoffHz={b.cutoffHz}
            highlighted={comparison.winner === "b"}
            dimmed={decided && comparison.winner !== "b"}
          />
        </div>
      </details>
    </aside>
  );
}

/** Three bouncing bars: "this one is playing" without another icon. */
function PlayingBars() {
  return (
    <span aria-hidden className="flex h-3.5 items-end gap-[2px]">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-[3px] origin-bottom rounded-full bg-current motion-safe:animate-[spectra-eq_0.9s_ease-in-out_infinite]"
          style={{ height: "100%", animationDelay: `${i * -0.3}s` }}
        />
      ))}
    </span>
  );
}

/**
 * Measured bandwidth for the pair as two bars on one shared scale. These are
 * measurements, shown for every outcome; only a decided comparison marks a
 * preferred copy.
 */
function EvidenceStrip({
  a,
  b,
  slotA,
  slotB,
  winner,
}: {
  a: Analysis;
  b: Analysis;
  slotA: SlotId;
  slotB: SlotId;
  winner: "a" | "b" | null;
}) {
  const scaleHz = Math.max(22050, a.nyquistHz, b.nyquistHz);
  const rows = [
    { side: "a" as const, slot: slotA, x: a },
    { side: "b" as const, slot: slotB, x: b },
  ];
  const deltaHz = Math.abs(a.cutoffHz - b.cutoffHz);
  return (
    <div className="rounded-lg bg-bg-inset p-4 shadow-[var(--shadow-border)]">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-mono text-[11px] tracking-widest text-faint uppercase">
          Measured bandwidth
        </p>
        {deltaHz >= 400 && (
          <p className="font-mono text-[11px] text-muted tabular-nums">Δ {formatHz(deltaHz)}</p>
        )}
      </div>
      <dl className="mt-3 flex flex-col gap-3">
        {rows.map(({ side, slot, x }) => {
          const pct = Math.max(2, Math.min(100, (x.cutoffHz / scaleHz) * 100));
          const isWinner = winner === side;
          return (
            <div key={side}>
              <div className="flex items-center justify-between gap-2">
                <dt className="flex min-w-0 items-center gap-2 text-xs text-muted">
                  <SlotBadge slot={slot} className="size-5 text-[11px]" />
                  <span className="sr-only">{SLOT_LABELS[slot]}: </span>
                  <span className="truncate" title={x.fileName}>
                    {x.fileName}
                  </span>
                </dt>
                <dd
                  className={cn(
                    "flex shrink-0 items-center gap-1 font-mono text-sm tabular-nums",
                    isWinner ? "text-win" : "text-fg",
                  )}
                >
                  {isWinner && <Trophy className="size-3.5" aria-label="Preferred copy" />}
                  {formatHz(x.cutoffHz)}
                </dd>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bg-subtle" aria-hidden>
                <div
                  className={cn(
                    "h-full rounded-full",
                    slot === "a"
                      ? "bg-trace-a"
                      : slot === "b"
                        ? "bg-trace-b"
                        : slot === "c"
                          ? "bg-trace-c"
                          : "bg-trace-d",
                    winner && !isWinner && "opacity-60",
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </dl>
      <div className="mt-2 flex justify-between font-mono text-[10px] text-faint" aria-hidden>
        <span>0</span>
        <span>Scale {formatHz(scaleHz)}</span>
      </div>
    </div>
  );
}

function CopyReport({
  comparison,
  a,
  b,
  slotA,
  slotB,
  equivalence,
}: {
  comparison: Comparison;
  a: Analysis;
  b: Analysis;
  slotA: SlotId;
  slotB: SlotId;
  equivalence: EquivalenceResult | null;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    const fileLine = (slot: string, x: Analysis) =>
      [
        `File ${slot}: ${x.fileName}`,
        `  container: ${x.container.codec}, ${formatBytes(x.fileSize)}, ${formatDuration(x.durationSec)}, ${formatSampleRate(x.sampleRate)} ${channelLabel(x.channels)}`,
        `  measured: ceiling ${formatHz(x.cutoffHz)} (${ROLLOFF_LABEL[x.rolloff]}), ${QUALITY_LABEL[x.qualityClass]}, experimental score ${x.score.toFixed(0)}/100`,
        `  ${bitrateDescription(x).label}: ${bitrateDescription(x).value}`,
      ].join("\n");
    const text = [
      `Spectra comparison: ${comparison.headline}`,
      `Recording match: ${comparison.identityStatus}. ${preferenceDescription(comparison)}`,
      comparison.detail,
      coverageDescription(comparison.coverage),
      equivalence
        ? `Complete audio check: ${equivalence.status}. ${equivalence.detail} Frames checked per channel: ${equivalence.framesCompared}.`
        : "Complete audio check: not run.",
      "",
      fileLine(slotA.toUpperCase(), a),
      fileLine(slotB.toUpperCase(), b),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API unavailable (permissions, insecure context): fallback.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        // Give up silently; the button just won't confirm.
        document.body.removeChild(ta);
        return;
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void copy()}
      aria-label="Copy comparison report to clipboard"
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {copied ? "Copied" : "Copy report"}
    </Button>
  );
}

export function VolumeControl({
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

export function ScoreBar({
  label,
  score,
  parts,
  cutoffHz,
  highlighted,
  dimmed,
}: {
  label: string;
  score: number;
  parts: ScoreParts;
  cutoffHz: number;
  highlighted: boolean;
  dimmed: boolean;
}) {
  // Segments explain the total: bandwidth ceiling, rolloff shape, high-frequency
  // air, spectral cleanliness. Widths are points of the 0–100 scale.
  // NOTE: classes must stay full literals. Tailwind cannot see interpolated
  // opacity suffixes and would purge them.
  const segClass: Record<"win" | "muted", string[]> = {
    win: ["bg-win/90", "bg-win/60", "bg-win/35", "bg-win/20"],
    muted: ["bg-muted/70", "bg-muted/50", "bg-muted/30", "bg-muted/20"],
  };
  const segments = [
    { key: "ceiling", label: "Bandwidth ceiling", pts: parts.ceiling },
    { key: "rolloff", label: "Rolloff shape", pts: parts.rolloff },
    { key: "air", label: "High-frequency energy", pts: parts.air },
    { key: "clarity", label: "Spectral shape", pts: parts.clarity },
  ] as const;
  const tone = highlighted ? "win" : "muted";
  // scoreOf can cap the total (noise-starved encodes) and docks clipping, so
  // the parts may not add up to the score. Scale the bar to the real score
  // and list the difference explicitly in the breakdown.
  const positiveSum = segments.reduce((sum, s) => sum + s.pts, 0);
  const barScale = positiveSum > score && positiveSum > 0 ? score / positiveSum : 1;
  const capPts = score - (positiveSum + parts.clip);
  const capped = capPts < -0.05;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-mono text-xs text-muted">
          {highlighted && <Trophy className="size-3 text-win" />}
          {label}
        </span>
        <span className="font-mono text-xs text-faint tabular-nums">
          {score.toFixed(0)}/100 · {formatHz(cutoffHz)}
          {parts.clip < 0 && (
            <span
              className="text-loss"
              title={`Sustained clipping docked ${parts.clip.toFixed(0)} points`}
            >
              {" "}
              ({parts.clip.toFixed(0)})
            </span>
          )}
        </span>
      </div>
      <div
        className={cn(
          "mt-1.5 flex h-1.5 gap-px overflow-hidden rounded-full bg-bg-subtle",
          dimmed && "opacity-60",
        )}
        role="img"
        aria-label={`${label} experimental score ${score.toFixed(0)} out of 100: ceiling ${parts.ceiling.toFixed(0)}, rolloff ${parts.rolloff.toFixed(0)}, high-frequency energy ${parts.air.toFixed(0)}, spectral shape ${parts.clarity.toFixed(0)}${parts.clip < 0 ? `, clipping ${parts.clip.toFixed(0)}` : ""}`}
      >
        {segments.map((s, i) =>
          s.pts > 0.05 ? (
            <div
              key={s.key}
              title={`${s.label}: ${s.pts.toFixed(1)} pts`}
              className={cn("h-full rounded-full", segClass[tone]![i])}
              style={{ width: `${Math.min(100, s.pts * barScale)}%` }}
            />
          ) : null,
        )}
      </div>
      <details className="mt-2 text-xs text-muted">
        <summary className="min-h-9 cursor-pointer py-2 text-fg focus-visible:outline-2 focus-visible:outline-accent">
          {label} score breakdown
        </summary>
        <p className="mb-2 leading-relaxed">
          This experimental score combines bandwidth, rolloff, high-frequency energy and clipping
          measurements. It does not measure listening quality or the percentage of audio preserved.
        </p>
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5">
          {segments.map((segment) => (
            <div key={segment.key} className="contents">
              <dt>{segment.label}</dt>
              <dd className="font-mono">{segment.pts.toFixed(1)} pts</dd>
            </div>
          ))}
          {parts.clip < 0 && (
            <>
              <dt>Sustained clipping deduction</dt>
              <dd className="font-mono text-loss">{parts.clip.toFixed(1)} pts</dd>
            </>
          )}
          {capped && (
            <>
              <dt>
                Noise cap
                <span className="block text-faint">
                  A noise-like spectrum limits this experimental score to 35. This does not prove
                  how the file was encoded.
                </span>
              </dt>
              <dd className="font-mono text-loss">{capPts.toFixed(1)} pts</dd>
            </>
          )}
          <dt className="border-t border-border pt-1.5 text-fg">Score</dt>
          <dd className="border-t border-border pt-1.5 font-mono text-fg">
            {score.toFixed(1)} / 100
          </dd>
        </dl>
      </details>
    </div>
  );
}

/** Clip fractions at or below this display as "None". */
const CLIP_SHOWN = 0.0003;

export function CompareTable({
  a,
  b,
  winner,
  slotA,
  slotB,
}: {
  a: Analysis;
  b: Analysis;
  winner: SlotId | "tie";
  slotA: SlotId;
  slotB: SlotId;
}) {
  const headA = SLOT_LABELS[slotA];
  const headB = SLOT_LABELS[slotB];
  const rows: { label: string; av: string; bv: string; better?: SlotId | "tie" }[] = [
    {
      label: "Preference",
      av: winner === "a" ? "Preferred" : winner === "tie" ? "No preference" : "Other copy",
      bv: winner === "b" ? "Preferred" : winner === "tie" ? "No preference" : "Other copy",
      better: winner,
    },
    {
      label: "Experimental score",
      av: `${a.score.toFixed(0)} / 100`,
      bv: `${b.score.toFixed(0)} / 100`,
      better: Math.abs(a.score - b.score) < 3 ? "tie" : a.score > b.score ? "a" : "b",
    },
    {
      label: "Estimated bandwidth",
      av: formatHz(a.cutoffHz),
      bv: formatHz(b.cutoffHz),
      better: Math.abs(a.cutoffHz - b.cutoffHz) < 400 ? "tie" : a.cutoffHz > b.cutoffHz ? "a" : "b",
    },
    {
      label: "File-size average, including metadata",
      av: `${Math.round(a.containerKbps)} kbps`,
      bv: `${Math.round(b.containerKbps)} kbps`,
    },
    {
      label: "Audio data rate",
      av: `${bitrateDescription(a).label}: ${bitrateDescription(a).value}`,
      bv: `${bitrateDescription(b).label}: ${bitrateDescription(b).value}`,
    },
    {
      label: "Bit depth",
      av: bitDepthRow(a),
      bv: bitDepthRow(b),
      better:
        typeof a.effectiveBits === "number" && typeof b.effectiveBits === "number"
          ? a.effectiveBits === b.effectiveBits
            ? "tie"
            : a.effectiveBits > b.effectiveBits
              ? "a"
              : "b"
          : undefined,
    },
    {
      label: "High-frequency occupancy",
      av: `${Math.round(a.hfOccupancy * 100)}%`,
      bv: `${Math.round(b.hfOccupancy * 100)}%`,
      better:
        Math.abs(a.hfOccupancy - b.hfOccupancy) < 0.04
          ? "tie"
          : a.hfOccupancy > b.hfOccupancy
            ? "a"
            : "b",
    },
    {
      label: "Crest factor",
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
      av: a.clipFraction > CLIP_SHOWN ? `${(a.clipFraction * 100).toFixed(2)}%` : "None",
      bv: b.clipFraction > CLIP_SHOWN ? `${(b.clipFraction * 100).toFixed(2)}%` : "None",
      // Two "None" cells are a tie, whatever the sub-threshold difference.
      better:
        (a.clipFraction <= CLIP_SHOWN && b.clipFraction <= CLIP_SHOWN) ||
        Math.abs(a.clipFraction - b.clipFraction) < 0.0002
          ? "tie"
          : a.clipFraction < b.clipFraction
            ? "a"
            : "b",
    },
  ];

  return (
    <div className="overflow-hidden rounded-xl bg-bg-elevated">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 pt-4 pb-3 sm:px-5">
        <h2 className="text-sm font-medium text-fg">Measurements</h2>
        <p className="flex items-center gap-1.5 text-xs text-faint">
          <span aria-hidden className="inline-block size-1.5 rounded-full bg-win" />
          marks the more favorable measurement, not a verdict on its own
        </p>
      </div>
      <table className="w-full table-fixed text-left text-xs">
        <caption className="sr-only">Audio comparison measurements for both files</caption>
        <thead className="border-b border-border font-mono tracking-widest text-faint uppercase">
          <tr>
            <th scope="col" className="w-[38%] px-4 py-3 font-normal sm:px-5">
              Metric
            </th>
            <th scope="col" className={cn("py-3 font-normal", winner === "a" && "text-win")}>
              <span className="inline-flex items-center gap-2">
                <SlotBadge slot={slotA} className="size-5 text-[11px]" />
                <span className="sr-only sm:not-sr-only">{headA}</span>
                {winner === "a" && <Trophy aria-label="Preferred copy" className="size-3" />}
              </span>
            </th>
            <th scope="col" className={cn("py-3 pr-4 font-normal", winner === "b" && "text-win")}>
              <span className="inline-flex items-center gap-2">
                <SlotBadge slot={slotB} className="size-5 text-[11px]" />
                <span className="sr-only sm:not-sr-only">{headB}</span>
                {winner === "b" && <Trophy aria-label="Preferred copy" className="size-3" />}
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.label}
              className="border-b border-border/70 transition-colors last:border-b-0 hover:bg-bg-inset/50"
            >
              <th scope="row" className="px-4 py-3 font-normal text-muted sm:px-5">
                {row.label}
              </th>
              <td
                className={cn(
                  "py-3 pr-2 font-mono tabular-nums",
                  row.better === "a" ? "text-fg" : "text-muted",
                )}
              >
                <BetterMark show={row.better === "a"} />
                {row.av}
              </td>
              <td
                className={cn(
                  "py-3 pr-4 font-mono tabular-nums",
                  row.better === "b" ? "text-fg" : "text-muted",
                )}
              >
                <BetterMark show={row.better === "b"} />
                {row.bv}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Small dot beside the more favorable measurement; text says it for screen readers. */
function BetterMark({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <>
      <span
        aria-hidden
        className="mr-1.5 inline-block size-1.5 -translate-y-px rounded-full bg-win align-middle"
      />
      <span className="sr-only">More favorable measurement: </span>
    </>
  );
}

function bitDepthRow(x: Analysis): string {
  const bits = x.container.bitDepth;
  const eff = x.effectiveBits;
  if (bits == null) return "Not available";
  if (typeof eff === "number" && eff < bits) return `${eff}-bit of ${bits}`;
  return `${bits}-bit`;
}

export function HowTo() {
  return (
    <section className="rounded-xl bg-bg-elevated p-5 shadow-[var(--shadow-border)] sm:p-6">
      <div className="flex items-center gap-2 text-fg">
        <Info />
        <h2 className="text-sm font-medium">How to read this</h2>
      </div>
      <ol className="mt-4 grid gap-4 text-sm leading-relaxed text-muted sm:grid-cols-3">
        <li>
          <p className="font-medium text-fg">Read metadata separately</p>
          <p className="mt-1">
            Codec and bitrate describe the file. A lossless container does not prove that the
            supplied source was lossless.
          </p>
        </li>
        <li>
          <p className="font-medium text-fg">Read the spectrum</p>
          <p className="mt-1">
            Brightness represents energy. A sharp cutoff can reflect filtering or encoding. It
            cannot establish the original bitrate.
          </p>
        </li>
        <li>
          <p className="font-medium text-fg">Know the limits</p>
          <p className="mt-1">
            Bandwidth is one clue. Noise and processing can add high-frequency energy. An
            inconclusive result does not establish equal fidelity.
          </p>
        </li>
      </ol>
      <p className="mt-5 text-xs text-faint">Files stay in this browser. Nothing is uploaded.</p>
    </section>
  );
}
