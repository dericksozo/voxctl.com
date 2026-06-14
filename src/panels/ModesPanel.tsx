import { useState } from "react";
import "../styles/panels/modes.css";
import { Toggle } from "../components/Primitives";
import { ProviderLogo } from "../components/ProviderLogo";
import { t } from "../i18n";
import { langLabel, LANGUAGES } from "../lib/languages";
import { deleteMode, saveMode, setModeEnabled } from "../lib/ipc";
import type { HistoryItem, Mode } from "../lib/types";
import {
  type Capabilities,
  costLabel,
  modelBadge,
  modelById,
  type ModelRecord,
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
  defaultModeId,
  registry,
  providers,
  history,
  recording,
  onChange,
  go,
}: {
  modes: Mode[];
  activeModeId: string | null;
  defaultModeId: string | null;
  registry: Registry | null;
  providers: ProviderStatus;
  history: HistoryItem[] | null | undefined;
  recording: boolean;
  onChange: () => void;
  go: (panel: string) => void;
}) {
  const [editing, setEditing] = useState<Mode | null>(null);
  // Inline two-step delete confirm: holds the id of the mode awaiting confirmation.
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  // A mode is "in use" — and so locked from edit/delete — while it drives the
  // live recording, or while a recording it produced is still transcribing.
  // History stores the mode *name* (not id), so match by name for the
  // transcribing window; that's sufficient for a UI lock.
  const transcribingNames = new Set(
    (history ?? [])
      .filter((h) => h.status === "recording" || h.status === "transcribing")
      .map((h) => h.modeName),
  );
  const isInUse = (m: Mode) =>
    (recording && m.id === activeModeId) || transcribingNames.has(m.name);

  async function toggle(m: Mode) {
    try {
      await setModeEnabled(m.id, !m.enabled);
      onChange();
    } catch {
      /* ignore */
    }
  }
  async function remove(m: Mode) {
    setConfirmDel(null);
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

  const renderMode = (m: Mode) => {
    const triggers = [...m.triggerApps, ...m.triggerWebsites];
    const active = m.id === activeModeId;
    // Only the default mode is non-deletable; every other mode (incl. shipped
    // presets) can be removed.
    const isDefault = m.id === defaultModeId;
    // Locked from edit/delete while recording with it or transcribing its output.
    const inUse = isInUse(m);
    const model = modelById(registry, m.model);
    const providerLabel =
      model && registry
        ? (registry.providers.find((p) => p.id === model.provider)?.label ?? model.provider)
        : null;
    return (
      <div
        key={m.id}
        className={"vxm-card" + (active ? " is-active" : "") + (m.enabled ? "" : " is-off")}
      >
        <div className="vxm-card-head">
          <span className="vxm-name">{m.name}</span>
          {active ? <span className="vxm-active-badge">● {t("modes.active")}</span> : null}
          {inUse ? <span className="vxm-inuse-badge">{t("modes.inUse")}</span> : null}
          <div className="vxm-card-actions">
            <button
              type="button"
              className="vx-btn"
              disabled={inUse}
              title={inUse ? t("modes.inUseHint") : undefined}
              onClick={() => setEditing({ ...m })}
            >
              {t("modes.edit")}
            </button>
            {isDefault ? null : confirmDel === m.id ? (
              <div className="vxm-del-confirm">
                <span className="vxm-del-q">{t("modes.delete")} ?</span>
                <button type="button" className="vx-btn" onClick={() => setConfirmDel(null)}>
                  {t("modes.cancel")}
                </button>
                <button
                  type="button"
                  className="vx-btn vx-btn--danger"
                  onClick={() => remove(m)}
                >
                  {t("modes.delete")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="vx-btn vx-btn--danger vxm-del"
                aria-label={t("modes.delete")}
                disabled={inUse}
                title={inUse ? t("modes.inUseHint") : undefined}
                onClick={() => setConfirmDel(m.id)}
              >
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
        <div className="vxm-rules">
          <span className="vxm-field">
            <span className="vxm-field-k">{t("modes.model")}</span>
            <span className="vxm-model">
              {model ? (
                <span className="prov" aria-hidden="true">
                  <ProviderLogo id={model.provider} size={13} />
                </span>
              ) : null}
              {providerLabel ? `${providerLabel} · ` : ""}
              {model?.label ?? m.model.toUpperCase()}
              {model ? (
                <span className={model.canLive ? "vxm-live" : "vxm-file"}>
                  {modelBadge(model)}
                </span>
              ) : null}
            </span>
          </span>
          <span className="vxm-field">
            <span className="vxm-field-k">{t("modes.trigger")}</span>
            <span className={"vxm-field-v" + (triggers.length ? "" : " is-muted")}>
              {triggers.length ? triggers.join(" · ") : "—"}
            </span>
          </span>
          <span className="vxm-field">
            <span className="vxm-field-k">{t("modes.lang")}</span>
            <span className="vxm-field-v">{langLabel(m.language)}</span>
          </span>
          {m.keywords.length ? (
            <span className="vxm-field">
              <span className="vxm-field-k">{t("modes.keywords")}</span>
              <span className="vxm-field-v vxm-keywords">{m.keywords.join(", ")}</span>
            </span>
          ) : null}
        </div>
      </div>
    );
  };

  // Hierarchy: default mode first → separator → add button → custom modes.
  const defaultMode = modes.find((m) => m.id === defaultModeId) ?? null;
  const customModes = modes.filter((m) => m.id !== defaultModeId);

  return (
    <div className="panel-body vxm-list">
      {defaultMode ? renderMode(defaultMode) : null}
      <div className="vxm-sep" />
      <button
        type="button"
        className="vxm-define"
        onClick={() => setEditing(emptyMode(defaultModelId(registry, providers)))}
      >
        <span className="vxm-define-plus">＋</span>
        {t("modes.add")}
      </button>
      {customModes.map(renderMode)}
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
  // xAI rejects ITN (`format=true`) unless an explicit language is set ("Field
  // 'language' is required when 'format' is true"). Block saving that invalid
  // combination and point the user at the language field.
  const itnNeedsLang =
    selModel?.provider === "xai" &&
    !!m.capabilities.inverseTextNormalization &&
    (m.language === "auto" || !m.language);
  // xAI silently drops speaker labels on long file transcriptions (~55+ min), so
  // flag the limitation when an xAI file mode enables diarization. Reactive to
  // current state: disappears if diarization is off, provider changes, or the
  // model isn't file-capable.
  const xaiDiarizationHint =
    selModel?.provider === "xai" && !!selModel?.canFile && !!m.capabilities.diarization;

  // Selecting a model resets fields the new model doesn't support, so we never
  // persist (or send) a language/keywords a model ignores.
  function selectModel(id: string) {
    const mod = modelById(registry, id);
    setM((s) => ({
      ...s,
      model: id,
      language: mod?.supportsLanguage ? s.language : "auto",
      keywords: mod?.supportsKeywords ? s.keywords : [],
    }));
  }

  return (
    <div className="panel-body vxm-form">
      <div className="vxm-form-head">
        <span className="vxm-form-title">{isNew ? t("modes.new.title") : t("modes.new.edit")}</span>
        <button type="button" className="vx-btn" onClick={onCancel}>
          ✕ {t("modes.cancel")}
        </button>
      </div>
      <div className="vxm-field-block">
        <label className="lbl">{t("modes.field.name")}</label>
        <input
          className="vxm-input"
          value={m.name}
          placeholder="E.G. EMAIL"
          onChange={(e) => set("name", e.target.value.toUpperCase())}
        />
      </div>

      <div className="vxm-field-block">
        <label className="lbl">{t("modes.field.model")}</label>
        <ModelPicker
          registry={registry}
          providers={providers}
          selected={m.model}
          onSelect={selectModel}
          go={go}
        />
      </div>

      {selModel ? <ModelInfo model={selModel} /> : null}

      {caps.length > 0 ? (
        <div className="vxm-field-block">
          <label className="lbl">{t("modes.field.capabilities")}</label>
          <div className="vxm-caps">
            {caps.map((c) => (
              <div key={c.key} className="vxm-cap-row">
                <span className="vxm-cap-label">{c.label}</span>
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
          {xaiDiarizationHint ? (
            <p className="vxm-warn vxm-warn--info">{t("modes.xaiDiarizationHint")}</p>
          ) : null}
        </div>
      ) : null}

      <div className="vxm-grid">
        <div className="vxm-field-block">
          <label className="lbl">
            {t("modes.field.apps")} <span className="vxm-hint">{t("modes.field.appsHint")}</span>
          </label>
          <input
            className="vxm-input"
            defaultValue={csv(m.triggerApps)}
            placeholder="Safari, Code"
            onChange={(e) => set("triggerApps", parseCsv(e.target.value))}
          />
        </div>
        <div className="vxm-field-block">
          <label className="lbl">
            {t("modes.field.sites")} <span className="vxm-hint">{t("modes.field.sitesHint")}</span>
          </label>
          <input
            className="vxm-input"
            defaultValue={csv(m.triggerWebsites)}
            placeholder="chatgpt.com"
            onChange={(e) => set("triggerWebsites", parseCsv(e.target.value))}
          />
        </div>
      </div>
      {/* Language and keywords only show for models that honor them. */}
      {selModel?.supportsLanguage ? (
        <div className="vxm-field-block">
          <label className="lbl">{t("modes.field.language")}</label>
          <select
            className="vxm-select"
            value={m.language}
            onChange={(e) => set("language", e.target.value)}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          {itnNeedsLang ? <p className="vxm-warn">⚠ {t("modes.itnNeedsLang")}</p> : null}
        </div>
      ) : null}
      {selModel?.supportsKeywords ? (
        <div className="vxm-field-block">
          <label className="lbl">
            {t("modes.field.keywords")}{" "}
            <span className="vxm-hint">{t("modes.field.keywordsHint")}</span>
          </label>
          <input
            key={m.model}
            className="vxm-input"
            defaultValue={csv(m.keywords)}
            placeholder="VOXCTL, Tauri, cpal"
            onChange={(e) => set("keywords", parseCsv(e.target.value))}
          />
        </div>
      ) : null}
      <button
        type="button"
        className="vxm-save"
        disabled={itnNeedsLang}
        onClick={() => onSave(m)}
      >
        ✓ {t("modes.save")}
      </button>
    </div>
  );
}

/** Expanded detail for the currently selected model: what it is, when to use
 *  it, accuracy/speed, and price. The teaching surface for the one place a user
 *  picks a model. */
function ModelInfo({ model }: { model: ModelRecord }) {
  return (
    <div className="vxm-info">
      <div className="vxm-info-head">
        <span className="vxm-info-name">{model.label}</span>
        <span className="vxm-badge">{modelBadge(model)}</span>
        <span className="vxm-info-cost">{costLabel(model)}</span>
      </div>
      {model.description ? <div className="vxm-info-desc">{model.description}</div> : null}
      <div className="vxm-info-stats">
        {model.accuracy ? (
          <span>
            <span className="vxm-info-k">{t("modes.accuracy")}</span> {model.accuracy}
          </span>
        ) : null}
        {model.speed ? (
          <span>
            <span className="vxm-info-k">{t("modes.speed")}</span> {model.speed}
          </span>
        ) : null}
      </div>
      {model.useCase ? <div className="vxm-info-use">↳ {model.useCase}</div> : null}
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
  if (!registry) return <div className="vxm-empty">// REGISTRY UNAVAILABLE</div>;

  return (
    <div className="vxm-picker">
      {registry.providers.map((p) => {
        const models = modelsForProvider(registry, p.id);
        if (models.length === 0) return null;
        const validated = providerValidated(providers, p.id);
        return (
          <div key={p.id} className={"vxm-mp-group" + (validated ? "" : " is-locked")}>
            <div className="vxm-mp-head">
              <span className="vxm-mp-prov">
                <span className={"vxm-prov-dot " + (validated ? "on" : "off")} />
                <span className="prov" aria-hidden="true">
                  <ProviderLogo id={p.id} size={13} />
                </span>
                {p.label}
              </span>
              {validated ? null : (
                <button type="button" className="vxm-mp-addkey" onClick={() => go("settings")}>
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
                  className={"vxm-mp-row" + (isSel ? " is-sel" : "")}
                  disabled={!validated}
                  onClick={() => onSelect(mod.id)}
                >
                  <span className="vxm-mp-radio">{isSel ? "●" : "○"}</span>
                  <span className="vxm-mp-main">
                    <span className="vxm-mp-name-row">
                      <span className="vxm-mp-name">{mod.label}</span>
                      <span className="vxm-badge">{modelBadge(mod)}</span>
                      <span className="vxm-mp-cost">{costLabel(mod)}</span>
                    </span>
                    {mod.description ? <span className="vxm-mp-desc">{mod.description}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
      <div className="vxm-mp-legend">{t("modes.badgeLegend")}</div>
    </div>
  );
}
