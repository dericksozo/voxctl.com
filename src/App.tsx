import { useCallback, useEffect, useRef, useState } from "react";
import "./styles/theme.css";
import { Frame, Logo, Qr } from "./components/Primitives";
import { Clock } from "./components/Clock";
import { VolumeMeter } from "./components/VolumeMeter";
import { Typewriter } from "./components/Typewriter";
import { DEFAULT_THEME, type Theme, TweaksPanel } from "./components/TweaksPanel";
import { HomePanel } from "./panels/HomePanel";
import { HistoryPanel } from "./panels/HistoryPanel";
import { ModesPanel } from "./panels/ModesPanel";
import { SettingsPanel } from "./panels/SettingsPanel";
import { useConfig } from "./hooks/useConfig";
import { useTauriEvent } from "./hooks/useTauriEvent";
import { t } from "./i18n";
import { EVT, type BackendError, type ModeChanged, type RecState } from "./lib/events";
import {
  getActiveMode,
  getPermissions,
  hasApiKey,
  listHistory,
  listModes,
} from "./lib/ipc";
import type { HistoryItem, Mode, PermissionStatus } from "./lib/types";

const pad = (n: number) => String(n).padStart(2, "0");

const MENU = [
  { id: "home", label: t("nav.home") },
  { id: "history", label: t("nav.history") },
  { id: "modes", label: t("nav.modes") },
  { id: "settings", label: t("nav.settings") },
];

