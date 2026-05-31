import { useEffect, useState } from "react";
import { Segmented, Toggle } from "../components/Primitives";
import { ShortcutRecorder } from "../components/ShortcutRecorder";
import { useConfig } from "../hooks/useConfig";
import { t } from "../i18n";
import { AVAILABLE_LOCALES } from "../i18n";
import { LANGUAGES } from "../lib/languages";
import { setApiKey, deleteApiKey } from "../lib/ipc";
import type { CaptureMode } from "../lib/types";

export function SettingsPanel({
  apiKeySet,
  refreshApiKey,
}: {
  apiKeySet: boolean;
  refreshApiKey: () => void;
}) {
  const { config, set } = useConfig();
  const [keyDraft, setKeyDraft] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reflect stored state without ever pulling the secret into the webview.
  useEffect(() => {
    if (apiKeySet) setKeyDraft("");
  }, [apiKeySet]);

  async function saveKey() {
    const k = keyDraft.trim();
    setSaving(true);
    try {
      if (k) {
        await setApiKey(k);
      } else {
        await deleteApiKey();
      }
      setKeyDraft("");
      refreshApiKey();
    } catch (e) {
      console.error("api key save failed", e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="panel-body settings">
      <div className="set-row">
        <div className="set-label">
          {t("settings.apiKey")} <span className="set-sub">{t("settings.byok")}</span>
        </div>
        <div className="set-key">
          <input
            className="key-input"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            type={reveal ? "text" : "password"}
            spellCheck={false}
            placeholder={apiKeySet ? "•••••••••••••••• (stored)" : "sk-…"}
          />
          <button type="button" className="key-eye" onClick={() => setReveal((r) => !r)}>
            {reveal ? t("settings.hide") : t("settings.show")}
          </button>
          <button type="button" className="key-eye" onClick={saveKey} disabled={saving}>
            {t("settings.save")}
          </button>
          <span className={"set-ok" + (apiKeySet ? "" : " bad")}>
            {apiKeySet ? "✓ " + t("settings.valid") : t("settings.invalid")}
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
          onChange={(v) => set("captureMode", v)}
        />
        <div className="set-hint">
          {config.captureMode === "toggle" ? t("settings.captureHint.toggle") : t("settings.captureHint.ptt")}
        </div>
      </div>

      <div className="set-grid">
        <div className="set-cell">
          <div className="set-label">{t("settings.shortcut")}</div>
          <ShortcutRecorder value={config.shortcut} onChange={(s) => set("shortcut", s)} />
        </div>
        <div className="set-cell">
          <div className="set-label">{t("settings.transcriptionLanguage")}</div>
          <select
            className="set-select"
            value={config.defaultLanguage ?? "auto"}
            onChange={(e) => set("defaultLanguage", e.target.value === "auto" ? null : e.target.value)}
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
          <select className="set-select" value={config.appLocale} onChange={(e) => set("appLocale", e.target.value)}>
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
        />
      </div>

      <div className="set-row inline">
        <div className="set-label">
          {t("settings.notify")} <span className="set-sub">{t("settings.notifySub")}</span>
        </div>
        <Toggle
          on={config.notifyOnModeSwitch}
          onToggle={() => set("notifyOnModeSwitch", !config.notifyOnModeSwitch)}
          labels={[t("settings.on"), t("settings.off")]}
        />
      </div>
    </div>
  );
}
