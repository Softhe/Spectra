import { AudioLines, Eye, EyeOff, Info } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { audioFilesFrom, NOT_AUDIO_NOTICE, STOP_EVENT } from "@/components/audio-drop";
import {
  FileSlot,
  SLOT_LABELS,
  type Outcome,
  type ScanState,
  type SlotState,
} from "@/components/file-slot";
import { CompareTable, HowTo, Verdict } from "@/components/panels";
import { Leaderboard } from "@/components/leaderboard";
import { SpectrumPlot } from "@/components/spectrum-plot";
import { Button } from "@/components/ui/button";
import {
  analyzeFile,
  CancelledError,
  scanExcerpt,
} from "@/lib/audio/analyze";
import { analysisWithRefined, pairComparison, rankedIds } from "@/lib/audio/rank";
import type { Ranking } from "@/lib/audio/rank";
import { refineAnalyses } from "@/lib/audio/refine";
import type { Refinement } from "@/lib/audio/refine";
import { makeDemoFiles } from "@/lib/audio/demo";
import { formatDuration } from "@/lib/audio/format";
import type { Analysis, Comparison, SlotId, SpectrogramData } from "@/lib/audio/types";

const SLOT_KEYS: SlotId[] = ["a", "b", "c", "d"];
const LOOP_SEC = 5;

const idle: SlotState = { status: "idle" };
const initialSlots: Record<SlotId, SlotState> = {
  a: idle,
  b: idle,
  c: idle,
  d: idle,
};