export default function App() {
  const { config, ready } = useConfig();
  const [view, setView] = useState("home");
  const [phase, setPhase] = useState<"idle" | "closing" | "opening">("idle");
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  const [audioStopToken, setAudioStopToken] = useState(0);

  const [modes, setModes] = useState<Mode[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [activeMode, setActiveMode] = useState<Mode | null>(null);
  const [apiKeySet, setApiKeySet] = useState(false);
  const [perms, setPerms] = useState<PermissionStatus>({ microphone: true, accessibility: true });
  const [toast, setToast] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const timers = useRef<number[]>([]);
  const toastTimer = useRef<number | undefined>(undefined);

  const refreshModes = useCallback(() => {
    listModes().then(setModes).catch(() => {});
    getActiveMode().then(setActiveMode).catch(() => {});
  }, []);
  const refreshHistory = useCallback(() => {
    listHistory().then(setHistory).catch(() => {});
  }, []);
  const refreshApiKey = useCallback(() => {
    hasApiKey().then(setApiKeySet).catch(() => {});
  }, []);
  const refreshPerms = useCallback(() => {
    getPermissions().then(setPerms).catch(() => {});
  }, []);

  useEffect(() => {
    refreshModes();
    refreshHistory();
    refreshApiKey();
    refreshPerms();
  }, [refreshModes, refreshHistory, refreshApiKey, refreshPerms]);

  useTauriEvent<RecState>(EVT.recState, (e) => setRecording(e.recording));
  useTauriEvent<ModeChanged>(EVT.modeChanged, () => refreshModes());
  useTauriEvent<unknown>(EVT.historyChanged, () => refreshHistory());
  useTauriEvent<BackendError>(EVT.error, (e) => {
    // Recording-flow failures (transcription / injection) are shown quietly in
    // the HUD — don't also pop an intrusive dashboard toast for them.
    if (e.stage === "transcription" || e.stage === "inject") return;
    setToast(e.message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  });

  // Apply DEV theme tweaks to CSS variables / shell classes.
  useEffect(() => {
    document.documentElement.style.setProperty("--pink", theme.pink);
    document.documentElement.style.setProperty("--head", `"${theme.headerFont}", sans-serif`);
  }, [theme]);

  const activeModeName = activeMode?.name ?? "—";
  const minutes = Math.round(history.reduce((s, h) => s + h.durationSecs, 0) / 60);

  const META: Record<string, string> = {
    home: t("nav.home.meta"),
    history: `${history.length} RECORDINGS · ${minutes} MIN`,
    modes: `${modes.length} MODES · CONTEXT-AWARE PRESETS`,
    settings: "SYSTEM CONFIG",
  };
  const DESC: Record<string, string> = {
    home: t("nav.home.desc"),
    history: t("nav.history.desc"),
    modes: t("nav.modes.desc"),
    settings: t("nav.settings.desc"),
  };

  const switchTo = useCallback(
    (id: string) => {
      if (id === view || phase !== "idle") return;
      setAudioStopToken((n) => n + 1);
      timers.current.forEach(clearTimeout);
      setPhase("closing");
      timers.current = [
        window.setTimeout(() => {
          setView(id);
          setPhase("opening");
        }, 150),
        window.setTimeout(() => setPhase("idle"), 360),
      ];
    },
    [view, phase],
  );

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // Keyboard nav (ignored while typing in a field).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      if (el && ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) return;
      const idx = MENU.findIndex((m) => m.id === view);
      if (idx < 0) return;
      if (e.key === "ArrowDown" || e.key === "j") {
        switchTo(MENU[(idx + 1) % MENU.length].id);
        e.preventDefault();
      } else if (e.key === "ArrowUp" || e.key === "k") {
        switchTo(MENU[(idx - 1 + MENU.length) % MENU.length].id);
        e.preventDefault();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [switchTo, view]);

  const permsMissing = !perms.microphone || !perms.accessibility;

  // Auto-refresh permission status so grants made in System Settings appear
  // without a manual re-check or app restart. Poll while something is missing,
  // and always re-check when the window regains focus.
  useEffect(() => {
    const onFocus = () => refreshPerms();
    window.addEventListener("focus", onFocus);
    let id: number | undefined;
    if (permsMissing) id = window.setInterval(refreshPerms, 1500);
    return () => {
      window.removeEventListener("focus", onFocus);
      if (id !== undefined) window.clearInterval(id);
    };
  }, [permsMissing, refreshPerms]);

  function renderPanel() {
    switch (view) {
      case "home":
        return <HomePanel history={history} go={switchTo} />;
      case "history":
        return <HistoryPanel history={history} onChange={refreshHistory} stopToken={audioStopToken} />;
      case "modes":
        return <ModesPanel modes={modes} activeModeId={activeMode?.id ?? null} onChange={refreshModes} />;
      case "settings":
        return (
          <SettingsPanel
            apiKeySet={apiKeySet}
            refreshApiKey={refreshApiKey}
            perms={perms}
            refreshPerms={refreshPerms}
          />
        );
      default:
        return null;
    }
  }

  const labelText = "// " + (MENU.find((m) => m.id === view)?.label ?? "");
  const frameCls = "content-frame " + (phase === "closing" ? "closing" : phase === "opening" ? "opening" : "");

  return (
    <div className={"app" + (theme.scanlines ? " scan" : "") + (theme.grid ? " gridbg" : "")}>
      <header className="head">
        <div className="head-brand">
          <div className="head-crumb">{t("header.crumb")}</div>
          <h1 className="head-title" style={{ fontFamily: "var(--head)" }}>
            VOXCTL
          </h1>
        </div>
        <div className="trace">
          <span className="trace-line" />
          <span className="trace-step" />
          <span className="trace-line short" />
          <span className="trace-dot" />
        </div>
        <div className="head-right">
          {permsMissing ? (
            <button type="button" className="mode-pill warn" onClick={() => switchTo("settings")}>
              {t("perm.title")}
            </button>
          ) : (
            <div className="mode-pill">
              {t("header.activeMode")} <b>▸ {activeModeName}</b>
            </div>
          )}
          <div className="head-stat">
            {t("header.link")}{" "}
            <span className={perms.accessibility ? "ok" : "bad"}>
              {perms.accessibility ? "✓ " + t("header.ok") : "· " + t("header.unset")}
            </span>{" "}
            · {t("header.key")}{" "}
            <span className={apiKeySet ? "ok" : "bad"}>
              {apiKeySet ? "✓ " + t("header.set") : "· " + t("header.unset")}
            </span>
          </div>
        </div>
      </header>

      <main className="main">
        <div className="side">
          <nav className="nav">
            <div className="nav-label">{t("common.select")}</div>
            <ul className="nav-list">
              {MENU.map((m, i) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className={"nav-item" + (m.id === view ? " active" : "")}
                    onClick={() => switchTo(m.id)}
                  >
                    <span className="cursor">↵</span>
                    <span className="nav-n">{pad(i + 1)}</span>
                    <span className="nav-main">
                      <span className="nav-title-row">
                        <span className="nav-text">{m.label}</span>
                        {m.id === view ? <span className="nav-caret blink" /> : null}
                      </span>
                      <span className="nav-meta">{META[m.id]}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div className="side-qr">
            <Logo recording={recording} />
            <div className="side-qr-txt">
              <span>VX-MENU-0xA7</span>
              <span className="dim">REV 2.4 · {ready ? "READY" : "BOOT"}</span>
            </div>
          </div>

          <Frame className="sysdesc" label="// SYS.DESC">
            <p className="sysdesc-text">
              <Typewriter text={DESC[view] ?? ""} run={phase !== "closing"} speed={11} />
              <span className="caret blink">█</span>
            </p>
          </Frame>
        </div>

        <div className="stage">
          <Frame className={frameCls} label={labelText} tr="VX-0xA7">
            <div className="content">{renderPanel()}</div>
          </Frame>
        </div>
      </main>

      <footer className="foot">
        <div className="gr">
          <span className="gr-k">{t("footer.input")}</span>
          <VolumeMeter count={12} />
        </div>
        <div className="gr">
          <span className="gr-k">{t("footer.mode")}</span>
          <span className="gr-v on-pink">▸ {activeModeName}</span>
        </div>
        <div className="gr">
          <span className="gr-k">{t("footer.sfx")}</span>
          <span className={"gr-v" + (config.sfxEnabled ? " on-pink" : "")}>
            {config.sfxEnabled ? "ON" : "SILENT"}
          </span>
        </div>
        <div className="gr gr-clock">
          <span className="gr-k">{t("footer.utc")}</span>
          <Clock />
          <Qr seed={733} n={5} />
        </div>
      </footer>

      {toast ? (
        <div className="toast" onClick={() => setToast(null)}>
          <span className="toast-x">!</span>
          {toast}
        </div>
      ) : null}

      {import.meta.env.DEV ? <TweaksPanel theme={theme} onChange={setTheme} /> : null}
    </div>
  );
}
