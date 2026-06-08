import "../styles/panels/settings.css";
import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ProviderKeyCard } from "../components/ProviderKeyCard";
import { Segmented, Toggle } from "../components/Primitives";
import { ShortcutRecorder } from "../components/ShortcutRecorder";
import { useConfig } from "../hooks/useConfig";
import { t } from "../i18n";
import { AVAILABLE_LOCALES } from "../i18n";
import { LANGUAGES } from "../lib/languages";
import {
  openPermissionSettings,
  purgeRecordings,
  requestAccessibility,
  requestMicrophone,
  requestNotificationPermission,
  storageStats,
} from "../lib/ipc";
import type { CaptureMode, DeleteBehavior, PermissionStatus, StorageStats } from "../lib/types";
import {
  providerValidated,
  type ProviderStatus,
  type Registry,
} from "../lib/registry";

/** Settings sections, in scroll order. Drives the scroll-spy that updates the
 *  content-frame header (`// SETTINGS / …`) and the SYS.DESC blurb. */
const SECTIONS: { id: string; label: string; desc: string }[] = [
  { id: "providers", label: "settings.sec.providers", desc: "settings.sec.providersDesc" },
  { id: "capture", label: "settings.sec.capture", desc: "settings.sec.captureDesc" },
  { id: "transcription", label: "settings.sec.transcription", desc: "settings.sec.transcriptionDesc" },
  { id: "audio", label: "settings.sec.audio", desc: "settings.sec.audioDesc" },
  { id: "storage", label: "settings.sec.storage", desc: "settings.sec.storageDesc" },
  { id: "system", label: "settings.sec.system", desc: "settings.sec.systemDesc" },
  { id: "about", label: "settings.sec.about", desc: "settings.sec.aboutDesc" },
];

/** Magenta section title + descriptive blurb. Pulls copy from SECTIONS so it
 *  stays in lockstep with the scroll-spy retitle. */
function SectionHead({ id }: { id: string }) {
  const sec = SECTIONS.find((s) => s.id === id);
  if (!sec) return null;
  return (
    <header className="vx-set-head">
      <h2 className="vx-set-title">{t(sec.label)}</h2>
      <p className="vx-set-desc">{t(sec.desc)}</p>
    </header>
  );
}

