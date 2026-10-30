import { Headphones } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SLOT_LABELS } from "@/components/file-slot";
import { pairComparison } from "@/lib/audio/rank";
import type { Ranking } from "@/lib/audio/rank";
import type { Refinement } from "@/lib/audio/refine";
import { formatHz } from "@/lib/audio/format";
import type { Analysis, SlotId } from "@/lib/audio/types";
import { cn } from "@/lib/utils";

/** Trace classes stay full literals so Tailwind keeps them. */
const TRACE_CLASS: Record<SlotId, string> = {
  a: "text-trace-a",
  b: "text-trace-b",
  c: "text-trace-c",
  d: "text-trace-d",
};

/**
 * Round-robin ranking of the loaded files (up to four). Rows are ordered by
 * head-to-head points; the same compareAnalyses verdict rules behind the
 * headline verdict decide every pair, so the table can never contradict a
 * pairwise call. "Ear" chips start a matched-loudness A/B round for the pair.
 */
export function Leaderboard({
  ranking,
  filesById,
  slotOfId,
  focusPair,
  refinement,
  onPairStart,
  onPairFocus,
}: {
  ranking: Ranking;
  /** analysis id → analysis (refined values patched in) for display fields. */
  filesById: Record<string, Analysis>;
  slotOfId: Record<string, SlotId | undefined>;
  focusPair: [string, string] | null;
  /** Present when the copies were re-measured over their shared passages. */
  refinement: Refinement | null;
  onPairStart: (idA: string, idB: string) => void;
  onPairFocus: (idA: string, idB: string) => void;
}) {
  const rows = ranking.order
    .map((fid) => ({ fid, analysis: filesById[fid] }))
    .filter((r) => r.analysis);
  const rankedCount = rows.filter((r) => !ranking.outsiders.has(r.fid)).length;
  const pairs: [string, string][] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      pairs.push([rows[i]!.fid, rows[j]!.fid]);
    }
  }

  return (
    <section className="rounded-xl bg-bg-elevated p-4 sm:p-5" aria-label="Head-to-head ranking">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-fg">Leaderboard</h2>
          <p className="mt-0.5 text-xs text-muted">
            Every pair judged with the same rules as the headline verdict — win +1 point, tie +½.
            {refinement
              ? " Numbers come from the passages every copy shares."
              : " Bandwidth margins decide close calls."}
          </p>
        </div>
      </div>
      <ol className="mt-4 flex flex-col">
        {rows.map((row, rank) => {
          const slot = slotOfId[row.fid];
          const points = ranking.pointsById[row.fid] ?? 0;
          const wins = rows
            .filter((other) => other.fid !== row.fid && !ranking.outsiders.has(other.fid))
            .map((other) => pairComparison(ranking, row.fid, other.fid))
            .filter((c) => c && c.winner === "a").length;
          return (
            <li
              key={row.fid}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 py-3 last:border-b-0"
            >
              <span className="w-6 font-mono text-sm text-faint tabular-nums">
                {ranking.outsiders.has(row.fid) ? "—" : `${rank + 1}.`}
              </span>
              {slot && (
                <span
                  className={cn("font-mono text-xs tracking-widest uppercase", TRACE_CLASS[slot])}
                >
                  {SLOT_LABELS[slot]}
                </span>
              )}
              <span
                className="min-w-0 flex-1 truncate text-sm text-fg"
                title={row.analysis.fileName}
              >
                {row.analysis.fileName}
              </span>
              {ranking.outsiders.has(row.fid) ? (
                <span
                  className="font-mono text-xs text-warn"
                  title="No eligible comparison with matching identity and shared measurements is available"
                >
                  comparison unavailable · unranked
                </span>
              ) : (
                <>
                  <span
                    className="font-mono text-xs text-muted tabular-nums"
                    title="Head-to-head points"
                  >
                    {points.toFixed(1).replace(".0", "")} pt
                  </span>
                  <span
                    className="font-mono text-xs text-faint tabular-nums"
                    title="Pairs won outright"
                  >
                    {wins}/{rankedCount - 1} wins
                  </span>
                </>
              )}
              <span className="font-mono text-xs text-fg tabular-nums">
                {row.analysis.score.toFixed(0)}
              </span>
              <span className="font-mono text-xs text-muted tabular-nums">
                {formatHz(row.analysis.cutoffHz)}
              </span>
              {slot && (
                <Button
                  variant={focusPair && focusPair[0] === row.fid ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    // The leader faces the runner-up; everyone else faces the leader.
                    const other = rank === 0 ? rows[1] : rows[0];
                    if (other) onPairFocus(row.fid, other.fid);
                  }}
                  aria-label={
                    rank === 0
                      ? `Compare ${SLOT_LABELS[slot]} against the runner-up`
                      : `Compare ${SLOT_LABELS[slot]} against the leader`
                  }
                >
                  Focus
                </Button>
              )}
            </li>
          );
        })}
      </ol>
      {pairs.length > 1 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-widest text-faint">Ear ·</span>
          {pairs.map(([x, y]) => {
            const sx = slotOfId[x];
            const sy = slotOfId[y];
            const lx = sx ? SLOT_LABELS[sx].replace("File ", "") : "?";
            const ly = sy ? SLOT_LABELS[sy].replace("File ", "") : "?";
            const focused =
              focusPair &&
              ((focusPair[0] === x && focusPair[1] === y) ||
                (focusPair[0] === y && focusPair[1] === x));
            return (
              <Button
                key={`${x}|${y}`}
                variant={focused ? "default" : "outline"}
                size="sm"
                onClick={() => onPairStart(x, y)}
                aria-label="Start a matched-loudness A/B preview of this pair"
              >
                <Headphones className="size-3.5" />
                {lx}⇄{ly}
              </Button>
            );
          })}
        </div>
      )}
    </section>
  );
}
