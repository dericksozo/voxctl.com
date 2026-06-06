import { useEffect, useMemo, useState } from "react";
import { ProviderKeyCard } from "../components/ProviderKeyCard";
import { useConfig } from "../hooks/useConfig";
import { t } from "../i18n";
import {
  bootstrapDefaultMode,
  openPermissionSettings,
  requestAccessibility,
  requestMicrophone,
  startRecording,
  stopRecording,
} from "../lib/ipc";
import type { HistoryItem, PermissionStatus } from "../lib/types";
import {
  anyKeyValidated,
  costLabel,
  modelById,
  providerValidated,
  type ProviderId,
  type ProviderStatus,
  type Registry,
} from "../lib/registry";

export function OnboardingPanel({
  registry,
  providers,
  perms,
  history,
  recording,
  refreshProviders,
  refreshModes,
  refreshHistory,
  refreshPerms,
}: {
  registry: Registry | null;
  providers: ProviderStatus;
  perms: PermissionStatus;
  history: HistoryItem[];
  recording: boolean;
  refreshProviders: () => void;
  refreshModes: () => void;
  refreshHistory: () => void;
  refreshPerms: () => void;
}) {
  const { config, set } = useConfig();
  const [selectedProvider, setSelectedProvider] = useState<ProviderId | null>(null);
  const [baselineId, setBaselineId] = useState<number | null>(null);
  const [guidedStarted, setGuidedStarted] = useState(false);
  const [guidedDone, setGuidedDone] = useState(false);
  const [waitingForHistory, setWaitingForHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const hasKey = anyKeyValidated(providers);
  const firstValidated = useMemo(
    () => registry?.providers.find((p) => providerValidated(providers, p.id))?.id as ProviderId | undefined,
    [providers, registry],
  );
  const readyProvider = selectedProvider ?? firstValidated;
  const readyProviderRecord = registry?.providers.find((p) => p.id === readyProvider);
  const readyModel = readyProviderRecord ? modelById(registry, readyProviderRecord.defaultModelId) : undefined;
  const maxHistoryId = history.reduce((max, h) => Math.max(max, h.id), 0);

  useEffect(() => {
    if (baselineId === null || !guidedStarted) return;
    if (history.some((h) => h.id > baselineId)) {
      setGuidedDone(true);
      setWaitingForHistory(false);
    }
  }, [baselineId, guidedStarted, history]);

  async function validateProvider(provider: ProviderId) {
    await bootstrapDefaultMode(provider);
    setSelectedProvider(provider);
    refreshModes();
  }

  async function grantMic() {
    setBusy(true);
    setErr(null);
    try {
      await requestMicrophone();
      refreshPerms();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleGuidedRecording() {
    setErr(null);
    try {
      if (recording) {
        setWaitingForHistory(true);
        await stopRecording();
        refreshHistory();
      } else {
        setBaselineId(maxHistoryId);
        setGuidedStarted(true);
        setGuidedDone(false);
        setWaitingForHistory(false);
        await startRecording();
      }
    } catch (e) {
      setWaitingForHistory(false);
      setErr(String(e));
    }
  }

  async function enableAccessibility() {
    setBusy(true);
    setErr(null);
    try {
      const granted = await requestAccessibility();
      refreshPerms();
      if (granted) finish(false, true);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  function finish(skippedAccessibility: boolean, accessibilityGranted = perms.accessibility) {
    if (skippedAccessibility) set("accessibilitySkipped", true);
    else set("accessibilitySkipped", false);
    if (!accessibilityGranted) set("copyToClipboard", true);
    set("onboardingCompleted", true);
  }

  if (!perms.microphone) {
    return (
      <div className="panel-body onboarding">
        <StepHeader n="01" title={t("onboarding.mic.title")} text={t("onboarding.mic.desc")} />
        <div className="ob-actions">
          <button type="button" className="pc-btn" onClick={grantMic} disabled={busy}>
            {busy ? t("onboarding.working") : t("onboarding.mic.grant")}
          </button>
          <button
            type="button"
            className="pc-btn secondary"
            onClick={() => openPermissionSettings("microphone").catch(() => {})}
          >
            {t("perm.open")}
          </button>
        </div>
        {err ? <div className="ob-error">{err}</div> : null}
      </div>
    );
  }

  if (!hasKey) {
    return (
      <div className="panel-body onboarding">
        <StepHeader n="02" title={t("onboarding.key.title")} text={t("onboarding.key.desc")} />
        <div className="prov-list ob-providers">
          {(registry?.providers ?? []).map((p) => (
            <ProviderKeyCard
              key={p.id}
              provider={p}
              registry={registry}
              validated={providerValidated(providers, p.id)}
              recording={recording}
              onChanged={refreshProviders}
              onValidated={validateProvider}
              actionLabel={t("onboarding.key.connect")}
            />
          ))}
        </div>
        {registry ? <div className="set-hint">{t("onboarding.key.hint")}</div> : <div className="empty">// BOOTING REGISTRY</div>}
      </div>
    );
  }

  if (!config.onboardingCompleted && !guidedDone) {
    return (
      <div className="panel-body onboarding">
        <StepHeader n="03" title={t("onboarding.record.title")} text={t("onboarding.record.desc")} />
        <div className="ob-record-box">
          <div>
            <div className="ob-record-title">{t("onboarding.record.prompt")}</div>
            <div className="set-hint">{t("onboarding.record.meter")}</div>
          </div>
          <button type="button" className="ob-record-btn" onClick={toggleGuidedRecording}>
            {recording ? t("onboarding.record.stop") : t("onboarding.record.start")}
          </button>
        </div>
        {waitingForHistory ? <div className="ob-wait">{t("onboarding.record.saving")}</div> : null}
        {err ? <div className="ob-error">{err}</div> : null}
      </div>
    );
  }

  return (
    <div className="panel-body onboarding">
      <StepHeader n="04" title={t("onboarding.ready.title")} text={t("onboarding.ready.desc")} />
      <div className="ob-ready">
        <div className="ob-ready-line">
          {t("onboarding.ready.using")}{" "}
          <b>{readyModel?.label ?? t("onboarding.ready.modelFallback")}</b>
          {readyModel ? <span className="dim"> {costLabel(readyModel)}</span> : null}
        </div>
        <div className="ob-ready-line">
          {t("onboarding.ready.shortcut")} <b>{config.shortcut}</b>
        </div>
        {!perms.accessibility && !config.accessibilitySkipped ? (
          <div className="ob-ax">
            <div>
              <div className="ob-record-title">{t("onboarding.ax.title")}</div>
              <div className="set-hint">{t("onboarding.ax.desc")}</div>
            </div>
            <div className="ob-actions inline">
              <button type="button" className="pc-btn" onClick={enableAccessibility} disabled={busy}>
                {busy ? t("onboarding.working") : t("onboarding.ax.enable")}
              </button>
              <button type="button" className="pc-btn secondary" onClick={() => finish(true)}>
                {t("onboarding.ax.skip")}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="pc-btn ob-enter"
            onClick={() => finish(config.accessibilitySkipped && !perms.accessibility)}
          >
            {t("onboarding.ready.enter")}
          </button>
        )}
      </div>
      {err ? <div className="ob-error">{err}</div> : null}
    </div>
  );
}

function StepHeader({ n, title, text }: { n: string; title: string; text: string }) {
  return (
    <div className="ob-head">
      <span className="ob-step">{n}</span>
      <div>
        <div className="ob-title">{title}</div>
        <div className="ob-desc">{text}</div>
      </div>
    </div>
  );
}
