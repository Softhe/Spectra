import { Crosshair, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { buildLut, DB_MAX, DB_MIN } from "@/lib/audio/colormap";
import { formatHz } from "@/lib/audio/format";
import type { Analysis, SpectrogramData } from "@/lib/audio/types";
import { cn } from "@/lib/utils";

const lut = buildLut();

type Props = {
  analysis: Analysis;
  /**
   * A user-pinned excerpt scan (re-scan at the playhead). When present the
   * picture renders it instead of the file's default excerpt, and the time
   * axis follows its position/duration.
   */
  override?: SpectrogramData | null;
  /** Clears the pinned excerpt (button is only shown when one is pinned). */
  onResetOverride?: () => void;
  className?: string;
};

export function SpectrogramCanvas({ analysis, override, onResetOverride, className }: Props) {
  const data = override ?? analysis.spectrogram;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hoverRaf = useRef(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => () => cancelAnimationFrame(hoverRaf.current), []);

  // Render the spectrum once at native cell resolution (frames × bins).
  // Previously every mount AND every resize ran a per-device-pixel JS loop
  // (~0.5M LUT lookups); resize is now a single GPU drawImage.
  const spectrumImage = useMemo(() => {
    const { frames, nFrames, nBins } = data;
    const off = document.createElement("canvas");
    off.width = Math.max(1, nFrames);
    off.height = Math.max(1, nBins);
    const ctx = off.getContext("2d");
    if (!ctx) return off;
    const img = ctx.createImageData(off.width, off.height);
    const imgData = img.data;
    const span = DB_MAX - DB_MIN;
    for (let y = 0; y < off.height; y++) {
      // Canvas row 0 is the top = highest frequency.
      const bin = nBins - 1 - y;
      for (let x = 0; x < off.width; x++) {
        const frame = Math.min(nFrames - 1, x);
        const db = frames[frame * nBins + bin] ?? DB_MIN;
        const u = Math.max(0, Math.min(255, Math.round(((db - DB_MIN) / span) * 255)));
        const o = (y * off.width + x) * 4;
        imgData[o] = lut[u * 4]!;
        imgData[o + 1] = lut[u * 4 + 1]!;
        imgData[o + 2] = lut[u * 4 + 2]!;
        imgData[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return off;
  }, [data]);

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
    const maxHz = data.maxHz;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // A ceiling at/above the displayed top (full-band 48 kHz / hi-res files)
    // has no in-view edge to mark. cutoffHz is clamped to the decode Nyquist,
    // not to maxHz, so it can exceed the display range; drawing then lands
    // the line at ≤ 0 px while the axis label clamps back into view.
    const ceilingInView = cutoffHz < maxHz - 0.5;
    if (ceilingInView) {
      const cutY = (1 - cutoffHz / maxHz) * cssH;
      ctx.strokeStyle = "rgba(232, 234, 238, 0.85)";
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, cutY);
      ctx.lineTo(cssW, cutY);
      ctx.stroke();
    }

    if (nyquistHz < maxHz - 200) {
      const ny = (1 - nyquistHz / maxHz) * cssH;
      ctx.strokeStyle = "rgba(232, 234, 238, 0.25)";
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(0, ny);
      ctx.lineTo(cssW, ny);
      ctx.stroke();
    }
  }, [analysis, data, spectrumImage]);

  useEffect(() => {
    draw();
    const wrap = wrapRef.current;
    if (!wrap) return;
    // Coalesce resize bursts (window drags, orientation changes) to one
    // repaint per frame — same pattern as SpectrumPlot.
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    });
    ro.observe(wrap);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [draw]);

  const hoverStepHz = 500;

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
      setHover(Math.max(0, Math.min(data.maxHz, t * data.maxHz)));
    });
  }

  function onProbeKey(e: KeyboardEvent<HTMLDivElement>) {
    let delta = 0;
    if (e.key === "ArrowUp") delta = hoverStepHz;
    else if (e.key === "ArrowDown") delta = -hoverStepHz;
    else if (e.key === "Home") {
      e.preventDefault();
      setHover(data.maxHz);
      return;
    } else if (e.key === "End") {
      e.preventDefault();
      setHover(0);
      return;
    } else {
      return;
    }
    e.preventDefault();
    setHover((h) => {
      const base = h ?? data.maxHz / 2;
      return Math.max(0, Math.min(data.maxHz, base + delta));
    });
  }

  // Keyboard probes need a percentage position — no rect measurement at
  // render time. Pointer probes land on the same representation.
  const hoverTop = hover == null ? null : (1 - hover / data.maxHz) * 100;

  // Axis positions are percent-from-top of the 0..maxHz column. The tick set
  // is fixed so every file reads against identical axes; the measured
  // ceiling gets its own label on the dashed line inside the plot instead of
  // displacing a tick (which made the two axes differ at a glance).
  const pctOf = (hz: number) => (1 - hz / data.maxHz) * 100;
  const ceilingPct = Math.max(0, pctOf(analysis.cutoffHz));
  const ceilingInView = analysis.cutoffHz < data.maxHz - 0.5;
  // Near the top there is no room above the line, so the label hangs below it.
  const ceilingLabelBelow = ceilingPct < 12;
  const ticks = [0, 5, 10, 15, 20].filter((k) => k * 1000 <= data.maxHz + 50);

  return (
    <div className={cn("flex gap-2", className)}>
      <div className="relative min-w-0 flex-1">
        <div
          ref={wrapRef}
          tabIndex={0}
          className="relative h-48 w-full overflow-hidden rounded-md bg-bg-inset outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:h-64"
          title="Use ↑ / ↓ to probe frequencies with the keyboard"
          onPointerMove={onPointer}
          onPointerEnter={onPointer}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onProbeKey}
          onFocus={() =>
            // Arriving by keyboard should show something to move immediately.
            setHover((h) => h ?? data.maxHz / 2)
          }
          onBlur={() => setHover(null)}
        >
          <canvas
            ref={canvasRef}
            className="block size-full"
            role="img"
            aria-label={`Spectrogram of ${analysis.fileName}${override ? `, scanned window from ${override.excerptStartSec.toFixed(1)} s` : ""}, ceiling ${formatHz(analysis.cutoffHz)}`}
          />
          <span
            className={cn(
              "pointer-events-none absolute right-1.5 rounded bg-bg/85 px-1 py-px font-mono text-[10px] leading-none text-fg tabular-nums",
              ceilingLabelBelow ? "mt-1" : "-translate-y-full -mt-1",
            )}
            style={{ top: `${ceilingInView ? ceilingPct : 0}%` }}
          >
            {ceilingInView ? "" : "≥ "}
            {formatHz(analysis.cutoffHz).replace(" kHz", "k")}
          </span>
          {hoverTop != null && (
            <div
              className="pointer-events-none absolute inset-x-0 h-px bg-fg/70"
              style={{ top: `${hoverTop}%` }}
            />
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-[11px] text-faint">
          <span>{data.excerptStartSec.toFixed(1)}s</span>
          {override ? (
            <button
              type="button"
              onClick={onResetOverride}
              className="inline-flex items-center gap-1 rounded bg-bg-subtle px-1.5 py-0.5 text-fg"
              aria-label="Reset to the default excerpt"
            >
              <RefreshCw className="size-3" />
              pinned {override.excerptStartSec.toFixed(1)}–
              {(override.excerptStartSec + override.durationSec).toFixed(1)}s · reset
            </button>
          ) : (
            <span className="flex items-center gap-1 text-muted">
              <Crosshair className="size-3" aria-hidden />
              excerpt
            </span>
          )}
          <span>
            {(data.excerptStartSec + data.durationSec).toFixed(1)}s
          </span>
        </div>
      </div>
      <div className="relative w-10 shrink-0 sm:w-12">
        <div className="relative h-48 sm:h-64">
          {ticks.map((k) => (
            <span
              key={k}
              className="absolute right-0 -translate-y-1/2 font-mono text-[10px] text-faint"
              style={{ top: `${pctOf(k * 1000)}%` }}
            >
              {k === 0 ? "0" : `${k}k`}
            </span>
          ))}
        </div>
        {hover != null && (
          <div className="mt-1 text-right font-mono text-[11px] whitespace-nowrap text-fg tabular-nums">
            {formatHz(hover).replace(" kHz", "k")}
          </div>
        )}
      </div>
    </div>
  );
}
