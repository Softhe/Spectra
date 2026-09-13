import { Trophy } from "lucide-react";
import { useEffect, useRef } from "react";
import { formatHz } from "@/lib/audio/format";
import type { Analysis, SlotId } from "@/lib/audio/types";
import { cn } from "@/lib/utils";

type Props = {
  a: Analysis | null;
  b: Analysis | null;
  winnerId?: SlotId | "tie" | null;
  className?: string;
};

function drawTrace(
  ctx: CanvasRenderingContext2D,
  meanDb: Float32Array,
  hzPerBin: number,
  color: string,
  w: number,
  h: number,
  maxHz: number,
  dbMin: number,
  dbMax: number,
) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  let started = false;
  const last = Math.min(meanDb.length - 1, Math.floor(maxHz / hzPerBin));
  for (let k = 1; k <= last; k++) {
    const hz = k * hzPerBin;
    const x = (hz / maxHz) * w;
    const db = meanDb[k]!;
    const y = h - ((db - dbMin) / (dbMax - dbMin)) * h;
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

export function SpectrumPlot({ a, b, winnerId, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function paint() {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w < 8 || h < 8) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const maxHz = Math.max(a?.spectrogram.maxHz ?? 0, b?.spectrogram.maxHz ?? 0, 22050);
      const dbMin = -90;
      const dbMax = -10;

      ctx.strokeStyle = "rgba(232,234,238,0.08)";
      ctx.lineWidth = 1;
      for (const kHz of [5, 10, 15, 20]) {
        const x = ((kHz * 1000) / maxHz) * w;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (const db of [-30, -50, -70]) {
        const y = h - ((db - dbMin) / (dbMax - dbMin)) * h;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      const style = getComputedStyle(wrap);
      const colA = style.getPropertyValue("--color-trace-a").trim() || "#8fbfb4";
      const colB = style.getPropertyValue("--color-trace-b").trim() || "#c4b49a";

      if (a) drawTrace(ctx, a.meanDb, a.meanDbHzPerBin, colA, w, h, maxHz, dbMin, dbMax);
      if (b) drawTrace(ctx, b.meanDb, b.meanDbHzPerBin, colB, w, h, maxHz, dbMin, dbMax);

      const mark = (hz: number, color: string) => {
        const x = (hz / maxHz) * w;
        ctx.strokeStyle = color;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.setLineDash([]);
      };
      if (a) mark(a.cutoffHz, colA);
      if (b) mark(b.cutoffHz, colB);
    }

    paint();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => paint());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [a, b, winnerId]);

  if (!a && !b) return null;

  return (
    <div className={cn("rounded-lg bg-bg-elevated p-4 sm:p-5", className)}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-fg">Average spectrum</h2>
          <p className="mt-0.5 text-xs text-muted">
            Energy versus frequency. A cliff is the encoder throwing highs away.
          </p>
        </div>
        <div className="flex gap-4 font-mono text-[11px]">
          {a && (
            <span className="flex items-center gap-1.5 text-trace-a">
              {winnerId === "a" && <Trophy className="size-3 text-win" />}
              <span className="inline-block size-2 rounded-full bg-trace-a" />A · {formatHz(a.cutoffHz)}
            </span>
          )}
          {b && (
            <span className="flex items-center gap-1.5 text-trace-b">
              {winnerId === "b" && <Trophy className="size-3 text-win" />}
              <span className="inline-block size-2 rounded-full bg-trace-b" />B · {formatHz(b.cutoffHz)}
            </span>
          )}
        </div>
      </div>
      <div ref={wrapRef} className="h-40 w-full sm:h-48">
        <canvas ref={canvasRef} className="block size-full" />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[11px] text-faint">
        <span>0</span>
        <span>10 kHz</span>
        <span>20 kHz</span>
      </div>
    </div>
  );
}