function analysisOf(s: SlotState | undefined): Analysis | null {
  return s && s.status === "ready" ? s.analysis : null;
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

/** Rough ETA string for a progress in [0,1] after `elapsedSec` of work. */
function etaLabel(elapsedSec: number, progress: number): string {
  const remaining = Math.max(1, (elapsedSec / Math.max(0.02, progress)) * (1 - progress));
  // Round to 5 s steps so the label flickers less than the honest estimate.
  return formatDuration(Math.ceil(remaining / 5) * 5);
}

export function Analyzer() {
  const [slots, setSlots] = useState<Record<SlotId, SlotState>>(initialSlots);
  const [demoBusy, setDemoBusy] = useState(false);
  const gens = useRef<Partial<Record<SlotId, number>>>({});
  const urls = useRef<Partial<Record<SlotId, string | null>>>({});
  const controllers = useRef<Partial<Record<SlotId, AbortController | null>>>({});
  // Transient feedback when a drop matches nothing audio-like.
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  const noticeTimer = useRef(0);

  const showDropNotice = useCallback((message: string) => {
    setDropNotice(message);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setDropNotice(null), 4500);
  }, []);

  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const release = useCallback((id: SlotId) => {
    // Stop this slot's playback first: revoking a blob URL out from under
    // a playing element kills seeks and can stall the element. Other
    // slots keep playing — loading B must never silence A.
    document.querySelectorAll<HTMLAudioElement>(`audio[data-slot="${id}"]`).forEach((el) => {
      if (!el.paused) el.pause();
    });
    const url = urls.current[id];
    if (url) URL.revokeObjectURL(url);
    urls.current[id] = null;
  }, []);

  // Swap the two slots' contents. Both slots must be free of in-flight work
  // (only called on ready slots). File identity travels with the analysis —
  // the A/B session, refinement, and leaderboard are all keyed by analysis
  // id, so a swap invalidates nothing.
  const swapSlots = useCallback((x: SlotId, y: SlotId) => {
    setSlots((s) => ({ ...s, [x]: s[y]!, [y]: s[x]! }));
    [urls.current[x], urls.current[y]] = [urls.current[y], urls.current[x]];
    setOverrides((o) => ({ ...o, [x]: o[y] ?? null, [y]: o[x] ?? null }));
    setScanStates((st) => ({ ...st, [x]: st[y] ?? null, [y]: st[x] ?? null }));
  }, []);

  const run = useCallback(
    async (id: SlotId, file: File) => {
      const gen = (gens.current[id] ?? 0) + 1;
      gens.current[id] = gen;
      // A previous in-flight analysis (this slot) must stop computing, not
      // just get discarded on arrival: on serial devices it otherwise holds
      // the queue, and everywhere else it burns a worker for nothing.
      controllers.current[id]?.abort();
      const controller = new AbortController();
      controllers.current[id] = controller;
      release(id);
      setOverrides((o) => ({ ...o, [id]: null }));
      setScanStates((st) => ({ ...st, [id]: null }));
      const startedAt = performance.now();
      setSlots((s) => ({
        ...s,
        [id]: { status: "loading", fileName: file.name, progress: 0.02, phase: "Starting" },
      }));
      try {
        const analysis = await enqueueAnalysis(async () => {
          // A newer file may have arrived while queued on serial devices.
          if ((gens.current[id] ?? 0) !== gen) throw new CancelledError();
          return analyzeFile(
            file,
            (phase, amount) => {
              if ((gens.current[id] ?? 0) !== gen) return;
              const elapsed = (performance.now() - startedAt) / 1000;
              setSlots((st) => ({
                ...st,
                [id]: {
                  status: "loading",
                  fileName: file.name,
                  progress: amount,
                  phase,
                  eta: amount > 0.06 && amount < 0.99 ? etaLabel(elapsed, amount) : undefined,
                },
              }));
            },
            controller.signal,
          );
        });
        if ((gens.current[id] ?? 0) !== gen) {
          URL.revokeObjectURL(analysis.objectUrl);
          return;
        }
        urls.current[id] = analysis.objectUrl;
        setSlots((st) => ({ ...st, [id]: { status: "ready", analysis } }));
      } catch (err) {
        if (err instanceof CancelledError || (gens.current[id] ?? 0) !== gen) return;
        const message = err instanceof Error ? err.message : "Could not analyze that file.";
        setSlots((st) => ({ ...st, [id]: { status: "error", message } }));
      }
    },
    [release],
  );

  const clear = useCallback(
    (id: SlotId) => {
      gens.current[id] = (gens.current[id] ?? 0) + 1;
      controllers.current[id]?.abort();
      controllers.current[id] = null;
      release(id);
      setSlots((st) => ({ ...st, [id]: idle }));
      setOverrides((o) => ({ ...o, [id]: null }));
      setScanStates((st) => ({ ...st, [id]: null }));
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
      // Only drops that missed every slot card reach here; a card drop
      // targets its own slot (FileSlot stops propagation).
      const files = audioFilesFrom(e.dataTransfer.files);
      if (files.length === 0) {
        showDropNotice(NOT_AUDIO_NOTICE);
        return;
      }
      const idleSlots = SLOT_KEYS.filter((id) => slots[id].status === "idle");
      if (idleSlots.length === 0) {
        showDropNotice("All four slots are full — clear one to make room.");
        return;
      }
      const taken = files.slice(0, idleSlots.length);
      taken.forEach((f, i) => void run(idleSlots[i]!, f));
      const overflow = files.length - taken.length;
      if (overflow > 0) {
        showDropNotice(
          overflow === 1
            ? `Loaded ${taken.length} files — 1 more than the free slots.`
            : `Loaded ${taken.length} files — ${overflow} more than the free slots.`,
        );
      }
    },
    [run, slots, showDropNotice],
  );

  // ---- ready files -----------------------------------------------------------

  const readySlots = useMemo(
    () => SLOT_KEYS.filter((id) => slots[id].status === "ready"),
    [slots],
  );
  const readySig = useMemo(
    () =>
      readySlots
        .map((id) => (slots[id] as { analysis: Analysis }).analysis.id)
        .sort()
        .join("|"),
    [readySlots], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const readyFiles: Analysis[] = useMemo(
    () => readySlots.map((id) => (slots[id] as { analysis: Analysis }).analysis),
    [readySlots, slots], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ---- shared-window refinement (fair comparison) -----------------------------

  const [refinement, setRefinement] = useState<Refinement | null>(null);
  const [refineStatus, setRefineStatus] = useState<{ phase: string; amount: number } | null>(null);
  const refineGen = useRef(0);
  const refineAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const files = readyFiles;
    const myGen = ++refineGen.current;
    refineAbort.current?.abort();
    setRefinement(null);
    setRefineStatus(null);
    if (files.length < 2 || files.length > 4) return;
    const controller = new AbortController();
    refineAbort.current = controller;
    setRefineStatus({ phase: "Same-song check", amount: 0.02 });
    refineAnalyses(
      files,
      (phase, amount) => {
        if (refineGen.current !== myGen) return;
        setRefineStatus({ phase, amount });
      },
      controller.signal,
    )
      .then((res) => {
        if (refineGen.current !== myGen) return;
        setRefineStatus(null);
        setRefinement(res);
      })
      .catch((err) => {
        if (refineGen.current !== myGen) return;
        setRefineStatus(null);
        if (!(err instanceof CancelledError)) {
          // Refinement is pure upside; the base comparison stays authoritative.
          console.warn("refinement failed", err);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readySig]);

  // ---- ranking ----------------------------------------------------------------

  const ranking: Ranking | null = useMemo(
    () => (readyFiles.length >= 2 ? rankedIds(readyFiles, refinement?.refined) : null),
    [readySig, refinement], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const slotOfId = useMemo(() => {
    const map: Record<string, SlotId | undefined> = {};
    for (const id of SLOT_KEYS) {
      const a = analysisOf(slots[id]);
      if (a) map[a.id] = id;
    }
    return map;
  }, [readySig]); // eslint-disable-line react-hooks/exhaustive-deps

  const filesById = useMemo(() => {
    const map: Record<string, Analysis> = {};
    for (const id of SLOT_KEYS) {
      const a = analysisOf(slots[id]);
      if (a) map[a.id] = a;
    }
    return map;
  }, [readySig]); // eslint-disable-line react-hooks/exhaustive-deps

  const displayFiles: (Analysis | null)[] = useMemo(
    () =>
      SLOT_KEYS.map((id) => {
        const a = analysisOf(slots[id]);
        return a ? analysisWithRefined(a, refinement?.refined[a.id]) : null;
      }),
    [readySig, refinement, slots], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ---- focused pair -------------------------------------------------------------

  const [focusPair, setFocusPair] = useState<[string, string] | null>(null);

  useEffect(() => {
    setFocusPair((cur) => {
      const stillThere =
        cur && cur[0] !== cur[1] && cur.every((fid) => slotOfId[fid] != null) ? cur : null;
      if (stillThere) return stillThere;
      if (readySlots.length >= 2) {
        return [
          (slots[readySlots[0]!] as { analysis: Analysis }).analysis.id,
          (slots[readySlots[1]!] as { analysis: Analysis }).analysis.id,
        ];
      }
      return null;
    });
  }, [readySig, slotOfId, slots]); // eslint-disable-line react-hooks/exhaustive-deps

  const pairAnalyses = useMemo(
    () => {
      if (!focusPair) return null;
      const fa = readyFiles.find((f) => f.id === focusPair[0]) ?? null;
      const fb = readyFiles.find((f) => f.id === focusPair[1]) ?? null;
      return fa && fb ? { a: fa, b: fb } : null;
    },
    [focusPair, readySig], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const pairRef = useRef<{ a: Analysis | null; b: Analysis | null }>({ a: null, b: null });
  pairRef.current = pairAnalyses ? { a: pairAnalyses.a, b: pairAnalyses.b } : { a: null, b: null };
  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  // Same bytes in both focused slots: a faux tie helps nobody — say so.
  const identical = useMemo(
    () =>
      Boolean(
        pairAnalyses &&
          ((pairAnalyses.a.cacheKey &&
            pairAnalyses.b.cacheKey &&
            pairAnalyses.a.cacheKey === pairAnalyses.b.cacheKey) ||
            (!pairAnalyses.a.cacheKey &&
              !pairAnalyses.b.cacheKey &&
              pairAnalyses.a.fileName === pairAnalyses.b.fileName &&
              pairAnalyses.a.fileSize === pairAnalyses.b.fileSize)),
      ),
    [pairAnalyses],
  );

  const comparison: Comparison | null = useMemo(
    () =>
      ranking && focusPair && !identical && pairAnalyses
        ? pairComparison(ranking, focusPair[0], focusPair[1])
        : null,
    [ranking, focusPair, identical, pairAnalyses],
  );

  // ---- blind test -----------------------------------------------------------------

  // Double-blind rounds: the compared files are staged into slots A and B,
  // which present as anonymous Clip 1 / Clip 2 (identity, numbers, and
  // pictures hidden) until reveal. In four-slot sessions the round picks two
  // ready files at random; the displaced files land in the vacated slots.
  const [blind, setBlind] = useState<{ revealed: boolean } | null>(null);
  const blindHidden = blind != null && !blind.revealed;

  const startBlindRound = useCallback(() => {
    const ready = SLOT_KEYS.filter((id) => slotsRef.current[id].status === "ready");
    if (ready.length < 2) return;
    const shuffled = [...ready].sort(() => Math.random() - 0.5);
    const sx = shuffled[0]!;
    const sy = shuffled[1]!;
    const idX = (slotsRef.current[sx] as { analysis: Analysis }).analysis.id;
    const idY = (slotsRef.current[sy] as { analysis: Analysis }).analysis.id;
    // Stage both chosen files into slots a and b, then hide the assignment
    // behind a coin flip so neither reveal order nor layout leaks identity.
    if (sx !== "a") swapSlots(sx, "a");
    if (sy !== "b") swapSlots(sy, "b");
    const flipped = Math.random() < 0.5;
    if (flipped) swapSlots("a", "b");
    setFocusPair(flipped ? [idY, idX] : [idX, idY]);
    setAbPlaying(null);
    switchPending.current = 0;
    matchRef.current = {};
    setBlind({ revealed: false });
  }, [swapSlots]);

  // ---- A/B session ----------------------------------------------------------------

  // A/B compare: which slot the verdict button started (null = manual play).
  const [abPlaying, setAbPlaying] = useState<SlotId | null>(null);
  const abArmed = useRef(false);
  // Non-zero while an abSwitch is between its start and the target's play
  // event (crossfade + seek). Pauses during that window are the switch's own
  // doing and must not end the A/B session.
  const switchPending = useRef(0);

  // One global volume for all previews (persisted). Fresh sessions start at
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
  const matchRef = useRef<Partial<Record<SlotId, number>>>({});

  const applyVolumes = useCallback(() => {
    const els = [...document.querySelectorAll("audio[data-slot]")] as HTMLAudioElement[];
    for (const el of els) {
      const id = el.dataset.slot as SlotId | undefined;
      const m = id ? (matchRef.current[id] ?? 1) : 1;
      el.volume = Math.min(1, Math.max(0, volume * m));
    }
  }, [volume]);

  // New files invalidate any A/B session and its loudness match. This MUST
  // be declared before the volume effect below: effects run in declaration
  // order, so the stale match is cleared before volumes are re-applied
  // (otherwise a freshly loaded slot can stay attenuated by the old ratio).
  useEffect(() => {
    setAbPlaying(null);
    switchPending.current = 0;
    matchRef.current = {};
    setLoopOn(false);
  }, [readySig]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep every preview element on the global level, including freshly
  // mounted ones after a file loads.
  useEffect(() => {
    applyVolumes();
  }, [applyVolumes, readySig, volume]);

  const handleVolumeChange = useCallback((v: number) => {
    setVolume(v);
    try {
      localStorage.setItem("spectra:volume", String(v));
    } catch {
      // Private mode: session-only volume.
    }
  }, []);

  // Manual slot playback cancels A/B mode (unless this event IS the switch).
  // The same event also feeds lock-screen / headset controls (Media Session).
  const analysesRef = useRef<Partial<Record<SlotId, Analysis>>>({});
  analysesRef.current = Object.fromEntries(
    SLOT_KEYS.map((id) => [id, analysisOf(slots[id])]).filter(([, a]) => a != null),
  );
  // Last slot that actually played, A/B or manual. Kept apart from abPlaying,
  // which clears on pause — headset play must resume the copy that paused.
  const lastPlayedRef = useRef<SlotId | null>(null);
  // Latest-switch ref: lets the Media Session handlers (subscribed once)
  // always reach the current abSwitch without re-subscribing.
  const abSwitchRef = useRef<(target: SlotId) => void>(() => undefined);

  useEffect(() => {
    const audios = () => [...document.querySelectorAll("audio[data-slot]")] as HTMLAudioElement[];
    const onPlay = (e: Event) => {
      const id = (e as CustomEvent<SlotId>).detail;
      lastPlayedRef.current = id;
      if (abArmed.current) {
        abArmed.current = false;
        switchPending.current = 0;
        setAbPlaying(id);
      } else {
        setAbPlaying(null);
      }
      try {
        if ("mediaSession" in navigator) {
          const track = analysesRef.current[id] ?? null;
          if (track) {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: track.fileName,
              artist: `Spectra · ${SLOT_LABELS[id]}`,
              album: "Same song, different sources",
            });
          }
        }
      } catch {
        // Media Session is best-effort.
      }
    };
    // The A/B-active side paused (its own button, the media session, or the
    // track ending): the session is over, so the verdict button and the A/B
    // keys return to their idle behavior. Functional update: the other
    // side's exclusivity/crossfade pause arrives after the new side's play
    // already moved abPlaying on, so it never matches.
    const onStop = (e: Event) => {
      if (switchPending.current) return;
      const id = (e as CustomEvent<SlotId>).detail;
      setAbPlaying((cur) => (cur === id ? null : cur));
    };
    window.addEventListener("spectra:now-playing", onPlay);
    window.addEventListener(STOP_EVENT, onStop);
    try {
      if ("mediaSession" in navigator) {
        const ms = navigator.mediaSession;
        ms.setActionHandler("play", () => {
          const els = audios();
          // Resume the most recently played preview, else the first paused.
          const target =
            els.find((el) => el.dataset.slot === lastPlayedRef.current) ??
            els.find((el) => el.paused) ??
            els[0];
          if (target) void target.play().catch(() => undefined);
        });
        ms.setActionHandler("pause", () => {
          for (const el of audios()) el.pause();
        });
        // Headset prev/next jumps straight between slots A and B.
        ms.setActionHandler("previoustrack", () => abSwitchRef.current("a"));
        ms.setActionHandler("nexttrack", () => abSwitchRef.current("b"));
      }
    } catch {
      // Media Session is best-effort.
    }
    return () => {
      window.removeEventListener("spectra:now-playing", onPlay);
      window.removeEventListener(STOP_EVENT, onStop);
      try {
        if ("mediaSession" in navigator) {
          for (const action of ["play", "pause", "previoustrack", "nexttrack"] as const) {
            navigator.mediaSession.setActionHandler(action, null);
          }
        }
      } catch {
        // Ignore.
      }
    };
    // Subscribed once; headset handlers reach abSwitch through its ref.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fade bookkeeping so rapid successive switches never strand audio:
  // only the newest fade on an element may pause it.
  const fadeSeq = useRef<Partial<Record<SlotId, number>>>({});

  const fadeOutThenPause = useCallback((el: HTMLAudioElement, id: SlotId, holdVolume: number) => {
    const seq = (fadeSeq.current[id] ?? 0) + 1;
    fadeSeq.current[id] = seq;
    const ms = 70;
    const t0 = performance.now();
    const finish = () => {
      if ((fadeSeq.current[id] ?? 0) !== seq) return; // superseded by a newer fade
      // Terminal: consume the seq so the backstop timeout below can tell a
      // completed fade from one stalled mid-way (an element that resumed
      // playing afterwards must never be paused by it).
      fadeSeq.current[id] = seq + 1;
      el.pause();
      try {
        el.volume = holdVolume;
      } catch {
        // Already removed.
      }
    };
    const step = () => {
      if ((fadeSeq.current[id] ?? 0) !== seq) return; // superseded by a newer fade
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
        finish();
      }
    };
    requestAnimationFrame(step);
    // rAF freezes in hidden tabs — without this backstop the old side
    // would keep playing under the new one indefinitely.
    window.setTimeout(() => {
      if ((fadeSeq.current[id] ?? 0) !== seq) return;
      try {
        if (!el.paused) finish();
      } catch {
        // Already removed.
      }
    }, 600);
  }, []);

  // Switch generation: a stale seek/play from an outpaced switch must never
  // disturb the newest one (otherwise two exclusivity pauses silence both).
  const switchSeq = useRef(0);

  // ---- A/B 5-second loop -----------------------------------------------------------

  const [loopOn, setLoopOn] = useState(false);
  const loopOnRef = useRef(loopOn);
  loopOnRef.current = loopOn;
  // Anchor in the focused pair's FIRST member's time base. Pair-aligned
  // offsets come from the refinement's envelope alignment (0 without it), so
  // a trimmed copy still loops over the identical musical take.
  const loopAnchorSec = useRef(30);

  const refinementRef = useRef<Refinement | null>(null);
  refinementRef.current = refinement;

  const offsetOf = useCallback((fid: string | undefined): number => {
    return fid ? (refinementRef.current?.offsetByKey[fid] ?? 0) : 0;
  }, []);

  /** The pinned loop window for one slot, expressed in that slot's own time. */
  const loopWindowFor = useCallback(
    (id: SlotId): { start: number; length: number } | null => {
      if (!loopOnRef.current || !pairRef.current?.a) return null;
      const a = analysesRef.current[id];
      if (!a) return null;
      const offA = offsetOf(pairRef.current.a.id);
      const off = offsetOf(a.id);
      const start = Math.max(
        0,
        Math.min(loopAnchorSec.current + (off - offA), Math.max(0, a.durationSec - LOOP_SEC)),
      );
      return { start, length: LOOP_SEC };
    },
    [offsetOf], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const toggleLoop = useCallback(() => {
    const next = !loopOnRef.current;
    setLoopOn(next);
    if (next) {
      const pair = pairRef.current;
      if (pair?.a && pair.b) {
        // Anchor on a playing preview's position; otherwise default 30 s in.
        const els = [...document.querySelectorAll("audio[data-slot]")] as HTMLAudioElement[];
        const playing = els.find((el) => !el.paused);
        if (playing) {
          const fid = analysesRef.current[playing.dataset.slot as SlotId]?.id;
          loopAnchorSec.current = Math.max(
            0,
            (playing.currentTime ?? 0) - (offsetOf(fid) - offsetOf(pair.a.id)),
          );
        } else {
          loopAnchorSec.current = Math.max(
            0,
            Math.min(30, Math.min(pair.a.durationSec, pair.b.durationSec) - LOOP_SEC - 0.5),
          );
        }
      }
    }
  }, [offsetOf]); // eslint-disable-line react-hooks/exhaustive-deps

  // Swap the focused pair's two slots.
  const swapPair = useCallback(() => {
    if (!focusPair || !pairAnalyses) return;
    const sx = slotOfId[focusPair[0]];
    const sy = slotOfId[focusPair[1]];
    if (!sx || !sy) return;
    swapSlots(sx, sy);
    // Pair orientation stays (File A stays File A in the verdict text); the
    // letters under the files simply trade places.
  }, [focusPair, pairAnalyses, slotOfId, swapSlots]);

  const abSwitch = useCallback(
    (target: SlotId) => {
      const pair = pairRef.current;
      if (!pair || !pair.a || !pair.b) return;
      const mySwitch = ++switchSeq.current;
      switchPending.current = mySwitch;
      const els = [...document.querySelectorAll("audio[data-slot]")] as HTMLAudioElement[];
      const targetEl = els.find((el) => el.dataset.slot === target);
      const playingEl = els.find((el) => el !== targetEl && !el.paused) ?? null;
      if (!targetEl) {
        switchPending.current = 0;
        return;
      }
      // Continue where the other preview left off — unless the loop is on,
      // which always restarts at the pair-aligned loop window (the whole
      // point: identical takes, identical position).
      const otherTime = playingEl && !playingEl.paused ? playingEl.currentTime : null;
      let t = otherTime ?? targetEl.currentTime;
      if (loopOnRef.current) {
        const a = analysesRef.current[target];
        if (a) {
          const offA = offsetOf(pair.a.id);
          const off = offsetOf(a.id);
          t = Math.max(
            0,
            Math.min(loopAnchorSec.current + (off - offA), Math.max(0, a.durationSec - LOOP_SEC)),
          );
        }
      }
      // Loudness match on RMS so the switch compares quality, not volume.
      // Stored as ratios against the global volume (which never moves here),
      // so the user's level is retained across switches. The louder side is
      // attenuated to the quieter one, never the reverse.
      const otherId = playingEl?.dataset.slot as SlotId | undefined;
      const targetAnalysis = analysesRef.current[target] ?? null;
      const otherAnalysis = otherId ? (analysesRef.current[otherId] ?? null) : null;
      const rmsT = targetAnalysis?.rmsDb ?? pair.a.rmsDb;
      const rmsO = otherAnalysis?.rmsDb ?? (target === "a" ? pair.b.rmsDb : pair.a.rmsDb);
      const diffDb = rmsO - rmsT;
      const ratio = Math.max(0.05, Math.min(1, Math.pow(10, -Math.abs(diffDb) / 20)));
      const targetIsLouder = diffDb <= 0;
      matchRef.current = {
        ...matchRef.current,
        [target]: targetIsLouder ? ratio : 1,
        ...(otherId ? { [otherId]: targetIsLouder ? 1 : ratio } : {}),
      };
      const targetVolume = Math.min(1, Math.max(0, volume * (targetIsLouder ? ratio : 1)));
      const otherVolume = Math.min(1, Math.max(0, volume * (targetIsLouder ? 1 : ratio)));
      // The target may still be fading out from a switch this one supersedes
      // (switching back within the fade, or within the 600 ms backstop while
      // rAF is frozen on a locked screen). Cancel that fade now — its rAF
      // steps and backstop both check fadeSeq — or it would pause the target
      // right after this switch starts or adopts it, ending the session.
      fadeSeq.current[target] = (fadeSeq.current[target] ?? 0) + 1;
      targetEl.volume = targetVolume;

      const startTarget = () => {
        if (switchSeq.current !== mySwitch) return;
        if (!targetEl.paused) {
          // Already playing (manual preview, or still fading out from a
          // switch this one supersedes): play() would fire no event, leaving
          // the switch armed/pending forever. Adopt it directly. Its fade was
          // cancelled above; restore the level a partial fade left behind.
          fadeSeq.current[target] = (fadeSeq.current[target] ?? 0) + 1;
          try {
            targetEl.volume = targetVolume;
          } catch {
            // Element gone: nothing to restore.
          }
          abArmed.current = false;
          switchPending.current = 0;
          setAbPlaying(target);
          return;
        }
        abArmed.current = true;
        targetEl.play().catch(() => {
          if (switchSeq.current !== mySwitch) return;
          abArmed.current = false;
          switchPending.current = 0;
          setAbPlaying(null);
        });
      };

      if (playingEl && !playingEl.paused) {
        // Crossfade: the old side fades out while the new side seeks (its
        // decode stall happens silently) and starts only once positioned.
        const otherSlot = otherId ?? "b";
        playingEl.volume = otherVolume;
        fadeOutThenPause(playingEl, otherSlot, otherVolume);
        const hasDuration = Number.isFinite(targetEl.duration) && targetEl.duration > 0;
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
        // Any further playing previews (3rd/4th slots) stop immediately.
        for (const el of els) {
          const sid = el.dataset.slot as SlotId | undefined;
          if (sid == null || sid === target || el === playingEl) continue;
          if (!el.paused) el.pause();
        }
      } else {
        // Fresh switch: pause everything else and seek/start the target.
        for (const el of els) {
          const sid = el.dataset.slot as SlotId | undefined;
          if (sid == null || sid === target) continue;
          if (!el.paused) el.volume = otherVolume;
          el.pause();
        }
        const hasDuration = Number.isFinite(targetEl.duration) && targetEl.duration > 0;
        if (hasDuration && Math.abs(targetEl.currentTime - t) >= 0.05) {
          targetEl.currentTime = Math.max(0, Math.min(t, Math.max(0, targetEl.duration - 0.1)));
        }
        startTarget();
      }
    },
    [volume, fadeOutThenPause, offsetOf], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    abSwitchRef.current = abSwitch;
  });

  // Keyboard A/B: the ear-compare workflow is a rapid toggle, and reaching
  // for the button each time breaks the illusion of one continuous take.
  // The A and B keys jump straight to those slots at the same position.
  // Skipped while typing and with modifier chords, which belong to the browser.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const key = e.key.toLowerCase();
      if (key !== "a" && key !== "b") return;
      if (!pairRef.current) return;
      const target: SlotId = key === "a" ? "a" : "b";
      if (abPlaying === target) return;
      e.preventDefault();
      abSwitch(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [abPlaying, abSwitch]);

  // ---- excerpt re-scan (pin a scan at the playhead) ---------------------------------

  const [scanStates, setScanStates] = useState<Partial<Record<SlotId, ScanState>>>({});
  const [overrides, setOverrides] = useState<Partial<Record<SlotId, SpectrogramData | null>>>({});
  const scanCtl = useRef<AbortController | null>(null);
  useEffect(() => () => scanCtl.current?.abort(), []);

  const runScan = useCallback(
    async (id: SlotId, seekSec: number) => {
      const a = analysesRef.current[id];
      if (!a || scanCtl.current) return;
      setScanStates((st) => ({ ...st, [id]: { busy: true, progress: 0.02, phase: "Reading" } }));
      const controller = new AbortController();
      scanCtl.current = controller;
      try {
        const res = await fetch(a.objectUrl);
        if (!res.ok) throw new Error("That file is no longer available to re-scan.");
        const blob = await res.blob();
        const data = await scanExcerpt(
          blob,
          a.container.sampleRate,
          seekSec,
          (phase, amount) => {
            setScanStates((st) => ({ ...st, [id]: { busy: true, progress: amount, phase } }));
          },
          controller.signal,
        );
        setOverrides((o) => ({ ...o, [id]: data }));
        setScanStates((st) => ({ ...st, [id]: null }));
      } catch (err) {
        if (controller.signal.aborted) return;
        setScanStates((st) => ({ ...st, [id]: null }));
        showDropNotice(err instanceof Error ? err.message : "That excerpt could not be scanned.");
      } finally {
        if (scanCtl.current === controller) scanCtl.current = null;
      }
    },
    [showDropNotice],
  );

  // ---- verdict helpers ---------------------------------------------------------------

  const outcomeFor = useCallback(
    (id: SlotId): Outcome => {
      const fid = analysesRef.current[id]?.id;
      if (!fid || !comparison) return null;
      if (comparison.winner === "tie") return "tie";
      if (fid === focusPair?.[0]) return comparison.winner === "a" ? "win" : "lose";
      if (fid === focusPair?.[1]) return comparison.winner === "b" ? "win" : "lose";
      return null;
    },
    [comparison, focusPair],
  );

  const outcomeForSlot = useCallback(
    (id: SlotId): Outcome => {
      if (identical) return pairAnalyses ? "tie" : null;
      return outcomeFor(id);
    },
    [identical, pairAnalyses, outcomeFor],
  );

  // Declare the winner everywhere, including the tab title.
  useEffect(() => {
    if (blindHidden) {
      document.title = "Blind test · Spectra";
    } else if (identical) {
      document.title = "Identical files · Spectra";
    } else if (!comparison) {
      document.title = "Spectra";
    } else if (comparison.winner === "tie") {
      document.title = "Toss-up · Spectra";
    } else {
      const fid = comparison.winner === "a" ? focusPair?.[0] : focusPair?.[1];
      const slot = fid ? slotOfId[fid] : null;
      document.title = slot ? `${SLOT_LABELS[slot]} wins · Spectra` : "Winner · Spectra";
    }
  }, [comparison, identical, focusPair, slotOfId, blindHidden]);

  const refineNote = useMemo(() => {
    if (!refinement) return null;
    const others = Object.entries(refinement.alignByKey).filter(
      ([fid]) => fid !== refinement.refId,
    );
    const minCorr = others.length ? Math.min(...others.map(([, v]) => v.correlation)) : 1;
    return (
      `Refined: every file re-measured over one shared ${refinement.windowSec.toFixed(1)} s window` +
      ` (envelope alignment r ≥ ${(minCorr * 100).toFixed(0)}%).`
    );
  }, [refinement]);

  return (
    <div
      className="min-h-dvh bg-bg text-fg"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onWindowDrop}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
        <header className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-xl">
            <p className="font-mono text-[11px] tracking-[0.22em] text-muted uppercase">Spectra</p>
            <h1 className="mt-2 text-3xl leading-tight font-medium tracking-tight text-fg sm:text-4xl">
              Which copy kept the air?
            </h1>
            <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted">
              Compare up to four copies of the same song to find which kept more detail. Encoders
              write a bitrate in the header. That is a claim. Spectra reads the audio itself — a
              320 kbps file upconverted from 128 still dies at 16 kHz.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={blind ? "default" : "outline"}
              onClick={() => (blind ? setBlind(null) : startBlindRound())}
              disabled={readySlots.length < 2}
            >
              {blind ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
              {blind ? "Exit blind test" : "Blind test"}
            </Button>
            <Button
              variant="outline"
              onClick={() => void loadDemo()}
              disabled={demoBusy || SLOT_KEYS.some((id) => slots[id].status === "loading")}
            >
              <AudioLines className="size-4" />
              {demoBusy ? "Building demo" : "Load a demo comparison"}
            </Button>
          </div>
        </header>

        {dropNotice && (
          <p
            role="status"
            aria-live="polite"
            className="rounded-lg bg-bg-elevated px-4 py-2.5 text-sm text-warn shadow-[var(--shadow-border)]"
          >
            {dropNotice}
          </p>
        )}

        {refineStatus && (
          <div className="rounded-lg bg-bg-elevated px-4 py-2.5 text-sm text-muted shadow-[var(--shadow-border)]">
            <p aria-live="polite">Refining the comparison — {refineStatus.phase}</p>
            <div
              role="progressbar"
              aria-label="Shared-window refinement progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(refineStatus.amount * 100)}
              className="mt-2 h-1 overflow-hidden rounded-full bg-bg-subtle"
            >
              <div
                className="h-full bg-accent transition-[width] duration-200"
                style={{ width: `${Math.round(refineStatus.amount * 100)}%` }}
              />
            </div>
          </div>
        )}
        {!refineStatus && refineNote && (
          <p className="rounded-lg bg-bg-elevated px-4 py-2.5 text-xs text-faint shadow-[var(--shadow-border)]">
            {refineNote}
          </p>
        )}

        {blindHidden && (
          <aside aria-live="polite" className="rounded-xl bg-bg-elevated px-5 py-4 sm:px-6 sm:py-5">
            <p className="flex items-center gap-1.5 font-mono text-[11px] tracking-widest text-muted uppercase">
              <EyeOff className="size-3.5" />
              Blind test in progress
            </p>
            <h2 className="mt-1 text-xl font-medium tracking-tight text-fg sm:text-2xl">
              Judge by ear, then reveal
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
              Clip 1 and Clip 2 below are hidden copies. Names, numbers, and pictures come back
              when you reveal — and the verdict will tell you which hidden clip kept the air. Press{" "}
              <kbd className="rounded border border-border bg-bg-subtle px-1 py-px font-mono text-[10px] text-muted">
                A
              </kbd>
              /
              <kbd className="rounded border border-border bg-bg-subtle px-1 py-px font-mono text-[10px] text-muted">
                B
              </kbd>{" "}
              to flip between the clips, or turn on the 5-second loop for the toughest passages.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => setBlind({ revealed: true })}>
                <Eye className="size-4" />
                Reveal
              </Button>
              <Button variant="outline" onClick={startBlindRound}>
                <AudioLines className="size-4" />
                New round
              </Button>
            </div>
          </aside>
        )}

        {identical && pairAnalyses && readySlots.length === 2 ? (
          <aside aria-live="polite" className="rounded-xl bg-bg-elevated px-5 py-4 sm:px-6 sm:py-5">
            <p className="flex items-center gap-1.5 font-mono text-[11px] tracking-widest text-muted uppercase">
              <Info className="size-3.5 text-info" />
              Identical files · no comparison
            </p>
            <h2 className="mt-1 text-xl font-medium tracking-tight text-fg sm:text-2xl">
              Two slots hold the same bytes
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
              <span className="[overflow-wrap:anywhere]">{pairAnalyses.a.fileName}</span> matched
              itself bit-for-bit, so there is nothing to declare. Drop a different copy of the song
              into any slot to compare.
            </p>
          </aside>
        ) : comparison && pairAnalyses && !blindHidden ? (
          <Verdict
            comparison={comparison}
            a={pairAnalyses.a}
            b={pairAnalyses.b}
            slotA={slotOfId[pairAnalyses.a.id] ?? "a"}
            slotB={slotOfId[pairAnalyses.b.id] ?? "b"}
            abPlaying={abPlaying}
            loopOn={loopOn}
            onAbSwitch={abSwitch}
            onToggleLoop={toggleLoop}
            onSwap={swapPair}
            volume={volume}
            onVolumeChange={handleVolumeChange}
          />
        ) : null}

        {blind?.revealed && (
          <p className="rounded-lg bg-bg-elevated px-4 py-2.5 text-xs text-muted shadow-[var(--shadow-border)]">
            Round revealed —{" "}
            <span className="text-fg">
              Clip 1 is {SLOT_LABELS[slotOfId[pairAnalyses?.a.id ?? ""] ?? "a"]}
            </span>{" "}
            and{" "}
            <span className="text-fg">
              Clip 2 is {SLOT_LABELS[slotOfId[pairAnalyses?.b.id ?? ""] ?? "b"]}
            </span>
            . Names and pictures are unmasked; start a new round to hide them again.
          </p>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          {SLOT_KEYS.map((id) => {
            const a = analysisOf(slots[id]);
            return (
              <FileSlot
                key={id}
                id={id}
                state={slots[id]}
                outcome={blindHidden ? null : outcomeForSlot(id)}
                masked={blindHidden}
                refinedCutoffHz={blindHidden ? null : (a && refinement?.refined[a.id]?.cutoffHz) ?? null}
                refinedClass={blindHidden ? null : (a && refinement?.refined[a.id]?.qualityClass) ?? null}
                loopWindow={loopOn && pairAnalyses ? loopWindowFor(id) : null}
                scanState={scanStates[id] ?? null}
                onScan={(seek) => void runScan(id, seek)}
                override={overrides[id] ?? null}
                onResetOverride={() => setOverrides((o) => ({ ...o, [id]: null }))}
                onFile={(f) => void run(id, f)}
                onClear={() => clear(id)}
                onRejectedDrop={() => showDropNotice(NOT_AUDIO_NOTICE)}
              />
            );
          })}
        </div>

        {ranking && (
          <Leaderboard
            ranking={ranking}
            filesById={filesById}
            slotOfId={slotOfId}
            focusPair={focusPair}
            refinement={refinement}
            onPairStart={(idA, idB) => {
              setFocusPair([idA, idB]);
              const sa = slotOfId[idA];
              if (sa) abSwitch(sa);
            }}
            onPairFocus={(idA, idB) => setFocusPair([idA, idB])}
          />
        )}

        <SpectrumPlot
          files={displayFiles}
          winnerSlot={
            comparison && comparison.winner !== "tie" && focusPair
              ? (slotOfId[comparison.winner === "a" ? focusPair[0] : focusPair[1]] ?? null)
              : null
          }
        />

        {pairAnalyses && !blindHidden ? (
          <CompareTable
            a={analysisWithRefined(pairAnalyses.a, refinement?.refined[pairAnalyses.a.id])}
            b={analysisWithRefined(pairAnalyses.b, refinement?.refined[pairAnalyses.b.id])}
            winner={comparison?.winner ?? "tie"}
            slotA={slotOfId[pairAnalyses.a.id] ?? "a"}
            slotB={slotOfId[pairAnalyses.b.id] ?? "b"}
          />
        ) : null}

        <HowTo />
      </div>
    </div>
  );
}