export function SettingsPanel({
  registry,
  providers,
  refreshProviders,
  perms,
  refreshPerms,
  recording,
  onSection,
}: {
  registry: Registry | null;
  providers: ProviderStatus;
  refreshProviders: () => void;
  perms: PermissionStatus;
  refreshPerms: () => void;
  recording: boolean;
  onSection: (s: { label: string; desc: string } | null) => void;
}) {
  const { config, set } = useConfig();
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastSec = useRef("");

  // Notifications are OFF by default. Turning them ON triggers the macOS
  // permission prompt; only persist ON if the user actually grants it.
  async function toggleNotify() {
    if (recording) return;
    if (config.notifyOnModeSwitch) {
      set("notifyOnModeSwitch", false);
      return;
    }
    const granted = await requestNotificationPermission().catch(() => false);
    set("notifyOnModeSwitch", granted);
  }

  // Scroll-spy: report the section nearest the top of the scroll container so the
  // header (`// SETTINGS / …`) and SYS.DESC track what you're looking at.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const report = () => {
      const line = el.getBoundingClientRect().top + 90;
      let active = SECTIONS[0];
      for (const s of SECTIONS) {
        const node = el.querySelector<HTMLElement>(`[data-sec="${s.id}"]`);
        if (node && node.getBoundingClientRect().top <= line) active = s;
      }
      if (active.id !== lastSec.current) {
        lastSec.current = active.id;
        onSection({ label: t(active.label), desc: t(active.desc) });
      }
    };
    report();
    el.addEventListener("scroll", report, { passive: true });
    return () => el.removeEventListener("scroll", report);
  }, [onSection]);

  return (
    <div className="panel-body settings" ref={bodyRef}>
      {recording ? <div className="vx-set-rec">RECORDING IN PROGRESS</div> : null}

      <section className="set-section" data-sec="providers">
        <SectionHead id="providers" />
        <div className="prov-list">
          {(registry?.providers ?? []).map((p) => (
            <ProviderKeyCard
              key={p.id}
              provider={p}
              registry={registry}
              validated={providerValidated(providers, p.id)}
              recording={recording}
              onChanged={refreshProviders}
            />
          ))}
        </div>
        <p className="vx-set-note">{t("settings.keyHint")}</p>
      </section>

      <section className="set-section" data-sec="capture">
        <SectionHead id="capture" />
        <div className="vx-set-card">
          <div className="vx-set-row">
            <div className="vx-set-card-text">
              <div className="vx-set-card-label">{t("settings.capture")}</div>
            </div>
            <Segmented<CaptureMode>
              value={config.captureMode}
              options={[
                { value: "toggle", label: t("settings.toggle") },
                { value: "ptt", label: t("settings.ptt") },
              ]}
              onChange={(v) => set("captureMode", v, { reloadShortcut: true })}
              disabled={recording}
            />
          </div>
          <div className="vx-set-card-hint">
            {config.captureMode === "toggle" ? t("settings.captureHint.toggle") : t("settings.captureHint.ptt")}
          </div>
        </div>
        <div className="vx-set-card">
          <div className="vx-set-row">
            <div className="vx-set-card-text">
              <div className="vx-set-card-label">{t("settings.shortcut")}</div>
            </div>
            <ShortcutRecorder
              value={config.shortcut}
              onChange={(s) => set("shortcut", s, { reloadShortcut: true })}
              disabled={recording}
            />
          </div>
        </div>
      </section>

      <section className="set-section" data-sec="transcription">
        <SectionHead id="transcription" />
        <div className="vx-set-card vx-set-card--stack">
          <div className="vx-set-card-label">{t("settings.transcriptionLanguage")}</div>
          <select
            className="set-select"
            value={config.defaultLanguage ?? "auto"}
            onChange={(e) => set("defaultLanguage", e.target.value === "auto" ? null : e.target.value)}
            disabled={recording}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.code === "auto" ? t("settings.autoDetect") : l.label}
              </option>
            ))}
          </select>
          <div className="vx-set-card-hint">{t("settings.alwaysSave")}</div>
        </div>
      </section>

      <section className="set-section" data-sec="audio">
        <SectionHead id="audio" />
        <div className="vx-set-card">
          <div className="vx-set-row">
            <div className="vx-set-card-text">
              <div className="vx-set-card-label">{t("settings.sfx")}</div>
              <div className="vx-set-card-sub">{t("settings.sfxSub")}</div>
            </div>
            <Toggle
              on={config.sfxEnabled}
              onToggle={() => set("sfxEnabled", !config.sfxEnabled)}
              labels={[t("settings.sfxOn"), t("settings.sfxOff")]}
              disabled={recording}
            />
          </div>
        </div>
        <div className="vx-set-card">
          <div className="vx-set-row">
            <div className="vx-set-card-text">
              <div className="vx-set-card-label">{t("settings.notify")}</div>
              <div className="vx-set-card-sub">{t("settings.notifySub")}</div>
            </div>
            <Toggle
              on={config.notifyOnModeSwitch}
              onToggle={toggleNotify}
              labels={[t("settings.on"), t("settings.off")]}
              disabled={recording}
            />
          </div>
        </div>
      </section>

      <section className="set-section" data-sec="storage">
        <SectionHead id="storage" />
        <StorageSection
          deleteBehavior={config.deleteBehavior}
          onDeleteBehavior={(v) => set("deleteBehavior", v)}
          recording={recording}
        />
      </section>

      <section className="set-section" data-sec="system">
        <SectionHead id="system" />
        <div className="vx-set-card">
          <div className="vx-set-row">
            <div className="vx-set-card-text">
              <div className="vx-set-card-label">{t("settings.clipboard")}</div>
              <div className="vx-set-card-sub">{t("settings.clipboardSub")}</div>
            </div>
            <Toggle
              on={config.copyToClipboard}
              onToggle={() => set("copyToClipboard", !config.copyToClipboard)}
              labels={[t("settings.on"), t("settings.off")]}
              disabled={recording}
            />
          </div>
        </div>
        <div className="vx-set-card vx-set-card--stack">
          <div className="vx-set-card-label">{t("settings.appLanguage")}</div>
          <select
            className="set-select"
            value={config.appLocale}
            onChange={(e) => set("appLocale", e.target.value)}
            disabled={recording}
          >
            {AVAILABLE_LOCALES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div className="vx-set-card vx-set-card--stack">
          <div className="vx-set-card-text">
            <div className="vx-set-card-label">{t("perm.title")}</div>
            <div className="vx-set-card-sub">{t("perm.banner")}</div>
          </div>
          <div className="perm-cards">
            <PermCard
              name={t("perm.mic.name")}
              desc={t("perm.mic.desc")}
              granted={perms.microphone}
              onAction={() => requestMicrophone().then(refreshPerms).catch(() => {})}
              onOpen={() => openPermissionSettings("microphone").catch(() => {})}
              disabled={recording}
            />
            <PermCard
              name={t("perm.ax.name")}
              desc={t("perm.ax.desc")}
              granted={perms.accessibility}
              onAction={() => requestAccessibility().then(refreshPerms).catch(() => {})}
              onOpen={() => openPermissionSettings("accessibility").catch(() => {})}
              disabled={recording}
            />
          </div>
          <div className="vx-set-perm-actions">
            <button type="button" className="vx-btn" onClick={refreshPerms} disabled={recording}>
              ↻ {t("perm.recheck")}
            </button>
          </div>
        </div>
      </section>

      <section className="set-section" data-sec="about">
        <SectionHead id="about" />
        <div className="vx-set-card">
          <div className="vx-set-row">
            <div className="vx-set-card-text">
              <div className="vx-set-card-label">{t("settings.aboutLine")}</div>
            </div>
            <button
              type="button"
              className="vx-btn vx-btn--mag"
              onClick={() => openUrl("https://docs.voxctl.com").catch(() => {})}
            >
              {t("settings.docs")} ↗
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

const fmtMB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Storage: disk used, delete-behavior, and a retention purge (Storage section). */
function StorageSection({
  deleteBehavior,
  onDeleteBehavior,
  recording,
}: {
  deleteBehavior: DeleteBehavior;
  onDeleteBehavior: (v: DeleteBehavior) => void;
  recording: boolean;
}) {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [days, setDays] = useState(30);
  const [keepFav, setKeepFav] = useState(true);
  const [purging, setPurging] = useState(false);

  const refresh = () => storageStats().then(setStats).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);

  async function purge() {
    if (recording) return;
    setPurging(true);
    try {
      await purgeRecordings(days, keepFav);
      refresh();
    } catch (e) {
      console.error("purge failed", e);
    } finally {
      setPurging(false);
    }
  }

  return (
    <>
      <div className="vx-set-card">
        <div className="vx-set-row">
          <div className="vx-set-card-text">
            <div className="vx-set-card-label">{t("settings.storage")}</div>
          </div>
          <div className="vx-set-stat">
            {stats
              ? t("settings.storageUsed", { size: fmtMB(stats.totalBytes), n: stats.recordingCount })
              : "—"}
          </div>
        </div>
      </div>

      <div className="vx-set-card">
        <div className="vx-set-row">
          <div className="vx-set-card-text">
            <div className="vx-set-card-label">{t("settings.deleteBehavior")}</div>
            <div className="vx-set-card-sub">{t("settings.deleteBehaviorSub")}</div>
          </div>
          <Segmented<DeleteBehavior>
            value={deleteBehavior}
            options={[
              { value: "both", label: t("settings.deleteBoth") },
              { value: "transcript", label: t("settings.deleteKeepAudio") },
            ]}
            onChange={onDeleteBehavior}
            disabled={recording}
          />
        </div>
      </div>

      <div className="vx-set-card vx-set-card--stack">
        <div className="storage-purge">
          <span className="set-sub">{t("settings.purgeOlder")}</span>
          <input
            className="storage-days"
            type="number"
            min={1}
            value={days}
            disabled={recording}
            onChange={(e) => setDays(Math.max(1, Number(e.target.value) || 1))}
          />
          <span className="set-sub">{t("settings.purgeDays")}</span>
          <Toggle
            on={keepFav}
            onToggle={() => setKeepFav((v) => !v)}
            labels={[t("settings.purgeKeepFav"), t("settings.purgeAll")]}
            disabled={recording}
          />
          <button
            type="button"
            className="vx-btn vx-btn--danger"
            onClick={purge}
            disabled={purging || recording}
          >
            {purging ? t("settings.purging") : t("settings.purge")}
          </button>
        </div>
      </div>
    </>
  );
}

function PermCard({
  name,
  desc,
  granted,
  onAction,
  onOpen,
  disabled = false,
}: {
  name: string;
  desc: string;
  granted: boolean;
  onAction: () => void;
  onOpen: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="perm-card">
      <div className="pc-main">
        <div className="pc-name">
          {name}
          <span className={"pc-status " + (granted ? "granted" : "denied")}>
            {granted ? t("perm.granted") : t("perm.denied")}
          </span>
        </div>
        <div className="pc-desc">{desc}</div>
      </div>
      <div className="vx-set-perm-btns">
        <button type="button" className="vx-btn" onClick={onOpen} disabled={disabled}>
          {t("perm.open")}
        </button>
        {granted ? null : (
          <button type="button" className="vx-btn vx-btn--mag" onClick={onAction} disabled={disabled}>
            {t("perm.grant")}
          </button>
        )}
      </div>
    </div>
  );
}
