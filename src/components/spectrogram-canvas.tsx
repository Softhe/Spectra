import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { buildLut, DB_MAX, DB_MIN } from "@/lib/audio/colormap";
import { formatHz } from "@/lib/audio/format";
import type { Analysis } from "@/lib/audio/types";
import { cn } from "@/lib/utils";

const lut = buildLut();

/**
 * Calls `onChange` whenever devicePixelRatio changes (window dragged to a
 * monitor with a different scale, browser zoom). A resolution media query
 * only fires once, so it re-subscribes at the new ratio each time.
 */
function watchDpr(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  let mql: MediaQueryList | null = null;
  const handler = () => {
    subscribe();
    onChange();
  };
  const subscribe = () => {
    mql?.removeEventListener("change", handler);
    mql = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mql.addEventListener("change", handler);
  };
  subscribe();
  return () => mql?.removeEventListener("change", handler);
}

type Props = {
  analysis: Analysis;
  /** Slot name for the probe's accessible label, e.g. "File A". */
  label?: string;
  className?: string;
};

export function SpectrogramCanvas({ analysis, label, className }: Props) {
  const descId = useId();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hoverRaf = useRef(0);
  const [hover, setHover] = useState<number | null>(null);

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
    // Coalesce resize bursts (window drags, orientation changes) to one
    // repaint per frame — same pattern as SpectrumPlot.
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    });
    ro.observe(wrap);
    const unwatchDpr = watchDpr(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unwatchDpr();
    };
  }, [draw]);

  const hoverStepHz = 500;
  const pageStepHz = 2000;
  const maxHz = analysis.spectrogram.maxHz;
  // Keyboard probing starts at the measured ceiling — the line that matters.
  const restHz = Math.max(0, Math.min(maxHz, analysis.cutoffHz));

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
      setHover(Math.max(0, Math.min(analysis.spectrogram.maxHz, t * analysis.spectrogram.maxHz)));
    });
  }

  function onProbeKey(e: KeyboardEvent<HTMLDivElement>) {
    let delta = 0;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") delta = hoverStepHz;
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") delta = -hoverStepHz;
    else if (e.key === "PageUp") delta = pageStepHz;
    else if (e.key === "PageDown") delta = -pageStepHz;
    else if (e.key === "Home") {
      e.preventDefault();
      setHover(analysis.spectrogram.maxHz);
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
      const base = h ?? restHz;
      return Math.max(0, Math.min(analysis.spectrogram.maxHz, base + delta));
    });
  }

  // The slider value: the live probe, else where keyboard probing starts.
  const probeHz = hover ?? restHz;
  const probeText = `${formatHz(probeHz)}${
    probeHz > analysis.cutoffHz + 50 ? ", above the ceiling" : ""
  }`;

  // Keyboard probes need a percentage position — no rect measurement at
  // render time. Pointer probes land on the same representation.
  const hoverTop = hover == null ? null : (1 - hover / analysis.spectrogram.maxHz) * 100;

  // Axis positions are percent-from-top of the 0..maxHz column. The ceiling
  // label is clamped to 6–94% so it never clips at the edges; a tick whose
  // rendered position sits within one label height of the label's (clamped)
  // position would overlap it, so it is hidden. 8% ≈ a 10px label's line box
  // on the shortest (h-48, 192px) column.
  const pctOf = (hz: number) => (1 - hz / analysis.spectrogram.maxHz) * 100;
  const ceilingPct = Math.min(94, Math.max(6, pctOf(analysis.cutoffHz)));
  const LABEL_CLEARANCE_PCT = 8;
  const ticks = [0, 5, 10, 15, 20].filter(
    (k) =>
      k * 1000 <= analysis.spectrogram.maxHz + 50 &&
      Math.abs(pctOf(k * 1000) - ceilingPct) >= LABEL_CLEARANCE_PCT,
  );

  return (
    <div className={cn("flex gap-2", className)}>
      <div className="relative min-w-0 flex-1">
        <div
          ref={wrapRef}
          tabIndex={0}
          role="slider"
          aria-label={`Frequency probe${label ? `, ${label}` : ""}`}
          aria-describedby={descId}
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={Math.round(maxHz)}
          aria-valuenow={Math.round(probeHz)}
          aria-valuetext={probeText}
          className="relative h-48 w-full overflow-hidden rounded-md bg-bg-inset outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:h-64"
          title="Use ↑ / ↓ to probe frequencies with the keyboard"
          onPointerMove={onPointer}
          onPointerEnter={onPointer}
          onPointerLeave={() => {
            // A rAF queued by the last move would re-show the probe.
            cancelAnimationFrame(hoverRaf.current);
            setHover(null);
          }}
          onKeyDown={onProbeKey}
          onFocus={() =>
            // Arriving by keyboard should show something to move immediately.
            setHover((h) => h ?? restHz)
          }
          onBlur={() => {
            cancelAnimationFrame(hoverRaf.current);
            setHover(null);
          }}
        >
          {/* Slider children are presentational; the picture is described
              via aria-describedby instead of role="img". */}
          <canvas ref={canvasRef} className="block size-full" aria-hidden="true" />
          {hoverTop != null && (
            <div
              className="pointer-events-none absolute inset-x-0 h-px bg-fg/70"
              style={{ top: `${hoverTop}%` }}
            />
          )}
        </div>
        <p id={descId} className="sr-only">
          {`Spectrogram of ${analysis.fileName}, ceiling ${formatHz(analysis.cutoffHz)}. Use the up and down arrow keys to probe frequencies.`}
        </p>
        <div className="mt-1.5 flex justify-between font-mono text-[11px] text-faint">
          <span>{analysis.spectrogram.excerptStartSec.toFixed(1)}s</span>
          <span>excerpt</span>
          <span>
            {(analysis.spectrogram.excerptStartSec + analysis.spectrogram.durationSec).toFixed(1)}s
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
          <span
            className="absolute right-0 -translate-y-1/2 font-mono text-[10px] text-fg"
            style={{ top: `${ceilingPct}%` }}
          >
            {formatHz(analysis.cutoffHz).replace(" kHz", "k")}
          </span>
        </div>
        {hover != null && (
          <div aria-hidden="true" className="mt-1 font-mono text-[11px] text-fg tabular-nums">
            {formatHz(hover)}
          </div>
        )}
      </div>
    </div>
  );
}
