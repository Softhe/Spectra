import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { buildLut, DB_MAX, DB_MIN } from "@/lib/audio/colormap";
import { formatHz } from "@/lib/audio/format";
import type { Analysis } from "@/lib/audio/types";
import { cn } from "@/lib/utils";

const lut = buildLut();

type Props = {
  analysis: Analysis;
  className?: string;
};

export function SpectrogramCanvas({ analysis, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hoverRaf = useRef(0);
  const [hover, setHover] = useState<{ hz: number; y: number } | null>(null);

  useEffect(() => () => cancelAnimationFrame(hoverRaf.current), []);

  // Render the spectrum once at native cell resolution (frames × bins).
  // Previously every mount AND every resize ran a per-device-pixel JS loop
  // (~0.5M LUT lookups); resize is now a single GPU drawImage.
  const spectrumImage = useMemo(() => {
    const { spectrogram } = analysis;
    const { frames, nFrames, nBins } = spectrogram;
    const off = document.createElement("canvas");
    off.width = Math.max(1, nFrames);
    off.height = Math.max(1, nBins);
    const ctx = off.getContext("2d");
    if (!ctx) return off;
    const img = ctx.createImageData(off.width, off.height);
    const data = img.data;
    const span = DB_MAX - DB_MIN;
    for (let y = 0; y < off.height; y++) {
      // Canvas row 0 is the top = highest frequency.
      const bin = nBins - 1 - y;
      for (let x = 0; x < off.width; x++) {
        const frame = Math.min(nFrames - 1, x);
        const db = frames[frame * nBins + bin] ?? DB_MIN;
        const u = Math.max(0, Math.min(255, Math.round(((db - DB_MIN) / span) * 255)));
        const o = (y * off.width + x) * 4;
        data[o] = lut[u * 4]!;
        data[o + 1] = lut[u * 4 + 1]!;
        data[o + 2] = lut[u * 4 + 2]!;
        data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return off;
  }, [analysis]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const cssW = wrap.clientWidth;
    const cssH = wrap.clientHeight;
    if (cssW < 8 || cssH < 8) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.floor(cssW * dpr);
    const h = Math.floor(cssH * dpr);
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(spectrumImage, 0, 0, w, h);

    const { cutoffHz, nyquistHz } = analysis;
    const { maxHz } = analysis.spectrogram;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cutY = (1 - cutoffHz / maxHz) * cssH;
    ctx.strokeStyle = "rgba(232, 234, 238, 0.85)";
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cutY);
    ctx.lineTo(cssW, cutY);
    ctx.stroke();

    if (nyquistHz < maxHz - 200) {
      const ny = (1 - nyquistHz / maxHz) * cssH;
      ctx.strokeStyle = "rgba(232, 234, 238, 0.25)";
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(0, ny);
      ctx.lineTo(cssW, ny);
      ctx.stroke();
    }
  }, [analysis, spectrumImage]);

  useEffect(() => {
    draw();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [draw]);

  function onPointer(e: PointerEvent<HTMLDivElement>) {
    // Pointermove fires faster than React can usefully re-render; coalesce
    // to one update per frame.
    const clientY = e.clientY;
    cancelAnimationFrame(hoverRaf.current);
    hoverRaf.current = requestAnimationFrame(() => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const t = 1 - (clientY - rect.top) / rect.height;
      setHover({
        hz: Math.max(0, Math.min(analysis.spectrogram.maxHz, t * analysis.spectrogram.maxHz)),
        y: clientY - rect.top,
      });
    });
  }

  const ticks = [0, 5, 10, 15, 20].filter(
    (k) => k * 1000 <= analysis.spectrogram.maxHz + 50,
  );

  return (
    <div className={cn("flex gap-2", className)}>
      <div className="relative min-w-0 flex-1">
        <div
          ref={wrapRef}
          className="relative h-48 w-full overflow-hidden rounded-md bg-bg-inset sm:h-64"
          onPointerMove={onPointer}
          onPointerEnter={onPointer}
          onPointerLeave={() => setHover(null)}
        >
          <canvas
            ref={canvasRef}
            className="block size-full"
            aria-label={`Spectrogram of ${analysis.fileName}, ceiling ${formatHz(analysis.cutoffHz)}`}
          />
          {hover && (
            <div
              className="pointer-events-none absolute inset-x-0 h-px bg-fg/70"
              style={{ top: hover.y }}
            />
          )}
        </div>
        <div className="mt-1.5 flex justify-between font-mono text-[11px] text-faint">
          <span>{analysis.spectrogram.excerptStartSec.toFixed(1)}s</span>
          <span>excerpt</span>
          <span>
            {(
              analysis.spectrogram.excerptStartSec + analysis.spectrogram.durationSec
            ).toFixed(1)}
            s
          </span>
        </div>
      </div>
      <div className="relative w-10 shrink-0 sm:w-12">
        <div className="relative h-48 sm:h-64">
          {ticks
            .filter((k) => Math.abs(k * 1000 - analysis.cutoffHz) > 1800)
            .map((k) => {
            const hz = k * 1000;
            const t = hz / analysis.spectrogram.maxHz;
            return (
              <span
                key={k}
                className="absolute right-0 -translate-y-1/2 font-mono text-[10px] text-faint"
                style={{ top: `${(1 - t) * 100}%` }}
              >
                {k === 0 ? "0" : `${k}k`}
              </span>
            );
          })}
          <span
            className="absolute right-0 -translate-y-1/2 font-mono text-[10px] text-fg"
            style={{
              top: `${Math.min(94, Math.max(6, (1 - analysis.cutoffHz / analysis.spectrogram.maxHz) * 100))}%`,
            }}
          >
            {formatHz(analysis.cutoffHz).replace(" kHz", "k")}
          </span>
        </div>
        {hover && (
          <div className="mt-1 font-mono text-[11px] text-fg tabular-nums">
            {formatHz(hover.hz)}
          </div>
        )}
      </div>
    </div>
  );
}
