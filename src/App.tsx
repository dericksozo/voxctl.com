import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./styles/theme.css";
import { Frame, Logo, Qr } from "./components/Primitives";
import { Clock } from "./components/Clock";
import { VolumeMeter } from "./components/VolumeMeter";
import { RecTimer } from "./components/RecTimer";
import { Typewriter } from "./components/Typewriter";
import { DEFAULT_THEME, type Theme, TweaksPanel } from "./components/TweaksPanel";
import { ModeSwitcher } from "./components/ModeSwitcher";
import { HomePanel } from "./panels/HomePanel";
import { HistoryPanel } from "./panels/HistoryPanel";
import { ModesPanel } from "./panels/ModesPanel";
import { SettingsPanel } from "./panels/SettingsPanel";
import { OnboardingPanel } from "./panels/OnboardingPanel";
import { useConfig } from "./hooks/useConfig";
import { useTauriEvent } from "./hooks/useTauriEvent";
import { t } from "./i18n";
import { EVT, type BackendError, type ModeChanged, type RecState } from "./lib/events";
import {
  getActiveMode,
  getDefaultModeId,
  getPermissions,
  getRegistry,
  listHistory,
  listModes,
  providerStatus,
} from "./lib/ipc";
import type { ActiveMode, HistoryItem, Mode, PermissionStatus } from "./lib/types";
import {
  anyKeyValidated,
  EMPTY_PROVIDER_STATUS,
  type ProviderStatus,
  type Registry,
} from "./lib/registry";

const pad = (n: number) => String(n).padStart(2, "0");

// Memoize the panels + ModeSwitcher so unrelated App state changes (toast,
// recording, header section, clock) don't re-render them. Their props are stable
// — state refs plus useCallback'd handlers — so memo actually sticks (§5.1).
const MHistoryPanel = memo(HistoryPanel);
const MHomePanel = memo(HomePanel);
const MModesPanel = memo(ModesPanel);
const MSettingsPanel = memo(SettingsPanel);
const MModeSwitcher = memo(ModeSwitcher);

// Nav order: 01 HOME (transcript log), 02 MODES, 03 STATS (usage dashboard),
// 04 SETTINGS. Note "home" now renders the transcript log and "stats" renders
// the usage dashboard (the panels swapped roles in the overhaul).
const MENU = [
  { id: "home", label: t("nav.home") },
  { id: "modes", label: t("nav.modes") },
  { id: "stats", label: t("nav.stats") },
  { id: "settings", label: t("nav.settings") },
];

