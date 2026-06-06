import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "../i18n";
import { deleteApiKey, setApiKey } from "../lib/ipc";
import {
  costLabel,
  modelById,
  type ProviderId,
  type ProviderRecord,
  type Registry,
} from "../lib/registry";

/** Provider key entry shared by Settings and onboarding. Validation/storage
 *  stays Rust-owned; the UI only shows the transient result. */
export function ProviderKeyCard({
  provider,
  registry,
  validated,
  recording,
  onChanged,
  onValidated,
  actionLabel,
}: {
  provider: ProviderRecord;
  registry: Registry | null;
  validated: boolean;
  recording: boolean;
  onChanged: () => void;
  onValidated?: (provider: ProviderId) => void | Promise<void>;
  actionLabel?: string;
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
      if (k) {
        await setApiKey(provider.id as ProviderId, k);
        await onValidated?.(provider.id as ProviderId);
      } else {
        await deleteApiKey(provider.id as ProviderId);
      }
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
      // Re-read true backend status after every attempt. Invalid keys can clear
      // a stored key, so the row/header must update even on failure.
      onChanged();
    }
  }

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
          {saving ? t("settings.validating") : (actionLabel ?? t("settings.save"))}
        </button>
        <span className={"set-ok" + (err ? " err" : validated ? "" : " bad")}>
          {err ? "✕ " + err : validated ? "✓ " + t("settings.valid") : t("settings.invalid")}
        </span>
      </div>
    </div>
  );
}
