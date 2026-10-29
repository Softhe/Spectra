import {
  ArrowRightLeft,
  Check,
  Copy,
  Info,
  Play,
  Repeat,
  Trophy,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import * as Slider from "@radix-ui/react-slider";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SLOT_LABELS } from "@/components/file-slot";
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
  const decided = comparison.winner !== "tie";
  const winnerSlot = comparison.winner === "a" ? slotA : slotB;
  const tone = decided
    ? "bg-bg-elevated shadow-[0_0_0_1.5px_var(--color-win),0_0_60px_-16px_var(--color-win)]"
    : "bg-bg-elevated";
  const next = abPlaying === slotA ? slotB : abPlaying === slotB ? slotA : slotB;

  return (
    <aside aria-live="polite" className={cn("rounded-xl px-5 py-4 sm:px-6 sm:py-5", tone)}>
      <p className="flex items-center gap-1.5 font-mono text-[11px] tracking-widest text-muted uppercase">
        {decided && <Trophy className="size-3.5 text-win" />}
        {decided
          ? `Preferred · ${SLOT_LABELS[winnerSlot]} · ${comparison.confidence} evidence`
          : comparison.outcome === "not-comparable"
            ? "Not reliably comparable"
            : "No quality preference"}
      </p>
      <h2 className="mt-1 text-xl font-medium tracking-tight text-fg sm:text-2xl">
        {comparison.headline}
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">{comparison.detail}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          variant="default"
          onClick={() => onAbSwitch(next)}
          className="shadow-[0_0_24px_-6px_var(--color-accent)] hover:shadow-[0_0_32px_-4px_var(--color-accent)]"
          aria-label={
            abPlaying
              ? `Now previewing the slot at the playhead — switch to the other copy at the same position`
              : "Preview A and B back to back at matched loudness"
          }
        >
          {abPlaying ? <ArrowRightLeft className="size-4" /> : <Play className="size-4 ml-0.5" />}
          {abPlaying ? "Switch now" : "A/B compare by ear"}
        </Button>
        <Button
          variant={loopOn ? "default" : "outline"}
          size="sm"
          onClick={onToggleLoop}
          aria-pressed={loopOn}
        >
          <Repeat className="size-4" />
          {loopOn ? "5 s loop on" : "5 s loop"}
        </Button>
        <Button variant="outline" size="sm" onClick={onSwap}>
          <ArrowRightLeft className="size-4" />
          Swap A/B
        </Button>
        <span className="text-xs text-faint">
          Same position, matched loudness — or press{" "}
          <kbd className="rounded border border-border bg-bg-subtle px-1 py-px font-mono text-[10px] text-muted">
            {slotA.toUpperCase()}
          </kbd>
          /
          <kbd className="rounded border border-border bg-bg-subtle px-1 py-px font-mono text-[10px] text-muted">
            {slotB.toUpperCase()}
          </kbd>{" "}
          to switch
        </span>
        <VolumeControl volume={volume} onVolumeChange={onVolumeChange} />
        <CopyReport comparison={comparison} a={a} b={b} slotA={slotA} slotB={slotB} />
      </div>
      <p className="mt-3 text-xs text-muted">
        Recording match: {comparison.identityStatus}. Evidence: {comparison.confidence}, not a
        probability.
        {comparison.coverage?.status === "shared" && (
          <>
            {" "}
            Compared {comparison.coverage.windows} shared passages,{" "}
            {comparison.coverage.measuredSec?.toFixed(0)} s measured within{" "}
            {comparison.coverage.overlapSec?.toFixed(0)} s overlap.
          </>
        )}
      </p>
      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-muted">Technical score details</summary>
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

function CopyReport({
  comparison,
  a,
  b,
  slotA,
  slotB,
}: {
  comparison: Comparison;
  a: Analysis;
  b: Analysis;
  slotA: SlotId;
  slotB: SlotId;
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
        `  header bitrate: ${x.container.claimedKbps ? `${x.container.claimedKbps} kbps${x.container.vbr ? " VBR" : ""}` : "unknown"}`,
      ].join("\n");
    const text = [
      `Spectra comparison — ${comparison.headline} (${comparison.confidence} evidence; recording match: ${comparison.identityStatus})`,
      comparison.detail,
      comparison.coverage?.status === "shared"
        ? `Coverage: ${comparison.coverage.windows} windows; ${comparison.coverage.measuredSec?.toFixed(1)} s measured; ${comparison.coverage.overlapSec?.toFixed(1)} s overlap.`
        : "Shared measurement: unavailable.",
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
  // NOTE: classes must stay full literals — Tailwind cannot see interpolated
  // opacity suffixes and would purge them.
  const segClass: Record<"win" | "muted", string[]> = {
    win: ["bg-win/90", "bg-win/60", "bg-win/35", "bg-win/20"],
    muted: ["bg-muted/70", "bg-muted/50", "bg-muted/30", "bg-muted/20"],
  };
  const segments = [
    { key: "ceiling", label: "Bandwidth ceiling", pts: parts.ceiling },
    { key: "rolloff", label: "Rolloff shape", pts: parts.rolloff },
    { key: "air", label: "High-frequency air", pts: parts.air },
    { key: "clarity", label: "Spectral cleanliness", pts: parts.clarity },
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
        aria-label={`${label} experimental score ${score.toFixed(0)} out of 100: ceiling ${parts.ceiling.toFixed(0)}, rolloff ${parts.rolloff.toFixed(0)}, air ${parts.air.toFixed(0)}, clarity ${parts.clarity.toFixed(0)}${parts.clip < 0 ? `, clipping ${parts.clip.toFixed(0)}` : ""}`}
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
          A composite score out of 100 based on bandwidth, rolloff, high-frequency content, and
          spectral cleanliness. It describes the encoding evidence, not the musical performance.
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
                  Broadband hiss reads like a starved encode, so the score is held at 35 or below
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
      <table className="w-full table-fixed text-left text-xs">
        <caption className="sr-only">Audio comparison measurements for both files</caption>
        <thead className="border-b border-border font-mono tracking-widest text-faint uppercase">
          <tr>
            <th scope="col" className="w-[38%] px-4 py-3 font-normal sm:px-5">
              Metric
            </th>
            <th scope="col" className={cn("py-3 font-normal", winner === "a" && "text-win")}>
              {headA}{" "}
              {winner === "a" && <Trophy aria-label="Preferred copy" className="inline size-3" />}
            </th>
            <th scope="col" className={cn("py-3 pr-4 font-normal", winner === "b" && "text-win")}>
              {headB}{" "}
              {winner === "b" && <Trophy aria-label="Preferred copy" className="inline size-3" />}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b border-border/70 last:border-b-0">
              <th scope="row" className="px-4 py-3 font-normal text-muted sm:px-5">
                {row.label}
              </th>
              <td
                className={cn(
                  "py-3 pr-2 font-mono tabular-nums",
                  row.better === "a" ? "text-fg" : "text-muted",
                )}
              >
                {row.av}
              </td>
              <td
                className={cn(
                  "py-3 pr-4 font-mono tabular-nums",
                  row.better === "b" ? "text-fg" : "text-muted",
                )}
              >
                {row.bv}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function bitDepthRow(x: Analysis): string {
  const bits = x.container.bitDepth;
  const eff = x.effectiveBits;
  if (bits == null) return "—";
  if (typeof eff === "number" && eff < bits) return `${eff}-bit of ${bits}`;
  return `${bits}-bit`;
}

export function HowTo() {
  return (
    <section className="rounded-xl bg-bg-elevated p-5 sm:p-6">
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
          <p className="font-medium text-fg">Look for the black band</p>
          <p className="mt-1">
            Brightness represents energy. A sharp cutoff can reflect filtering or encoding. It
            cannot establish the original bitrate.
          </p>
        </li>
        <li>
          <p className="font-medium text-fg">Interpret the evidence</p>
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
