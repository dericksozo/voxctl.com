import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { t } from "../i18n";
import { langLabel } from "../lib/languages";
import {
  deleteRecording,
  deleteRecordings,
  incrementCopy,
  retranscribe,
  toggleFavorite,
} from "../lib/ipc";
import type { HistoryItem, Mode } from "../lib/types";
import { modelById, type Registry } from "../lib/registry";

const pad = (n: number) => String(n).padStart(2, "0");

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
const fmtCount = (n: number) => (n >= 10 ? "10+" : String(n));

function fmtBytes(n: number): string {
  if (n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A chip describing a non-done transcription state, or null when done. */
function statusChip(status: string): { label: string; cls: string } | null {
  switch (status) {
    case "transcribing":
      return { label: "⋯ " + t("history.statusTranscribing"), cls: " busy" };
    case "failed":
      return { label: "✕ " + t("history.statusFailed"), cls: " err" };
    case "needs_transcription":
      return { label: "⚠ " + t("history.statusNeeds"), cls: " err" };
    default:
      return null;
  }
}

/** Transcript text, or a state placeholder when there isn't one yet. */
function previewText(item: HistoryItem): string {
  if (item.transcript?.trim()) return item.transcript;
  switch (item.status) {
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

type ActiveAudio = {
  id: number;
  audio: HTMLAudioElement;
};

export function HistoryPanel({
  history,
  modes,
  registry,
  onChange,
  go,
  stopToken = 0,
}: {
  history: HistoryItem[];
  modes: Mode[];
  registry: Registry | null;
  onChange: () => void;
  go: (panel: string) => void;
  stopToken?: number;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);
  const [rerunFor, setRerunFor] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  // Search / filter
  const [query, setQuery] = useState("");
  const [appFilter, setAppFilter] = useState("");
  const [langFilter, setLangFilter] = useState("");
  const [favOnly, setFavOnly] = useState(false);
  // Bulk selection
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
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

  async function doCopy(e: React.MouseEvent, item: HistoryItem) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(item.transcript);
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

  async function doPlay(e: React.MouseEvent, item: HistoryItem) {
    e.stopPropagation();
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

  async function doFavorite(e: React.MouseEvent, item: HistoryItem) {
    e.stopPropagation();
    try {
      await toggleFavorite(item.id);
      onChange();
    } catch {
      /* ignore */
    }
  }

  async function doDelete(e: React.MouseEvent, item: HistoryItem) {
    e.stopPropagation();
    try {
      await deleteRecording(item.id);
      onChange();
    } catch {
      /* ignore */
    }
  }

  async function doRerun(e: React.MouseEvent, item: HistoryItem, modeId: string) {
    e.stopPropagation();
    setBusy(item.id);
    setRerunFor(null);
    try {
      await retranscribe(item.id, modeId);
      onChange();
    } catch (err) {
      console.error("re-run failed", err);
    } finally {
      setBusy(null);
    }
  }

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    try {
      await deleteRecordings([...selected]);
      onChange();
    } catch {
      /* ignore */
    }
    setSelected(new Set());
    setSelectMode(false);
  }

  // File-capable modes are the only ones that can re-transcribe a saved file.
  const fileModes = modes.filter((m) => modelById(registry, m.model)?.canFile);
  const modeLabel = (m: Mode) => `${m.name} · ${modelById(registry, m.model)?.label ?? m.model}`;

  // Distinct apps/languages present, for the filter dropdowns.
  const apps = [...new Set(history.map((h) => h.appName || h.website).filter(Boolean))] as string[];
  const langs = [...new Set(history.map((h) => h.language).filter(Boolean))];

  const q = query.trim().toLowerCase();
  const filtered = history.filter((h) => {
    if (favOnly && !h.favorite) return false;
    if (appFilter && (h.appName || h.website || "") !== appFilter) return false;
    if (langFilter && h.language !== langFilter) return false;
    if (q) {
      const hay = `${h.transcript} ${h.appName ?? ""} ${h.website ?? ""} ${h.modeName}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (history.length === 0) {
    return (
      <div className="panel-body files">
        <div className="empty">{t("history.empty")}</div>
      </div>
    );
  }

  const groups: { day: string; items: HistoryItem[] }[] = [];
  for (const item of filtered) {
    const day = dayLabel(item.createdAt);
    const g = groups.find((x) => x.day === day);
    if (g) g.items.push(item);
    else groups.push({ day, items: [item] });
  }

  return (
    <div className="panel-body files">
      <div className="files-toolbar">
        <input
          className="files-search"
          value={query}
          placeholder={t("history.search")}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        {apps.length > 0 ? (
          <select className="files-filter" value={appFilter} onChange={(e) => setAppFilter(e.target.value)}>
            <option value="">{t("history.filterApp")}</option>
            {apps.map((a) => (
              <option key={a} value={a}>
                {a.toUpperCase()}
              </option>
            ))}
          </select>
        ) : null}
        {langs.length > 1 ? (
          <select className="files-filter" value={langFilter} onChange={(e) => setLangFilter(e.target.value)}>
            <option value="">{t("history.filterLang")}</option>
            {langs.map((l) => (
              <option key={l} value={l}>
                {langLabel(l)}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          className={"files-chip" + (favOnly ? " on" : "")}
          onClick={() => setFavOnly((v) => !v)}
        >
          ★ {t("history.filterFav")}
        </button>
        <button
          type="button"
          className={"files-chip" + (selectMode ? " on" : "")}
          onClick={() => {
            setSelectMode((v) => !v);
            setSelected(new Set());
          }}
        >
          {t("history.select")}
        </button>
      </div>

      {selectMode ? (
        <div className="files-selbar">
          <span>{t("history.selectedCount", { n: selected.size })}</span>
          <button type="button" className="fa danger" disabled={selected.size === 0} onClick={deleteSelected}>
            ✕ {t("history.deleteSelected")}
          </button>
        </div>
      ) : null}

      {groups.length === 0 ? (
        <div className="empty">{t("history.noMatches")}</div>
      ) : (
        groups.map((g) => (
          <div className="file-group" key={g.day}>
            <div className="file-group-head">{g.day}</div>
            {g.items.map((item) => {
              const exp = expanded === item.id;
              const cp = copied === item.id;
              const ctx = item.appName || item.website;
              const sc = statusChip(item.status);
              const sel = selected.has(item.id);
              const size = fmtBytes(item.audioBytes);
              return (
                <div
                  key={item.id}
                  className={"file-card" + (exp ? " expanded" : "") + (sel ? " selected" : "")}
                  onClick={() => (selectMode ? toggleSelect(item.id) : setExpanded(exp ? null : item.id))}
                >
                  <div className="file-head">
                    <div className="file-head-left">
                      {selectMode ? <span className="file-check">{sel ? "☑" : "☐"}</span> : null}
                      <span className="file-time">{timeLabel(item.createdAt)}</span>
                      {item.favorite ? <span className="mode-badge">★</span> : null}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {sc ? <span className={"file-chip" + sc.cls}>{sc.label}</span> : null}
                      {item.modeName && item.modeName !== "—" ? (
                        <span className="file-chip mode">▸ {item.modeName.toUpperCase()}</span>
                      ) : null}
                      {ctx ? <span className="file-chip ctx">{ctx.toUpperCase()}</span> : null}
                      <span className="file-chip">{langLabel(item.language)}</span>
                    </div>
                  </div>
                  <p className={"file-preview" + (item.transcript?.trim() ? "" : " placeholder")}>
                    {previewText(item)}
                  </p>
                  {selectMode ? null : (
                    <div className="file-foot">
                      <div className="file-actions">
                        <button type="button" className={"fa" + (cp ? " copied" : "")} onClick={(e) => doCopy(e, item)}>
                          {cp ? "✓ " + t("history.copied") : "⧉ " + t("history.copy")}
                          {item.copyCount > 0 ? <span className="count">{fmtCount(item.copyCount)}</span> : null}
                        </button>
                        <button type="button" className="fa" onClick={(e) => doPlay(e, item)}>
                          {playing === item.id ? "■ " + t("history.stop") : "▶ " + t("history.play")}
                        </button>
                        <button
                          type="button"
                          className={"fa" + (item.favorite ? " fav" : "")}
                          onClick={(e) => doFavorite(e, item)}
                        >
                          {item.favorite ? "★" : "☆"} {t("history.favorite")}
                        </button>
                        {rerunFor === item.id ? (
                          fileModes.length > 0 ? (
                            <select
                              className="set-select"
                              style={{ width: "auto", padding: "4px 8px" }}
                              title={t("history.rerunHeadline")}
                              autoFocus
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => doRerun(e as unknown as React.MouseEvent, item, e.target.value)}
                              defaultValue=""
                            >
                              <option value="" disabled>
                                {t("history.rerunPick")}
                              </option>
                              {fileModes.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {modeLabel(m)}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <button
                              type="button"
                              className="fa"
                              onClick={(e) => {
                                e.stopPropagation();
                                setRerunFor(null);
                                go("modes");
                              }}
                            >
                              ＋ {t("history.rerunCreate")}
                            </button>
                          )
                        ) : (
                          <button
                            type="button"
                            className="fa"
                            disabled={busy === item.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              setRerunFor(item.id);
                            }}
                          >
                            {busy === item.id ? "↻ …" : "↻ " + t("history.retranscribe")}
                          </button>
                        )}
                        <button type="button" className="fa danger" onClick={(e) => doDelete(e, item)}>
                          ✕
                        </button>
                      </div>
                      <div className="file-meta2">
                        <span>{durLabel(item.durationSecs)}</span>
                        <span>
                          {item.words} {t("history.words")}
                        </span>
                        {size ? <span>{size}</span> : null}
                        <span className="file-exp">⌄</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}
