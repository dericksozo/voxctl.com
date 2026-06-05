import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Segmented, Toggle } from "../components/Primitives";
import { ShortcutRecorder } from "../components/ShortcutRecorder";
import { useConfig } from "../hooks/useConfig";
import { t } from "../i18n";
import { AVAILABLE_LOCALES } from "../i18n";
import { LANGUAGES } from "../lib/languages";
import {
  setApiKey,
  deleteApiKey,
  openPermissionSettings,
  purgeRecordings,
  requestAccessibility,
  requestMicrophone,
  requestNotificationPermission,
  storageStats,
} from "../lib/ipc";
import type { CaptureMode, DeleteBehavior, PermissionStatus, StorageStats } from "../lib/types";
import {
  costLabel,
  modelById,
  providerValidated,
  type ProviderId,
  type ProviderRecord,
  type ProviderStatus,
  type Registry,
} from "../lib/registry";

export function SettingsPanel({
  registry,
  providers,
  refreshProviders,
  perms,
  refreshPerms,
  recording,
}: {
  registry: Registry | null;
  providers: ProviderStatus;
  refreshProviders: () => void;
  perms: PermissionStatus;
  refreshPerms: () => void;
  recording: boolean;
}) {
  const { config, set } = useConfig();

  const permsMissing = !perms.microphone || !perms.accessibility;

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

  return (
    <div className="panel-body settings">
      {recording ? <div className="set-hint">RECORDING IN PROGRESS</div> : null}
      {permsMissing ? (
        <div className="set-row">
          <div className="set-label">
            {t("perm.title")} <span className="set-sub">{t("perm.banner")}</span>
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
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <button type="button" className="pc-btn secondary" onClick={refreshPerms} disabled={recording}>
              ↻ {t("perm.recheck")}
            </button>
          </div>
        </div>
      ) : null}

      <div className="set-row">
        <div className="set-label">
          {t("settings.providers")} <span className="set-sub">{t("settings.byok")}</span>
        </div>
        <div className="prov-list">
          {(registry?.providers ?? []).map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              registry={registry}
              validated={providerValidated(providers, p.id)}
              recording={recording}
              onChanged={refreshProviders}
            />
          ))}
        </div>
        <div className="set-hint">{t("settings.keyHint")}</div>
      </div>

      <div className="set-row">
        <div className="set-label">{t("settings.capture")}</div>
        <Segmented<CaptureMode>
          value={config.captureMode}
          options={[
            { value: "toggle", label: t("settings.toggle") },
            { value: "ptt", label: t("settings.ptt") },
          ]}
          onChange={(v) => set("captureMode", v, { reloadShortcut: true })}
          disabled={recording}
        />
        <div className="set-hint">
          {config.captureMode === "toggle" ? t("settings.captureHint.toggle") : t("settings.captureHint.ptt")}
        </div>
      </div>

      <div className="set-grid">
        <div className="set-cell">
          <div className="set-label">{t("settings.shortcut")}</div>
          <ShortcutRecorder
            value={config.shortcut}
            onChange={(s) => set("shortcut", s, { reloadShortcut: true })}
            disabled={recording}
          />
        </div>
        <div className="set-cell">
          <div className="set-label">{t("settings.transcriptionLanguage")}</div>
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
        </div>
      </div>

      <div className="set-grid">
        <div className="set-cell">
          <div className="set-label">{t("settings.appLanguage")}</div>
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
        <div className="set-cell" />
      </div>

      <div className="set-row inline">
        <div className="set-label">
          {t("settings.sfx")} <span className="set-sub">{t("settings.sfxSub")}</span>
        </div>
        <Toggle
          on={config.sfxEnabled}
          onToggle={() => set("sfxEnabled", !config.sfxEnabled)}
          labels={[t("settings.sfxOn"), t("settings.sfxOff")]}
          disabled={recording}
        />
      </div>

      <div className="set-row inline">
        <div className="set-label">
          {t("settings.clipboard")} <span className="set-sub">{t("settings.clipboardSub")}</span>
        </div>
        <Toggle
          on={config.copyToClipboard}
          onToggle={() => set("copyToClipboard", !config.copyToClipboard)}
          labels={[t("settings.on"), t("settings.off")]}
          disabled={recording}
        />
      </div>

      <div className="set-row inline">
        <div className="set-label">
          {t("settings.notify")} <span className="set-sub">{t("settings.notifySub")}</span>
        </div>
        <Toggle
          on={config.notifyOnModeSwitch}
          onToggle={toggleNotify}
          labels={[t("settings.on"), t("settings.off")]}
          disabled={recording}
        />
      </div>

      <StorageSection
        deleteBehavior={config.deleteBehavior}
        onDeleteBehavior={(v) => set("deleteBehavior", v)}
        recording={recording}
      />
    </div>
  );
}

