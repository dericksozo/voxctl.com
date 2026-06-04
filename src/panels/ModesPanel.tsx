import { useState } from "react";
import { Toggle } from "../components/Primitives";
import { t } from "../i18n";
import { langLabel, LANGUAGES } from "../lib/languages";
import { deleteMode, saveMode, setModeEnabled } from "../lib/ipc";
import type { Mode } from "../lib/types";
import {
  type Capabilities,
  costLabel,
  modelBadge,
  modelById,
  modelsForProvider,
  providerValidated,
  type ProviderStatus,
  type Registry,
} from "../lib/registry";

const csv = (xs: string[]) => xs.join(", ");
const parseCsv = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** Capability toggles the editor reveals only when the chosen model declares them. */
const CAP_FIELDS: { key: keyof Capabilities; label: string }[] = [
  { key: "wordTimestamps", label: "WORD TIMESTAMPS" },
  { key: "diarization", label: "SPEAKER DIARIZATION" },
  { key: "inverseTextNormalization", label: "INVERSE TEXT NORMALIZATION" },
  { key: "multichannel", label: "MULTICHANNEL" },
];

/** Default model for a brand-new mode: the first validated provider's default,
 *  else the first registry model, else the live whisper fallback. */
function defaultModelId(registry: Registry | null, providers: ProviderStatus): string {
  if (!registry) return "gpt-realtime-whisper";
  for (const p of registry.providers) {
    if (providerValidated(providers, p.id)) return p.defaultModelId;
  }
  return registry.models[0]?.id ?? "gpt-realtime-whisper";
}

function emptyMode(model: string): Mode {
  return {
    id: "m" + Date.now(),
    name: "",
    enabled: true,
    language: "auto",
    keywords: [],
    triggerApps: [],
    triggerWebsites: [],
    model,
    capabilities: {},
    builtin: false,
  };
}

export function ModesPanel({
  modes,
  activeModeId,
  registry,
  providers,
  onChange,
  go,
}: {
  modes: Mode[];
  activeModeId: string | null;
  registry: Registry | null;
  providers: ProviderStatus;
  onChange: () => void;
  go: (panel: string) => void;
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
    return (
      <ModeForm
        initial={editing}
        registry={registry}
        providers={providers}
        go={go}
        onCancel={() => setEditing(null)}
        onSave={save}
      />
    );
  }

  return (
    <div className="panel-body modes">
      <button
        type="button"
        className="add-mode top"
        onClick={() => setEditing(emptyMode(defaultModelId(registry, providers)))}
      >
        ＋ {t("modes.add")}
      </button>
      {modes.map((m) => {
        const triggers = [...m.triggerApps, ...m.triggerWebsites];
        const active = m.id === activeModeId;
        const model = modelById(registry, m.model);
        const providerLabel =
          model && registry
            ? (registry.providers.find((p) => p.id === model.provider)?.label ?? model.provider)
            : null;
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
                <span className="mr-k">{t("modes.model")}</span>
                {providerLabel ? `${providerLabel} · ` : ""}
                {model?.label ?? m.model.toUpperCase()}
                {model ? <span className="mode-badge mp-badge">{modelBadge(model)}</span> : null}
              </span>
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
  registry,
  providers,
  go,
  onCancel,
  onSave,
}: {
  initial: Mode;
  registry: Registry | null;
  providers: ProviderStatus;
  go: (panel: string) => void;
  onCancel: () => void;
  onSave: (m: Mode) => void;
}) {
  const [m, setM] = useState<Mode>(initial);
  const set = <K extends keyof Mode>(k: K, v: Mode[K]) => setM((s) => ({ ...s, [k]: v }));
  const isNew = !initial.name;

  const selModel = modelById(registry, m.model);
  const caps = selModel ? CAP_FIELDS.filter((c) => selModel.capabilities[c.key]) : [];

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

      <div className="nm-field">
        <label>{t("modes.field.model")}</label>
        <ModelPicker
          registry={registry}
          providers={providers}
          selected={m.model}
          onSelect={(id) => set("model", id)}
          go={go}
        />
      </div>

      {caps.length > 0 ? (
        <div className="nm-field">
          <label>{t("modes.field.capabilities")}</label>
          <div className="cap-toggles">
            {caps.map((c) => (
              <div key={c.key} className="cap-row">
                <span className="cap-label">{c.label}</span>
                <Toggle
                  on={!!m.capabilities[c.key]}
                  onToggle={() =>
                    set("capabilities", { ...m.capabilities, [c.key]: !m.capabilities[c.key] })
                  }
                  labels={[t("settings.on"), t("settings.off")]}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}

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

/** Provider-gated model picker. Models whose provider lacks a validated key are
 *  disabled with an inline "add key" link. Each row shows a LIVE/FILE badge. */
function ModelPicker({
  registry,
  providers,
  selected,
  onSelect,
  go,
}: {
  registry: Registry | null;
  providers: ProviderStatus;
  selected: string;
  onSelect: (id: string) => void;
  go: (panel: string) => void;
}) {
  if (!registry) return <div className="empty">// REGISTRY UNAVAILABLE</div>;

  return (
    <div className="model-picker">
      {registry.providers.map((p) => {
        const models = modelsForProvider(registry, p.id);
        if (models.length === 0) return null;
        const validated = providerValidated(providers, p.id);
        return (
          <div key={p.id} className={"mp-group" + (validated ? "" : " locked")}>
            <div className="mp-group-head">
              <span className="mp-prov">
                <span className={"prov-dot " + (validated ? "on" : "off")} />
                {p.label}
              </span>
              {validated ? null : (
                <button type="button" className="mp-addkey" onClick={() => go("settings")}>
                  {t("modes.addKey", { provider: p.label })} →
                </button>
              )}
            </div>
            {models.map((mod) => {
              const isSel = mod.id === selected;
              return (
                <button
                  key={mod.id}
                  type="button"
                  className={"mp-row" + (isSel ? " sel" : "")}
                  disabled={!validated}
                  onClick={() => onSelect(mod.id)}
                >
                  <span className="mp-radio">{isSel ? "●" : "○"}</span>
                  <span className="mp-name">{mod.label}</span>
                  <span className="mp-badge">{modelBadge(mod)}</span>
                  <span className="mp-cost">{costLabel(mod)}</span>
                </button>
              );
            })}
          </div>
        );
      })}
      <div className="mp-legend">{t("modes.badgeLegend")}</div>
    </div>
  );
}
