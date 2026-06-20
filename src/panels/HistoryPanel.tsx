import "../styles/panels/home.css";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { t } from "../i18n";
import { deleteRecording, getHistoryDetail, incrementCopy, retranscribe } from "../lib/ipc";
import type { HistoryItem, Mode, SpeakerSeg, WordStamp } from "../lib/types";
import {
  estimateCost,
  formatCost,
  modelById,
  modeUsable,
  type ProviderStatus,
  type Registry,
} from "../lib/registry";
import { ProviderLogo } from "../components/ProviderLogo";

const pad = (n: number) => String(n).padStart(2, "0");

/** xAI returns long file transcripts (~55+ min) without speaker labels even when
 *  diarization is requested. Warn before a re-run that's likely to hit this — a
 *  UX nudge only, never a hard limit and never used in success/failure detection. */
const XAI_DIARIZATION_WARNING_SECONDS = 55 * 60;

/** Effective diarization for a mode: enabled on the mode AND supported by its model
 *  (mirrors the backend's `build_options` intersection). */
function modeDiarizationOn(registry: Registry | null, mode: Mode): boolean {
  const model = modelById(registry, mode.model);
  return !!(mode.capabilities?.diarization && model?.capabilities?.diarization);
}

/** Whether to surface the soft pre-run warning for an xAI long-file diarization
 *  re-run. Re-run is always file transcription, so kind isn't checked here. */
function shouldWarnXaiLongDiarization(
  registry: Registry | null,
  mode: Mode,
  durationSecs: number,
): boolean {
  return (
    modelById(registry, mode.model)?.provider === "xai" &&
    modeDiarizationOn(registry, mode) &&
    durationSecs >= XAI_DIARIZATION_WARNING_SECONDS
  );
}

/** How many transcript cards to render per batch (grown on scroll). Keeps the
 *  DOM small so returning to Home with a large archive stays snappy. */
const PAGE_SIZE = 30;

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff === 0) return "TODAY";
  if (diff === 1) return "YESTERDAY";
  return d
    .toLocaleDateString("en-US", { weekday: "short", day: "2-digit", month: "short", year: "numeric" })
    .toUpperCase();
}
const timeLabel = (ts: number) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const durLabel = (s: number) => `${Math.floor(s / 60)}:${pad(Math.round(s % 60))}`;
/** Live elapsed for the in-flight recording card. Self-contained leaf: owns its
 *  own 1s interval and counts from the row's createdAt, so it survives panel
 *  remounts and never re-renders the rest of the list. */
function CardRecTimer({ createdAt }: { createdAt: number }) {
  const [secs, setSecs] = useState(() => Math.max(0, (Date.now() - createdAt) / 1000));
  useEffect(() => {
    const tick = () => setSecs(Math.max(0, (Date.now() - createdAt) / 1000));
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [createdAt]);
  return <span className="hm-status busy">{durLabel(secs)}</span>;
}
/** How long the transcription took (ms → "x.xs"), or "" when not measured. */
const tookLabel = (ms: number) => (ms > 0 ? `${(ms / 1000).toFixed(1)}s` : "");
/** A word/segment start time as mm:ss.s. */
const tcLabel = (s: number) => `${pad(Math.floor(s / 60))}:${(s % 60).toFixed(1).padStart(4, "0")}`;
/** Human speaker label: numeric ids become "SPEAKER n", others pass through. */
const speakerLabel = (s: string) => (/^\d+$/.test(s) ? `SPEAKER ${s}` : s.toUpperCase());

function speakerSegments(item: HistoryItem): SpeakerSeg[] {
  const hasWordSpeakers = item.wordStamps?.some((w) => !!w.speaker);
  if (item.speakers?.length && !(item.modelId === "grok-stt-live" && hasWordSpeakers)) {
    return item.speakers;
  }
  const out: SpeakerSeg[] = [];
  for (const w of item.wordStamps as WordStamp[]) {
    if (!w.speaker) continue;
    const last = out[out.length - 1];
    if (last?.speaker === w.speaker) {
      last.text += `${shouldJoinWithSpace(last.text, w.word) ? " " : ""}${w.word}`;
      last.end = w.end;
    } else {
      out.push({ speaker: w.speaker, text: w.word, start: w.start, end: w.end });
    }
  }
  return out;
}

function shouldJoinWithSpace(current: string, next: string): boolean {
  const prev = [...current.trimEnd()].pop();
  const first = [...next.trimStart()][0];
  if (!prev || !first) return false;
  if (isUnspacedScript(prev) && isUnspacedScript(first)) return false;
  if (isNoSpaceBefore(first) || isNoSpaceAfter(prev)) return false;
  return true;
}

function isUnspacedScript(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x3040 && cp <= 0x309f) ||
    (cp >= 0x30a0 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af)
  );
}

function isNoSpaceBefore(ch: string): boolean {
  return ".,!?:;)]}、。，．！？：；）］｝」』".includes(ch);
}

