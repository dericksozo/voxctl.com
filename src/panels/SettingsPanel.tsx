import { useEffect, useState } from "react";
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
  requestAccessibility,
  requestMicrophone,
  requestNotificationPermission,
} from "../lib/ipc";
import type { CaptureMode, PermissionStatus } from "../lib/types";

export function SettingsPanel({
  apiKeySet,
  refreshApiKey,
  perms,
  refreshPerms,
  recording,
}: {
  apiKeySet: boolean;
  refreshApiKey: () => void;
  perms: PermissionStatus;
  refreshPerms: () => void;
  recording: boolean;
}) {
  const { config, set } = useConfig();
  const [keyDraft, setKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [keyErr, setKeyErr] = useState<string | null>(null);

  // Reflect stored state without ever pulling the secret into the webview.
  useEffect(() => {
    if (apiKeySet) setKeyDraft("");
  }, [apiKeySet]);

  async function saveKey() {
    if (recording) return;
    const k = keyDraft.trim();
    setSaving(true);
    setKeyErr(null);
    try {
      if (k) {
        // Validated against OpenAI in Rust; an invalid key is rejected (not stored).
        await setApiKey(k);
      } else {
        await deleteApiKey();
      }
      setKeyDraft("");
      refreshApiKey();
    } catch (e) {
      const msg = String(e);
      setKeyErr(
        msg.includes("invalid")
          ? t("settings.keyInvalid")
          : msg.includes("unreachable")
            ? t("settings.keyUnreachable")
            : t("settings.keyError"),
      );
    } finally {
      setSaving(false);
    }
  }

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
          {t("settings.apiKey")} <span className="set-sub">{t("settings.byok")}</span>
        </div>
        <div className="set-key">
          <input
            className="key-input"
            value={keyDraft}
            disabled={recording}
            onChange={(e) => {
              setKeyDraft(e.target.value);
              if (keyErr) setKeyErr(null);
            }}
            type="password"
            spellCheck={false}
            placeholder={apiKeySet ? "•••••••••••••••• (stored)" : "sk-…"}
          />
          <button type="button" className="key-eye" onClick={saveKey} disabled={saving || recording}>
            {saving ? t("settings.validating") : t("settings.save")}
          </button>
          <span className={"set-ok" + (keyErr ? " bad" : apiKeySet ? "" : " bad")}>
            {keyErr ? "✕ " + keyErr : apiKeySet ? "✓ " + t("settings.valid") : t("settings.invalid")}
          </span>
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