const fmtMB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Storage: disk used, delete-behavior, and a retention purge. Lives in the
 *  current (flat) Settings page; Step 5 moves it into the sectioned layout. */
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
    <div className="set-row">
      <div className="set-label">
        {t("settings.storage")}{" "}
        <span className="set-sub">
          {stats
            ? t("settings.storageUsed", { size: fmtMB(stats.totalBytes), n: stats.recordingCount })
            : ""}
        </span>
      </div>

      <div className="set-row inline" style={{ marginTop: 4 }}>
        <div className="set-label" style={{ marginBottom: 0 }}>
          {t("settings.deleteBehavior")} <span className="set-sub">{t("settings.deleteBehaviorSub")}</span>
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
        <button type="button" className="pc-btn danger-btn" onClick={purge} disabled={purging || recording}>
          {purging ? t("settings.purging") : t("settings.purge")}
        </button>
      </div>
    </div>
  );
}

/** One provider's key row: stored/validated status, key entry + validate/save,
 *  the auto-selected default model (read-only), and a docs link. Keys are
 *  validated in Rust and only stored when valid — an invalid key shows red. */
function ProviderRow({
  provider,
  registry,
  validated,
  recording,
  onChanged,
}: {
  provider: ProviderRecord;
  registry: Registry | null;
  validated: boolean;
  recording: boolean;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const defaultModel = modelById(registry, provider.defaultModelId);

  async function save() {
    if (recording) return;
    const k = draft.trim();
    setSaving(true);
    setErr(null);
    try {
      if (k) await setApiKey(provider.id as ProviderId, k);
      else await deleteApiKey(provider.id as ProviderId);
      setDraft("");
    } catch (e) {
      const msg = String(e);
      setErr(
        msg.includes("invalid")
          ? t("settings.keyInvalid")
          : msg.includes("unreachable")
            ? t("settings.keyUnreachable")
            : t("settings.keyError"),
      );
    } finally {
      setSaving(false);
      // Re-read the true backend status after EVERY attempt (not just success):
      // an invalid key clears any stored key, so the row + header must update.
      onChanged();
    }
  }

  // Error (just-rejected key) takes visual priority over the stored state, so a
  // bad entry never keeps looking validated.
  const rowState = err ? "err" : validated ? "ok" : "none";

  return (
    <div className={"prov-row " + rowState}>
      <div className="prov-head">
        <span className="prov-name">
          <span className={"prov-dot " + (err ? "err" : validated ? "on" : "off")} />
          {provider.label}
        </span>
        {defaultModel ? (
          <span className="prov-model">
            {defaultModel.label} <span className="dim">{costLabel(defaultModel)}</span>
          </span>
        ) : null}
        <button
          type="button"
          className="prov-docs"
          onClick={() => openUrl(provider.docsUrl).catch(() => {})}
        >
          {t("settings.docs")} ↗
        </button>
      </div>
      <div className="set-key">
        <input
          className="key-input"
          value={draft}
          disabled={recording}
          onChange={(e) => {
            setDraft(e.target.value);
            if (err) setErr(null);
          }}
          type="password"
          spellCheck={false}
          placeholder={validated ? "•••••••••••••••• (stored)" : t("settings.keyPlaceholder")}
        />
        <button type="button" className="key-eye" onClick={save} disabled={saving || recording}>
          {saving ? t("settings.validating") : t("settings.save")}
        </button>
        <span className={"set-ok" + (err ? " err" : validated ? "" : " bad")}>
          {err ? "✕ " + err : validated ? "✓ " + t("settings.valid") : t("settings.invalid")}
        </span>
      </div>
    </div>
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
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="pc-btn secondary" onClick={onOpen} disabled={disabled}>
          {t("perm.open")}
        </button>
        {granted ? null : (
          <button type="button" className="pc-btn" onClick={onAction} disabled={disabled}>
            {t("perm.grant")}
          </button>
        )}
      </div>
    </div>
  );
}