export default function App() {
  const { config, ready } = useConfig();
  const [view, setView] = useState("home");
  const [phase, setPhase] = useState<"idle" | "closing" | "opening">("idle");
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  const [audioStopToken, setAudioStopToken] = useState(0);

  const [modes, setModes] = useState<Mode[]>([]);
  const [defaultModeId, setDefaultModeId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [activeMode, setActiveMode] = useState<ActiveMode | null>(null);
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [providers, setProviders] = useState<ProviderStatus>(EMPTY_PROVIDER_STATUS);
  const [providersReady, setProvidersReady] = useState(false);
  const [perms, setPerms] = useState<PermissionStatus>({ microphone: true, accessibility: true });
  const [permsReady, setPermsReady] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  /** Active sub-section (scroll-driven) → header sub-title + SYS.DESC. Reported by
   *  panels that have one (Settings sections, Home day groups); null otherwise. */
  const [headerSection, setHeaderSection] = useState<{ label: string; desc: string } | null>(null);
  const [flashDesc, setFlashDesc] = useState<string | null>(null);
  const flashDescTimer = useRef<number | undefined>(undefined);
  const timers = useRef<number[]>([]);
  const toastTimer = useRef<number | undefined>(undefined);
  const historyDebounce = useRef<number | undefined>(undefined);

  const refreshModes = useCallback(() => {
    listModes().then(setModes).catch(() => {});
    getActiveMode().then(setActiveMode).catch(() => {});
    getDefaultModeId().then(setDefaultModeId).catch(() => {});
  }, []);
  const refreshHistory = useCallback(() => {
    listHistory().then(setHistory).catch(() => {});
  }, []);
  // Coalesce HISTORY_CHANGED bursts into a single refetch: one dictation emits ≥4
  // (reserve → stop → audio archived → transcript final), and each refetch is a
  // full archive read + re-render, so debouncing collapses the burst (perf §4.1).
  const debouncedRefreshHistory = useCallback(() => {
    window.clearTimeout(historyDebounce.current);
    historyDebounce.current = window.setTimeout(refreshHistory, 120);
  }, [refreshHistory]);
  const refreshProviders = useCallback(() => {
    providerStatus()
      .then((s) => {
        setProviders(s);
        setProvidersReady(true);
      })
      .catch(() => {});
  }, []);
  const refreshPerms = useCallback(() => {
    getPermissions()
      .then((p) => {
        setPerms(p);
        setPermsReady(true);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshModes();
    refreshHistory();
    refreshProviders();
    refreshPerms();
    getRegistry().then(setRegistry).catch(() => {});
  }, [refreshModes, refreshHistory, refreshProviders, refreshPerms]);

  const apiKeySet = anyKeyValidated(providers);
  const showOnboarding =
    ready &&
    providersReady &&
    permsReady &&
    (!config.onboardingCompleted || !perms.microphone || !perms.accessibility || !apiKeySet);

  useTauriEvent<RecState>(EVT.recState, (e) => setRecording(e.recording));
  useTauriEvent<ModeChanged>(EVT.modeChanged, () => refreshModes());
  useTauriEvent<unknown>(EVT.historyChanged, () => debouncedRefreshHistory());
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

  // Memoized so the per-render reduce over all history only re-runs when history
  // (or the modes count) actually changes (§5.1).
  const META = useMemo<Record<string, string>>(() => {
    const minutes = Math.round(history.reduce((s, h) => s + h.durationSecs, 0) / 60);
    return {
      home: `${history.length} RECORDINGS · ${minutes} MIN`,
      modes: `${modes.length} MODES · CONTEXT-AWARE PRESETS`,
      stats: t("nav.stats.meta"),
      settings: t("nav.settings.meta"),
    };
  }, [history, modes]);
  const DESC: Record<string, string> = {
    home: t("nav.home.desc"),
    modes: t("nav.modes.desc"),
    stats: t("nav.stats.desc"),
    settings: t("nav.settings.desc"),
  };

  // Flash a message in SYS.DESC (e.g. "COPIED PLAIN TEXT") for 2 s then revert.
  const handleCopyFlash = useCallback((msg: string) => {
    window.clearTimeout(flashDescTimer.current);
    setFlashDesc(msg);
    flashDescTimer.current = window.setTimeout(() => setFlashDesc(null), 2000);
  }, []);

  const switchTo = useCallback(
    (id: string) => {
      if (id === view || phase !== "idle") return;
      setAudioStopToken((n) => n + 1);
      timers.current.forEach(clearTimeout);
      setPhase("closing");
      timers.current = [
        window.setTimeout(() => {
          // Reset the header sub-title for the incoming panel; panels that have
          // one (Home/Settings) re-report it on mount, overwriting this null.
          setHeaderSection(null);
          setView(id);
          setPhase("opening");
        }, 150),
        window.setTimeout(() => setPhase("idle"), 360),
      ];
    },
    [view, phase],
  );

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      window.clearTimeout(historyDebounce.current);
    },
    [],
  );

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

  // Onboarding takes over the entire window — no nav / header / footer shell —
  // until config + permissions + a validated key are all satisfied.
  if (showOnboarding) {
    return (
      <div className={"app onb-full" + (theme.scanlines ? " scan" : "") + (theme.grid ? " gridbg" : "")}>
        <OnboardingPanel
          registry={registry}
          providers={providers}
          perms={perms}
          history={history}
          recording={recording}
          refreshProviders={refreshProviders}
          refreshModes={refreshModes}
          refreshHistory={refreshHistory}
          refreshPerms={refreshPerms}
        />
        {import.meta.env.DEV ? <TweaksPanel theme={theme} onChange={setTheme} /> : null}
      </div>
    );
  }

  function renderPanel() {
    switch (view) {
      case "home":
        return (
          <MHistoryPanel
            history={history}
            modes={modes}
            registry={registry}
            providers={providers}
            onChange={refreshHistory}
            go={switchTo}
            stopToken={audioStopToken}
            transitioning={phase !== "idle"}
            onSection={setHeaderSection}
            onCopyFlash={handleCopyFlash}
          />
        );
      case "stats":
        return <MHomePanel history={history} registry={registry} go={switchTo} />;
      case "modes":
        return (
          <MModesPanel
            modes={modes}
            activeModeId={activeMode?.mode.id ?? null}
            defaultModeId={defaultModeId}
            registry={registry}
            providers={providers}
            history={history}
            recording={recording}
            onChange={refreshModes}
            go={switchTo}
          />
        );
      case "settings":
        return (
          <MSettingsPanel
            registry={registry}
            providers={providers}
            refreshProviders={refreshProviders}
            recording={recording}
            onSection={setHeaderSection}
          />
        );
      default:
        return null;
    }
  }

  const baseLabel = MENU.find((m) => m.id === view)?.label ?? "";
  const sectionActive = headerSection;
  const descText = flashDesc ?? (sectionActive?.desc ? sectionActive.desc : (DESC[view] ?? ""));
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
        <div className="head-center">
          {permsMissing ? (
            <button type="button" className="mode-pill warn" onClick={() => switchTo("settings")}>
              {t("perm.title")}
            </button>
          ) : (
            <MModeSwitcher
              modes={modes}
              active={activeMode}
              registry={registry}
              providers={providers}
              onChange={refreshModes}
              recording={recording}
            />
          )}
        </div>
        <div className="trace">
          <span className="trace-line" />
          <span className="trace-step" />
          <span className="trace-line short" />
          <span className="trace-dot" />
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
                        <span className="nav-text">
                          {m.id === view ? (
                            <Typewriter key={view} text={m.label} run={phase !== "closing"} speed={11} />
                          ) : (
                            m.label
                          )}
                        </span>
                        <span className="nav-caret blink" aria-hidden="true">
                          █
                        </span>
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
              <Typewriter text={descText} run={phase !== "closing"} speed={11} />
              <span className="caret" />
            </p>
          </Frame>
        </div>

        <div className="stage">
          <Frame
            className={frameCls}
            label={
              // Segmented title: the static "//" and "/" separators never retype.
              // The base ("HOME"/"SETTINGS") retypes only on panel switch (keyed by
              // view); the sub-section retypes only when it changes (keyed by label).
              // No trailing caret here — the only carets are SYS.DESC + active nav.
              <>
                {"// "}
                <Typewriter
                  key={"base:" + view}
                  text={baseLabel}
                  run={phase !== "closing"}
                  speed={11}
                />
                {sectionActive ? (
                  <>
                    {" / "}
                    <Typewriter
                      key={"sec:" + view + ":" + sectionActive.label}
                      text={sectionActive.label}
                      run={phase !== "closing"}
                      speed={11}
                    />
                  </>
                ) : null}
              </>
            }
            tr="VX-0xA7"
          >
            <div className="content">{renderPanel()}</div>
          </Frame>
        </div>
      </main>

      <footer className="foot">
        <div className="gr">
          <span className="gr-k">{t("footer.input")}</span>
          <VolumeMeter count={12} />
        </div>
        <RecTimer />
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