function isNoSpaceAfter(ch: string): boolean {
  return "([{（［｛「『".includes(ch);
}

/** Which expanded-card tab is shown. */
type TabKey = "text" | "stamps" | "speakers";

/** The active tab's content formatted for the clipboard. */
function copyTextFor(item: HistoryItem, tab: TabKey): string {
  if (tab === "stamps") {
    return item.wordStamps.map((w) => `[${tcLabel(w.start)}] ${w.word}`).join("\n");
  }
  if (tab === "speakers") {
    return speakerSegments(item).map((s) => `${speakerLabel(s.speaker)}: ${s.text}`).join("\n\n");
  }
  return item.transcript;
}
function fmtBytes(n: number): string {
  if (n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A chip describing a non-done transcription state, or null when done. */
function statusChip(status: string): { label: string; cls: string } | null {
  switch (status) {
    case "recording":
      return { label: t("history.statusRecording"), cls: "busy" };
    case "transcribing":
      return { label: t("history.statusTranscribing"), cls: "busy" };
    case "failed":
      return { label: t("history.statusFailed"), cls: "err" };
    case "needs_transcription":
      return { label: t("history.statusNeeds"), cls: "err" };
    default:
      return null;
  }
}

/** Transcript text, or a state placeholder when there isn't one yet. */
function previewText(item: HistoryItem): string {
  if (item.transcript?.trim()) return item.transcript;
  switch (item.status) {
    case "recording":
      return t("history.recording");
    case "transcribing":
      return t("history.transcribing");
    case "failed":
      return t("history.failed");
    case "needs_transcription":
      return t("history.needsTranscription");
    default:
      return "—";
  }
}

/* ---- inline icons (stroke, currentColor) ---- */
type IcoProps = { size?: number };
const Svg = (
  p: { size: number; fill?: boolean; children: React.ReactNode },
) => (
  <svg
    width={p.size}
    height={p.size}
    viewBox="0 0 24 24"
    fill={p.fill ? "currentColor" : "none"}
    stroke={p.fill ? "none" : "currentColor"}
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {p.children}
  </svg>
);
const IcoSearch = ({ size = 16 }: IcoProps) => (
  <Svg size={size}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Svg>
);
const IcoClose = ({ size = 14 }: IcoProps) => (
  <Svg size={size}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);
const IcoCopy = ({ size = 14 }: IcoProps) => (
  <Svg size={size}>
    <rect x="9" y="9" width="11" height="11" rx="1" />
    <path d="M5 15V5a1 1 0 0 1 1-1h10" />
  </Svg>
);
const IcoCheck = ({ size = 14 }: IcoProps) => (
  <Svg size={size}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);
const IcoPlay = ({ size = 13 }: IcoProps) => (
  <Svg size={size} fill>
    <path d="M7 5v14l11-7z" />
  </Svg>
);
const IcoStop = ({ size = 13 }: IcoProps) => (
  <Svg size={size} fill>
    <rect x="6" y="6" width="12" height="12" rx="1" />
  </Svg>
);
const IcoRerun = ({ size = 14 }: IcoProps) => (
  <Svg size={size}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v5h-5" />
  </Svg>
);
const IcoTrash = ({ size = 14 }: IcoProps) => (
  <Svg size={size}>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6" />
  </Svg>
);
const IcoFolder = ({ size = 14 }: IcoProps) => (
  <Svg size={size}>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </Svg>
);
const IcoMic = ({ size = 40 }: IcoProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8" />
  </svg>
);
const IcoAlert = ({ size = 38 }: IcoProps) => (
  <Svg size={size}>
    <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0z" />
    <path d="M12 9v4M12 17h.01" />
  </Svg>
);

/** Icon button with a portaled vx-tip tooltip, matching ProviderChip's pattern.
 *  When `pinned` is true the tip stays visible even on mouse-leave — used by the
 *  delete button for its click-to-confirm flow. */
function TipBtn({
  className,
  disabled,
  onClick,
  tip,
  pinned,
  children,
}: {
  className: string;
  disabled?: boolean;
  onClick: (e: React.MouseEvent) => void;
  tip: string;
  pinned?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const pinnedRef = useRef(false);
  pinnedRef.current = !!pinned;

  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 12), window.innerWidth - 12);
    setPos({ x, y: r.top });
  }, []);

  useEffect(() => {
    if (!pos) return;
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [pos, place]);

  useEffect(() => {
    if (pinned) place();
  }, [pinned, place]);

  const show = useCallback(() => {
    place();
  }, [place]);

  const hide = useCallback(() => {
    if (pinnedRef.current) return;
    setPos(null);
  }, []);

  return (
    <button
      ref={ref}
      type="button"
      className={className}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={show}
      onMouseLeave={hide}
      aria-label={tip}
    >
      {children}
      {pos && tip
        ? createPortal(
            <span className="vx-tip" style={{ left: pos.x, top: pos.y }}>
              {tip}
            </span>,
            document.body,
          )
        : null}
    </button>
  );
}

