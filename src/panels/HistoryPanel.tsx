import { useRef, useState } from "react";
import { t } from "../i18n";
import { langLabel, LANGUAGES } from "../lib/languages";
import {
  deleteRecording,
  incrementCopy,
  readAudio,
  retranscribe,
  toggleFavorite,
} from "../lib/ipc";
import type { HistoryItem } from "../lib/types";

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

export function HistoryPanel({ history, onChange }: { history: HistoryItem[]; onChange: () => void }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);
  const [rerunFor, setRerunFor] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const copyTref = useRef<number | undefined>(undefined);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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
      audioRef.current?.pause();
      audioRef.current = null;
      setPlaying(null);
      return;
    }
    try {
      const bytes = await readAudio(item.id);
      const blob = new Blob([new Uint8Array(bytes)], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      audioRef.current = a;
      a.onended = () => {
        URL.revokeObjectURL(url);
        setPlaying(null);
      };
      await a.play();
      setPlaying(item.id);
    } catch (err) {
      console.error("playback failed", err);
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

  async function doRetranscribe(e: React.MouseEvent, item: HistoryItem, lang: string) {
    e.stopPropagation();
    setBusy(item.id);
    setRerunFor(null);
    try {
      await retranscribe(item.id, lang === "auto" ? null : lang);
      onChange();
    } catch (err) {
      console.error("retranscribe failed", err);
    } finally {
      setBusy(null);
    }
  }

  if (history.length === 0) {
    return (
      <div className="panel-body files">
        <div className="empty">{t("history.empty")}</div>
      </div>
    );
  }

  const groups: { day: string; items: HistoryItem[] }[] = [];
  for (const item of history) {
    const day = dayLabel(item.createdAt);
    const g = groups.find((x) => x.day === day);
    if (g) g.items.push(item);
    else groups.push({ day, items: [item] });
  }

  return (
    <div className="panel-body files">
      {groups.map((g) => (
        <div className="file-group" key={g.day}>
          <div className="file-group-head">{g.day}</div>
          {g.items.map((item) => {
            const exp = expanded === item.id;
            const cp = copied === item.id;
            const ctx = item.appName || item.website;
            return (
              <div
                key={item.id}
                className={"file-card" + (exp ? " expanded" : "")}
                onClick={() => setExpanded(exp ? null : item.id)}
              >
                <div className="file-head">
                  <div className="file-head-left">
                    <span className="file-time">{timeLabel(item.createdAt)}</span>
                    {item.favorite ? <span className="mode-badge">★</span> : null}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {item.modeName && item.modeName !== "—" ? (
                      <span className="file-chip mode">▸ {item.modeName.toUpperCase()}</span>
                    ) : null}
                    {ctx ? <span className="file-chip ctx">{ctx.toUpperCase()}</span> : null}
                    <span className="file-chip">{langLabel(item.language)}</span>
                  </div>
                </div>
                <p className="file-preview">{item.transcript || "—"}</p>
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
                      <select
                        className="set-select"
                        style={{ width: "auto", padding: "4px 8px" }}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => doRetranscribe(e as unknown as React.MouseEvent, item, e.target.value)}
                        defaultValue=""
                      >
                        <option value="" disabled>
                          LANG…
                        </option>
                        {LANGUAGES.map((l) => (
                          <option key={l.code} value={l.code}>
                            {l.label}
                          </option>
                        ))}
                      </select>
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
                    <span className="file-exp">⌄</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
