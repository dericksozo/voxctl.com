import { useState } from "react";
import { Toggle } from "../components/Primitives";
import { t } from "../i18n";
import { langLabel, LANGUAGES } from "../lib/languages";
import { deleteMode, saveMode, setModeEnabled } from "../lib/ipc";
import type { Mode } from "../lib/types";

const MODEL = "gpt-realtime-whisper";

const csv = (xs: string[]) => xs.join(", ");
const parseCsv = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function emptyMode(): Mode {
  return {
    id: "m" + Date.now(),
    name: "",
    enabled: true,
    language: "auto",
    keywords: [],
    triggerApps: [],
    triggerWebsites: [],
    model: MODEL,
    builtin: false,
  };
}

export function ModesPanel({
  modes,
  activeModeId,
  onChange,
}: {
  modes: Mode[];
  activeModeId: string | null;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState<Mode | null>(null);

  async function toggle(m: Mode) {
    try {
      await setModeEnabled(m.id, !m.enabled);
      onChange();
    } catch {
      /* ignore */
    }
  }
  async function remove(m: Mode) {
    try {
      await deleteMode(m.id);
      onChange();
    } catch {
      /* ignore */
    }
  }
  async function save(m: Mode) {
    try {
      await saveMode({ ...m, name: m.name.trim() || "UNTITLED" });
      setEditing(null);
      onChange();
    } catch (e) {
      console.error("save mode failed", e);
    }
  }

  if (editing) {
    return <ModeForm initial={editing} onCancel={() => setEditing(null)} onSave={save} />;
  }

  return (
    <div className="panel-body modes">
      <button type="button" className="add-mode top" onClick={() => setEditing(emptyMode())}>
        ＋ {t("modes.add")}
      </button>
      {modes.map((m) => {
        const triggers = [...m.triggerApps, ...m.triggerWebsites];
        const active = m.id === activeModeId;
        return (
          <div key={m.id} className={"mode-card" + (active ? " active" : "") + (m.enabled ? "" : " off")}>
            <div className="mode-top">
              <div className="mode-id">
                <span className="mode-n">{m.name}</span>
                {active ? <span className="mode-badge">● {t("modes.active")}</span> : null}
              </div>
              <div className="mode-actions">
                <button type="button" className="fa" onClick={() => setEditing({ ...m })}>
                  {t("modes.edit")}
                </button>
                {m.builtin ? null : (
                  <button type="button" className="fa danger" onClick={() => remove(m)}>
                    ✕
                  </button>
                )}
                <Toggle
                  on={m.enabled}
                  onToggle={() => toggle(m)}
                  labels={[t("modes.enabled"), t("modes.disabled")]}
                />
              </div>
            </div>
            <div className="mode-rules">
              <span className="mr">
                <span className="mr-k">{t("modes.trigger")}</span>
                {triggers.length ? triggers.join(" · ") : "—"}
              </span>
              <span className="mr">
                <span className="mr-k">{t("modes.lang")}</span>
                {langLabel(m.language)}
              </span>
              {m.keywords.length ? (
                <span className="mr">
                  <span className="mr-k">{t("modes.keywords")}</span>
                  {m.keywords.join(", ")}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ModeForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: Mode;
  onCancel: () => void;
  onSave: (m: Mode) => void;
}) {
  const [m, setM] = useState<Mode>(initial);
  const set = <K extends keyof Mode>(k: K, v: Mode[K]) => setM((s) => ({ ...s, [k]: v }));
  const isNew = !initial.name;

  return (
    <div className="panel-body modes-new">
      <div className="nm-head">
        <span className="nm-title">{isNew ? t("modes.new.title") : t("modes.new.edit")}</span>
        <button type="button" className="nm-cancel" onClick={onCancel}>
          ✕ {t("modes.cancel")}
        </button>
      </div>
      <div className="nm-field">
        <label>{t("modes.field.name")}</label>
        <input
          className="key-input"
          value={m.name}
          placeholder="E.G. EMAIL"
          onChange={(e) => set("name", e.target.value.toUpperCase())}
        />
      </div>
      <div className="nm-grid">
        <div className="nm-field">
          <label>
            {t("modes.field.apps")} <span>{t("modes.field.appsHint")}</span>
          </label>
          <input
            className="key-input"
            defaultValue={csv(m.triggerApps)}
            placeholder="Safari, Code"
            onChange={(e) => set("triggerApps", parseCsv(e.target.value))}
          />
        </div>
        <div className="nm-field">
          <label>
            {t("modes.field.sites")} <span>{t("modes.field.sitesHint")}</span>
          </label>
          <input
            className="key-input"
            defaultValue={csv(m.triggerWebsites)}
            placeholder="chatgpt.com"
            onChange={(e) => set("triggerWebsites", parseCsv(e.target.value))}
          />
        </div>
      </div>
      <div className="nm-grid">
        <div className="nm-field">
          <label>{t("modes.field.language")}</label>
          <select className="set-select" value={m.language} onChange={(e) => set("language", e.target.value)}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div className="nm-field">
          <label>
            {t("modes.field.keywords")} <span>{t("modes.field.keywordsHint")}</span>
          </label>
          <input
            className="key-input"
            defaultValue={csv(m.keywords)}
            placeholder="VOXCTL, Tauri, cpal"
            onChange={(e) => set("keywords", parseCsv(e.target.value))}
          />
        </div>
      </div>
      <button type="button" className="nm-save" onClick={() => onSave(m)}>
        ✓ {t("modes.save")}
      </button>
    </div>
  );
}