/** Provider brand chip with mode tooltip (reuses the shared `.prov` class).
 *  The tooltip is rendered through a portal with `position: fixed` so it escapes
 *  the panel's scroll container (`overflow-y: auto` / `overflow-x: hidden`) instead
 *  of being clipped at the panel edge. Because a fixed/portaled element doesn't
 *  extend the scrollable area, this never introduces a stray scrollbar. */
function ProviderChip({ provider, mode, size = 15 }: { provider?: string; mode?: string; size?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Anchor centred on the chip, clamped to the viewport so a long label is
    // always fully visible rather than running off-screen.
    const x = Math.min(Math.max(r.left + r.width / 2, 12), window.innerWidth - 12);
    setTip({ x, y: r.top });
  }, []);

  // Keep the tooltip glued to the chip while it's shown (the chip can move under
  // a scroll or resize since the portal lives outside the scroll container).
  useEffect(() => {
    if (!tip) return;
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [tip, place]);

  if (!provider) return null;
  return (
    <span
      ref={ref}
      className="prov"
      style={{ width: size + 8, height: size + 8 }}
      onMouseEnter={mode ? place : undefined}
      onMouseLeave={mode ? () => setTip(null) : undefined}
    >
      <ProviderLogo id={provider} size={size} />
      {mode && tip
        ? createPortal(
            <span className="vx-tip" style={{ left: tip.x, top: tip.y }}>
              {mode}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

type ActiveAudio = {
  id: number;
  audio: HTMLAudioElement;
};

export function HistoryPanel({
  history,
  modes,
  registry,
  providers,
  onChange,
  go,
  stopToken = 0,
  transitioning = false,
  onSection,
}: {
  history: HistoryItem[] | null | undefined;
  modes: Mode[];
  registry: Registry | null;
  providers: ProviderStatus;
  onChange: () => void;
  go: (panel: string) => void;
  stopToken?: number;
  /** True while the panel-switch animation is running. Used to defer the heavy
   *  card render until the switch settles so opening Home feels instant. */
  transitioning?: boolean;
  /** Reports the day group nearest the top so the header reads "// HOME / TODAY". */
  onSection?: (s: { label: string; desc: string } | null) => void;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  // Defer the (heavy) card list until the panel-switch animation settles, so
  // tabbing into Home is instant: paint the skeleton first, then the list. Starts
  // settled when we mount outside a transition (e.g. cold app start on Home).
  const [settled, setSettled] = useState(!transitioning);
  const [tab, setTab] = useState<TabKey>("text");
  const [copied, setCopied] = useState<number | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);
  const [rerunFor, setRerunFor] = useState<number | null>(null);
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  // Soft pre-run confirm for xAI long-file diarization (which mode the user picked).
  const [warnFor, setWarnFor] = useState<{ id: number; modeId: string } | null>(null);
  // Cards whose last re-run requested diarization but got no speaker labels.
  const [diarDropped, setDiarDropped] = useState<Set<number>>(new Set());
  // Lazily-fetched word/speaker detail per recording id (the arrays the list
  // omits, §4.1). Populated when a card expands; reused while it stays open.
  const [detail, setDetail] = useState<Map<number, { wordStamps: WordStamp[]; speakers: SpeakerSeg[] }>>(
    () => new Map(),
  );
  // Search — the only list control on Home.
  const [query, setQuery] = useState("");
  // Batch rendering: render a page of cards and grow as the sentinel scrolls in.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Last day reported to the header scroll-spy (avoids redundant onSection calls).
  const lastDay = useRef<string | null>(null);
  // No error signal exists in props today; default false. RETRY calls onChange().
  // Surfaced for the verification phase to wire to a real archive-read error.
  const [archiveError] = useState(false);
  const copyTref = useRef<number | undefined>(undefined);
  const audioRef = useRef<ActiveAudio | null>(null);
  const playSeq = useRef(0);

  const stopPlayback = useCallback((updateState = true) => {
    playSeq.current += 1;
    const active = audioRef.current;
    if (active) {
      active.audio.pause();
      active.audio.removeAttribute("src");
      active.audio.load();
      audioRef.current = null;
    }
    if (updateState) setPlaying(null);
  }, []);

  useEffect(() => () => stopPlayback(false), [stopPlayback]);

  useEffect(() => {
    if (stopToken > 0) stopPlayback();
  }, [stopPlayback, stopToken]);

  // A new search starts the window over from the first page.
  useEffect(() => setVisibleCount(PAGE_SIZE), [query]);

  // Collapsing a card resets its transient per-card UI (incl. the active tab).
  // The diarization-dropped notice persists across collapse — it's a result of the
  // last run, cleared only by a re-run that succeeds (or one that drops again).
  useEffect(() => {
    setRerunFor(null);
    setConfirmDel(null);
    setWarnFor(null);
    setTab("text");
  }, [expanded]);

  // Cancel delete confirmation on click outside the delete button.
  useEffect(() => {
    if (confirmDel === null) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".hm-actbtn--confirm")) {
        setConfirmDel(null);
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [confirmDel]);

  // Fetch word/speaker detail for the expanded card if it has any and we haven't
  // already. The list ships only boolean flags; the (possibly large) arrays load
  // on demand here so a big diarized archive doesn't pay for them up front.
  useEffect(() => {
    if (expanded == null) return;
    const item = (history ?? []).find((h) => h.id === expanded);
    if (!item || !(item.hasWordStamps || item.hasSpeakers)) return;
    if (detail.has(expanded)) return;
    let cancelled = false;
    getHistoryDetail(expanded)
      .then((d) => {
        if (!cancelled) setDetail((prev) => new Map(prev).set(expanded, d));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [expanded, history, detail]);

  async function doCopy(e: React.MouseEvent, item: HistoryItem, text?: string) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text ?? item.transcript);
    } catch {
      /* ignore */
    }
    try {
      await incrementCopy(item.id);
      onChange();
    } catch {
      /* backend may be a stub */
    }
    setCopied(item.id);
    window.clearTimeout(copyTref.current);
    copyTref.current = window.setTimeout(() => setCopied(null), 1100);
  }

  function doReveal(e: React.MouseEvent, _item: HistoryItem) {
    e.stopPropagation();
  }

  async function doPlay(e: React.MouseEvent, item: HistoryItem) {
    e.stopPropagation();
    if (item.audioStatus !== "ready") return;
    if (playing === item.id) {
      stopPlayback();
      return;
    }
    stopPlayback();
    const seq = playSeq.current;
    setPlaying(item.id);
    try {
      const url = convertFileSrc(item.audioPath);
      const a = new Audio(url);
      a.preload = "metadata";
      audioRef.current = { id: item.id, audio: a };
      a.onended = () => {
        if (seq !== playSeq.current) return;
        audioRef.current = null;
        setPlaying(null);
      };
      a.onerror = () => {
        if (seq === playSeq.current) stopPlayback();
      };
      await a.play();
      if (seq !== playSeq.current) {
        a.pause();
      }
    } catch (err) {
      console.error("playback failed", err);
      if (seq === playSeq.current) stopPlayback();
    }
  }

  async function doDelete(e: React.MouseEvent, item: HistoryItem) {
    e.stopPropagation();
    // Stop playback first: the deleted WAV must not keep playing from memory.
    if (audioRef.current?.id === item.id) stopPlayback();
    try {
      await deleteRecording(item.id);
      onChange();
    } catch {
      /* ignore */
    }
    setConfirmDel(null);
    // Collapse the (now-removed) card so the rest of the list leaves its dimmed
    // focus state — otherwise `expanded` still points at the deleted id.
    setExpanded(null);
  }

  async function doRerun(e: React.MouseEvent, item: HistoryItem, modeId: string) {
    e.stopPropagation();
    setBusy(item.id);
    setRerunFor(null);
    setWarnFor(null);
    try {
      const res = await retranscribe(item.id, modeId);
      onChange();
      // The re-run rewrote this recording's words/speakers — refresh its detail.
      getHistoryDetail(item.id)
        .then((d) => setDetail((prev) => new Map(prev).set(item.id, d)))
        .catch(() => {});
      // Persist (or clear) the "no speaker labels" notice for this card based on
      // what the just-completed re-run actually returned.
      setDiarDropped((prev) => {
        const next = new Set(prev);
        if (res.diarizationDropped) next.add(item.id);
        else next.delete(item.id);
        return next;
      });
    } catch (err) {
      console.error("re-run failed", err);
    } finally {
      setBusy(null);
    }
  }

  // ---- readiness signal: null/undefined history = still loading ----
  const loading = history == null;
  const items: HistoryItem[] = history ?? [];

  // File-capable modes are the only ones that can re-transcribe a saved file.
  const fileModes = modes.filter((m) => modelById(registry, m.model)?.canFile);
  const modeLabel = (m: Mode) => `${m.name} · ${modelById(registry, m.model)?.label ?? m.model}`;

  // Precompute a lowercased search haystack + day label per item, once per history
  // change — not per render and not per keystroke (§5.2/§5.3).
  const searchIndex = useMemo(
    () =>
      items.map((h) => ({
        item: h,
        hay: `${h.transcript} ${h.appName ?? ""} ${h.website ?? ""} ${h.modeName}`.toLowerCase(),
        day: dayLabel(h.createdAt),
      })),
    [items],
  );

  // Defer the query so typing stays responsive while the (potentially large) list
  // filters against the precomputed haystacks (§5.2).
  const deferredQuery = useDeferredValue(query);
  const q = deferredQuery.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? searchIndex.filter((e) => e.hay.includes(q)) : searchIndex),
    [searchIndex, q],
  );

  // ---- derived stats (top model / spend / minutes), memoized over all items ----
  const stats = useMemo(() => {
    let totalSecs = 0;
    let totalCost = 0;
    const modelCounts = new Map<string, number>();
    for (const h of items) {
      totalSecs += h.durationSecs || 0;
      totalCost += estimateCost(modelById(registry, h.modelId), h.durationSecs);
      if (h.modelId) modelCounts.set(h.modelId, (modelCounts.get(h.modelId) ?? 0) + 1);
    }
    let topModelId: string | null = null;
    let topCount = 0;
    for (const [id, c] of modelCounts) {
      if (c > topCount) {
        topCount = c;
        topModelId = id;
      }
    }
    return { totalSecs, totalCost, topModelId };
  }, [items, registry]);
  const topModel = stats.topModelId ? modelById(registry, stats.topModelId) : undefined;
  const topModelLabel = topModel?.label ?? stats.topModelId ?? "";
  const totalMinutes = Math.round(stats.totalSecs / 60);
  const totalHours = (stats.totalSecs / 3600).toFixed(1);
  const spendLabel = stats.totalCost > 0 ? formatCost(stats.totalCost) : "$0.00";

  // Window the filtered list, then group the visible slice by day — memoized so it
  // only recomputes when the filter result or the window size changes, with the day
  // labels already computed in searchIndex (no per-render Date building, §5.3).
  const { groups, hasMore } = useMemo(() => {
    const shown = filtered.slice(0, visibleCount);
    const gs: { day: string; items: HistoryItem[] }[] = [];
    for (const e of shown) {
      const g = gs.find((x) => x.day === e.day);
      if (g) g.items.push(e.item);
      else gs.push({ day: e.day, items: [e.item] });
    }
    return { groups: gs, hasMore: visibleCount < filtered.length };
  }, [filtered, visibleCount]);
  // Re-run the scroll-spy when the set of day groups changes (load/search/grow).
  const dayKey = groups.map((g) => g.day).join("|");

  // Grow the window as the bottom sentinel scrolls into view. The scroll root is
  // the panel-body; re-observing on each bump lets a tall viewport keep filling
  // until the sentinel is pushed out of view (or nothing is left).
  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) setVisibleCount((n) => n + PAGE_SIZE);
      },
      { root, rootMargin: "400px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
    // `settled` is a dep so the observer re-attaches once the real list (and its
    // sentinel) mounts after the deferred render. Without it, tabbing back into a
    // panel whose data is already loaded leaves the sentinel unobserved — neither
    // `hasMore` nor `visibleCount` changes on settle — so load-on-scroll dies.
  }, [hasMore, visibleCount, settled]);

  // Header scroll-spy: report the day group nearest the top of the scroll
  // container so the content-frame title tracks where you are (`// HOME / TODAY`).
  // Mirrors the Settings scroll-spy. desc is "" so SYS.DESC keeps the Home blurb.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const report = () => {
      const line = root.getBoundingClientRect().top + 90;
      let active: string | null = null;
      for (const node of root.querySelectorAll<HTMLElement>("[data-day]")) {
        if (node.getBoundingClientRect().top <= line) active = node.dataset.day ?? active;
      }
      if (active !== lastDay.current) {
        lastDay.current = active;
        onSection?.(active ? { label: active, desc: "" } : null);
      }
    };
    report();
    root.addEventListener("scroll", report, { passive: true });
    return () => root.removeEventListener("scroll", report);
    // `settled` is a dep so the spy re-runs once the real list (and scroll root)
    // mounts after the deferred render — otherwise the day title wouldn't appear
    // until the first scroll.
  }, [onSection, dayKey, settled]);

  // Render the card list once the switch animation has settled.
  useEffect(() => {
    if (!transitioning) setSettled(true);
  }, [transitioning]);

  // ---- ERROR state (local flag; RETRY → onChange) ----
  if (archiveError) {
    return (
      <div className="panel-body hm">
        <div className="hm-state">
          <div className="hm-state-inner">
            <div className="hm-state-ico err">
              <IcoAlert size={38} />
            </div>
            <div className="hm-state-title sm">ARCHIVE UNREACHABLE</div>
            <p className="hm-state-body">
              VOXCTL could not read the local transmission log. The store may be locked by another
              process.
            </p>
            <button type="button" className="vx-btn vx-btn--mag" onClick={() => onChange()}>
              <IcoRerun size={14} />
              RETRY
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- LOADING skeleton ---- (also shown while a panel switch settles)
  if (loading || !settled) {
    return (
      <div className="panel-body hm">
        <div className="hm-skel-day">
          <span className="skel" style={{ height: 12, width: 90 }} />
          <span className="hm-skel-line" />
        </div>
        {[0, 1, 2].map((i) => (
          <div className="hm-skel-card" key={i}>
            <span className="skel" style={{ height: 14, width: 60 }} />
            <div className="hm-skel-lines">
              <span className="skel" style={{ height: 12, width: "92%" }} />
              <span className="skel" style={{ height: 12, width: "78%" }} />
              <span className="skel" style={{ height: 12, width: "40%" }} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  // ---- EMPTY-ALL state (loaded, nothing archived) ----
  if (items.length === 0) {
    return (
      <div className="panel-body hm">
        <div className="hm-state">
          <div className="hm-state-inner">
            <div className="hm-state-ico">
              <IcoMic size={40} />
            </div>
            <div className="hm-state-title">TAKE CONTROL OF YOUR VOICE</div>
            <p className="hm-state-body">
              No transmissions leave your machine. Hold the capture shortcut and speak — your first
              transcription appears here.
            </p>
            <div className="hm-callout">
              <span className="hm-callout-lbl">HOLD</span>
              <span className="hm-kbd">OPTION</span>
              <span className="hm-callout-plus">+</span>
              <span className="hm-kbd">SPACE</span>
              <span className="hm-callout-lbl mag">TO RECORD</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="panel-body hm" ref={scrollRef}>
      {/* stats strip */}
      <div className="hm-stats">
        <div className="hm-stat">
          <span className="hm-stat-k">TOP MODEL</span>
          {topModelLabel ? (
            <span className="hm-stat-model">
              <ProviderChip provider={topModel?.provider} mode={topModelLabel} size={15} />
              <span className="hm-stat-v sm">{topModelLabel}</span>
            </span>
          ) : (
            <span className="hm-stat-v sm">—</span>
          )}
        </div>
        <div className="hm-stat">
          <span className="hm-stat-k">TOTAL SPEND</span>
          <span className="hm-stat-row">
            <span className="hm-stat-v mag">{spendLabel}</span>
            <span className="hm-stat-sub">LOCAL EST</span>
          </span>
        </div>
        <div className="hm-stat">
          <span className="hm-stat-k">MINUTES CAPTURED</span>
          <span className="hm-stat-row">
            <span className="hm-stat-v">{totalMinutes}</span>
            <span className="hm-stat-sub">≈ {totalHours} HRS</span>
          </span>
        </div>
      </div>

      {/* toolbar: transcript search only */}
      <div className="hm-toolbar">
        <div className="hm-search">
          <span className="hm-search-ico">
            <IcoSearch size={17} />
          </span>
          <input
            value={query}
            placeholder={t("history.search")}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="vx-ico hm-search-clear"
              title="Clear"
              onClick={() => setQuery("")}
            >
              <IcoClose size={15} />
            </button>
          ) : null}
        </div>
      </div>

      {groups.length === 0 ? (
        // ---- EMPTY-SEARCH state (filters exclude everything) ----
        <div className="hm-state">
          <div className="hm-state-inner">
            <div className="hm-state-ico dim">
              <IcoSearch size={34} />
            </div>
            <div className="hm-state-sub">NO TRANSCRIPTS MATCH</div>
            <p className="hm-state-body">
              Nothing found{q ? <> for “<span className="mag">{query.trim()}</span>”</> : null}. Try a
              different term or clear the filters.
            </p>
          </div>
        </div>
      ) : (
        groups.map((g) => (
          <div className="hm-group" key={g.day} data-day={g.day}>
            <div className="hm-day">
              <span className="hm-day-label">{g.day}</span>
              <span className="hm-day-line" />
            </div>
            <div className="hm-list">
              {g.items.map((item) => {
                const exp = expanded === item.id;
                const dim = expanded !== null && !exp;
                const cp = copied === item.id;
                const ctx = item.appName || item.website;
                const sc = statusChip(item.status);
                const size = fmtBytes(item.audioBytes);
                const audioReady = item.audioStatus === "ready";
                const took = tookLabel(item.transcriptionMs);
                const provider = modelById(registry, item.modelId)?.provider;
                const costVal = estimateCost(modelById(registry, item.modelId), item.durationSecs);
                const cost = costVal > 0 ? formatCost(costVal) : "";
                const hasText = !!item.transcript?.trim();
                // Structured-data tabs gate on the cheap list flags; the arrays
                // themselves are fetched lazily on expand (§4.1).
                const tabs: { key: TabKey; label: string }[] = [
                  { key: "text", label: t("history.tabText") },
                ];
                if (item.hasWordStamps) tabs.push({ key: "stamps", label: t("history.tabStamps") });
                if (item.hasSpeakers) tabs.push({ key: "speakers", label: t("history.tabSpeakers") });
                const effTab: TabKey = tabs.some((x) => x.key === tab) ? tab : "text";
                // Lazily-loaded detail for the expanded card (empty until it arrives).
                const d = exp ? detail.get(item.id) : undefined;
                const expWordStamps = d?.wordStamps ?? [];
                const expSpeakers = d?.speakers ?? [];
                const expSpeakerSegs = exp
                  ? speakerSegments({ ...item, wordStamps: expWordStamps, speakers: expSpeakers })
                  : [];
                const detailLoading = exp && (item.hasWordStamps || item.hasSpeakers) && d == null;
                const copyItem: HistoryItem = { ...item, wordStamps: expWordStamps, speakers: expSpeakers };
                return (
                  <div
                    key={item.id}
                    className={"tcard" + (exp ? " tcard--open" : dim ? " tcard--dim" : "")}
                  >
                    {/* collapsed header — click toggles expansion */}
                    <div
                      className="hm-card-head"
                      onClick={() => setExpanded(exp ? null : item.id)}
                    >
                      <span className="hm-time">{timeLabel(item.createdAt)}</span>
                      <div className="hm-preview-wrap">
                        {exp ? null : (
                          <p className={"hm-preview" + (hasText ? "" : " placeholder")}>
                            {previewText(item)}
                          </p>
                        )}
                      </div>
                      <div className="hm-head-right">
                        {item.status === "recording" ? (
                          <CardRecTimer createdAt={item.createdAt} />
                        ) : null}
                        {sc ? <span className={"hm-status " + sc.cls}>{sc.label}</span> : null}
                        {!exp ? (
                          <div
                            className="hovctl"
                            style={{ display: "flex", alignItems: "center", gap: 12 }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span className="tipwrap">
                              <button
                                type="button"
                                className="vx-ico"
                                disabled={!hasText}
                                onClick={(e) => doCopy(e, item)}
                              >
                                {cp ? (
                                  <span style={{ color: "var(--mag)" }}>
                                    <IcoCheck size={15} />
                                  </span>
                                ) : (
                                  <IcoCopy size={15} />
                                )}
                              </button>
                              {hasText ? (
                                <span className="tip">
                                  {cp ? t("history.copied") : t("history.copy")}
                                </span>
                              ) : null}
                            </span>
                            <ProviderChip provider={provider} mode={item.modeName} size={15} />
                          </div>
                        ) : null}
                      </div>
                    </div>

                    {/* expanded body */}
                    {exp ? (
                      <div className="hm-body">
                        {diarDropped.has(item.id) ? (
                          <div className="hm-notice">
                            <span className="hm-notice-ico">
                              <IcoAlert size={16} />
                            </span>
                            <div className="hm-notice-text">
                              <div className="hm-notice-title">
                                {t("history.diarizationDropped.title")}
                              </div>
                              <p className="hm-notice-body">
                                {t("history.diarizationDropped.body")}
                              </p>
                            </div>
                          </div>
                        ) : null}
                        {tabs.length > 1 ? (
                          <div className="hm-tabs">
                            {tabs.map((tb) => (
                              <button
                                key={tb.key}
                                type="button"
                                className={"vx-tab" + (effTab === tb.key ? " vx-tab--on" : "")}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setTab(tb.key);
                                }}
                              >
                                {tb.label}
                              </button>
                            ))}
                          </div>
                        ) : null}

                        {detailLoading && (effTab === "stamps" || effTab === "speakers") ? (
                          <div className="hm-text placeholder">…</div>
                        ) : effTab === "stamps" ? (
                          <div className="hm-stamps">
                            {expWordStamps.map((w, i) => (
                              <span key={`${i}-${w.start}`} className="hm-stamp">
                                <span className="hm-stamp-t">{tcLabel(w.start)}</span>
                                <span className="hm-stamp-w">{w.word}</span>
                              </span>
                            ))}
                          </div>
                        ) : effTab === "speakers" ? (
                          <div className="hm-speakers">
                            {expSpeakerSegs.map((s, i) => (
                              <div key={`${i}-${s.start}`} className="hm-spk">
                                <span className="hm-spk-k">{speakerLabel(s.speaker)}</span>
                                <span className="hm-spk-t">{s.text}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className={"hm-text" + (hasText ? "" : " placeholder")}>
                            {previewText(item)}
                          </div>
                        )}

                        {/* action toolbar */}
                        <div className="hm-actbar">
                          <div className="hm-actgrp">
                            <TipBtn
                              className="hm-actbtn hm-actbtn--mag"
                              disabled={!hasText}
                              onClick={(e) => doCopy(e, item, copyTextFor(copyItem, effTab))}
                              tip={cp ? t("history.copied") : t("history.copy")}
                            >
                              {cp ? <IcoCheck size={14} /> : <IcoCopy size={14} />}
                            </TipBtn>
                            <TipBtn
                              className="hm-actbtn"
                              disabled={!audioReady}
                              onClick={(e) => doPlay(e, item)}
                              tip={playing === item.id ? t("history.stop") : t("history.play")}
                            >
                              {playing === item.id ? <IcoStop size={13} /> : <IcoPlay size={13} />}
                            </TipBtn>
                            <TipBtn
                              className="hm-actbtn"
                              disabled={!audioReady}
                              onClick={(e) => doReveal(e, item)}
                              tip={t("history.reveal")}
                            >
                              <IcoFolder size={14} />
                            </TipBtn>
                            <div className="hm-menu-wrap">
                              <TipBtn
                                className="hm-actbtn"
                                disabled={busy === item.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setRerunFor(rerunFor === item.id ? null : item.id);
                                }}
                                tip={t("history.retranscribe")}
                              >
                                <IcoRerun size={14} />
                              </TipBtn>
                              {rerunFor === item.id ? (
                                <div className="hm-menu" onClick={(e) => e.stopPropagation()}>
                                  {fileModes.length > 0 ? (
                                    <>
                                      <div className="hm-menu-head">RE-RUN THROUGH MODE</div>
                                      {fileModes.map((m) => {
                                        const mp = modelById(registry, m.model)?.provider;
                                        const usable = modeUsable(registry, providers, m.model);
                                        return (
                                          <button
                                            key={m.id}
                                            type="button"
                                            className={"hm-menu-item" + (usable ? "" : " is-locked")}
                                            title={usable ? t("history.rerunHeadline") : undefined}
                                            onClick={(e) => {
                                              if (!usable) {
                                                e.stopPropagation();
                                                setRerunFor(null);
                                                go("settings");
                                                return;
                                              }
                                              if (
                                                shouldWarnXaiLongDiarization(registry, m, item.durationSecs)
                                              ) {
                                                e.stopPropagation();
                                                setRerunFor(null);
                                                setWarnFor({ id: item.id, modeId: m.id });
                                                return;
                                              }
                                              doRerun(e, item, m.id);
                                            }}
                                          >
                                            {mp ? (
                                              <span className="hm-menu-logo">
                                                <ProviderLogo id={mp} size={13} />
                                              </span>
                                            ) : null}
                                            {modeLabel(m)}
                                            {usable ? null : (
                                              <span className="hm-menu-lock">{t("history.addKey")}</span>
                                            )}
                                          </button>
                                        );
                                      })}
                                    </>
                                  ) : (
                                    <button
                                      type="button"
                                      className="hm-menu-item"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setRerunFor(null);
                                        go("modes");
                                      }}
                                    >
                                      ＋ {t("history.rerunCreate")}
                                    </button>
                                  )}
                                </div>
                              ) : null}
                              {warnFor?.id === item.id ? (
                                <div className="hm-warn" onClick={(e) => e.stopPropagation()}>
                                  <div className="hm-warn-head">
                                    {t("history.xaiLongDiarizationWarning.title")}
                                  </div>
                                  <p className="hm-warn-body">
                                    {t("history.xaiLongDiarizationWarning.body")}
                                  </p>
                                  <div className="hm-warn-actions">
                                    <button
                                      type="button"
                                      className="vx-btn vx-btn--mag"
                                      onClick={(e) => doRerun(e, item, warnFor.modeId)}
                                    >
                                      {t("history.xaiLongDiarizationWarning.continue")}
                                    </button>
                                    <button
                                      type="button"
                                      className="vx-btn"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setWarnFor(null);
                                        setRerunFor(item.id);
                                      }}
                                    >
                                      {t("history.xaiLongDiarizationWarning.chooseMode")}
                                    </button>
                                    <button
                                      type="button"
                                      className="vx-btn"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setWarnFor(null);
                                      }}
                                    >
                                      {t("history.xaiLongDiarizationWarning.cancel")}
                                    </button>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          </div>
                          <TipBtn
                            className={
                              "hm-actbtn hm-actbtn--danger" +
                              (confirmDel === item.id ? " hm-actbtn--confirm" : "")
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              if (confirmDel === item.id) {
                                doDelete(e, item);
                              } else {
                                setConfirmDel(item.id);
                              }
                            }}
                            tip={
                              confirmDel === item.id
                                ? t("history.deleteConfirm")
                                : t("modes.delete")
                            }
                            pinned={confirmDel === item.id}
                          >
                            <IcoTrash size={14} />
                          </TipBtn>
                        </div>

                        {/* metadata row */}
                        <div className="hm-meta">
                          {provider ? (
                            <span className="hm-meta-prov">
                              <ProviderChip provider={provider} mode={item.modeName} size={15} />
                              <span className="hm-meta-k">{provider.toUpperCase()}</span>
                            </span>
                          ) : null}
                          {ctx ? (
                            <span className="hm-meta-cell">
                              <span className="hm-meta-k">APP</span>
                              <span className="hm-meta-v">{ctx.toUpperCase()}</span>
                            </span>
                          ) : null}
                          <span className="hm-meta-cell">
                            <span className="hm-meta-k">DUR</span>
                            <span className="hm-meta-v">{durLabel(item.durationSecs)}</span>
                          </span>
                          {took ? (
                            <span className="hm-meta-cell">
                              <span className="hm-meta-k">{t("history.took")}</span>
                              <span className="hm-meta-v">{took}</span>
                            </span>
                          ) : null}
                          {size ? (
                            <span className="hm-meta-cell">
                              <span className="hm-meta-k">SIZE</span>
                              <span className="hm-meta-v">{size}</span>
                            </span>
                          ) : null}
                          {cost ? (
                            <span className="hm-meta-cell">
                              <span className="hm-meta-k">COST</span>
                              <span className="hm-meta-v mag">{cost}</span>
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
      {hasMore ? <div ref={sentinelRef} className="hm-sentinel" aria-hidden="true" /> : null}
    </div>
  );
}
