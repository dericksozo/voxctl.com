import "../styles/panels/onboarding.css";
import { type ReactNode, useMemo, useState } from "react";
import { ProviderKeyCard } from "../components/ProviderKeyCard";
import { Logo } from "../components/Primitives";
import { useConfig } from "../hooks/useConfig";
import {
  bootstrapDefaultMode,
  openPermissionSettings,
  requestAccessibility,
  requestMicrophone,
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

type StepStatus = "waiting" | "progress" | "done" | "error";

export function OnboardingPanel({
  registry,
  providers,
  perms,
  recording,
  refreshProviders,
  refreshModes,
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
  const [busyStep, setBusyStep] = useState<"mic" | "acc" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const hasKey = anyKeyValidated(providers);
  const firstValidated = useMemo(
    () => registry?.providers.find((p) => providerValidated(providers, p.id))?.id as ProviderId | undefined,
    [providers, registry],
  );
  const readyProvider = selectedProvider ?? firstValidated;
  const readyProviderRecord = registry?.providers.find((p) => p.id === readyProvider);
  const readyModel = readyProviderRecord ? modelById(registry, readyProviderRecord.defaultModelId) : undefined;

  // A revoked-after-setup step shows "needs attention" (error); an unmet step on
  // first launch shows "waiting". This drives the re-entry scenarios.
  const reentry = config.onboardingCompleted;
  function statusOf(satisfied: boolean, busy: boolean): StepStatus {
    if (busy) return "progress";
    if (satisfied) return "done";
    return reentry ? "error" : "waiting";
  }

  const micStatus = statusOf(perms.microphone, busyStep === "mic");
  const accStatus = statusOf(perms.accessibility, busyStep === "acc");
  const keyStatus = statusOf(hasKey, false);

  const doneCount = [perms.microphone, perms.accessibility, hasKey].filter(Boolean).length;
  const allDone = doneCount === 3;

  const note = !reentry
    ? "FIRST LAUNCH"
    : !perms.microphone
      ? "RE-ENTRY · MICROPHONE REVOKED"
      : !perms.accessibility
        ? "RE-ENTRY · ACCESSIBILITY REVOKED"
        : !hasKey
          ? "RE-ENTRY · ALL KEYS REMOVED"
          : "RE-ENTRY";

  async function validateProvider(provider: ProviderId) {
    await bootstrapDefaultMode(provider);
    setSelectedProvider(provider);
    refreshModes();
  }

  async function grantMic() {
    setBusyStep("mic");
    setErr(null);
    try {
      await requestMicrophone();
      refreshPerms();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusyStep(null);
    }
  }

  async function grantAccessibility() {
    setBusyStep("acc");
    setErr(null);
    try {
      await requestAccessibility();
      refreshPerms();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusyStep(null);
    }
  }

  // Accessibility is now a required gate, so there is no skip / clipboard
  // fallback. Completion simply records the flag; the App gate (mic + accessibility
  // + key all satisfied) lands the user in the app's empty state.
  function enterApp() {
    if (!allDone) return;
    set("onboardingCompleted", true);
  }

  return (
    <div className="panel-body onb-root">
      <div className="onb-panel">
        <span className="onb-corner tl" />
        <span className="onb-corner tr" />
        <span className="onb-corner bl" />
        <span className="onb-corner br" />

        <div className="onb-header">
          <div className="onb-brand">
            <Logo />
            <span className="onb-wordmark">VOXCTL</span>
          </div>
          <div className="onb-note">{note}</div>
          <div className="onb-title">SETUP REQUIRED</div>
          <p className="onb-sub">VOXCTL needs a few things set up to work properly.</p>
        </div>

        <div className="onb-steps">
          <StepRow
            n="1"
            icon={<MicIcon />}
            title="MICROPHONE ACCESS"
            desc="Required to hear your voice for transcription."
            status={micStatus}
            doneLabel="GRANTED"
            action={
              <>
                <button type="button" className="vx-btn vx-btn--mag" onClick={grantMic} disabled={busyStep !== null}>
                  {micStatus === "error" ? "RE-GRANT" : "GRANT"}
                </button>
                <button
                  type="button"
                  className="vx-btn"
                  onClick={() => openPermissionSettings("microphone").catch(() => {})}
                >
                  SYSTEM SETTINGS
                </button>
              </>
            }
          />

          <StepRow
            n="2"
            icon={<KeyboardIcon />}
            title="ACCESSIBILITY ACCESS"
            desc="Required to type transcribed text into your apps."
            status={accStatus}
            doneLabel="GRANTED"
            action={
              <>
                <button
                  type="button"
                  className="vx-btn vx-btn--mag"
                  onClick={grantAccessibility}
                  disabled={busyStep !== null}
                >
                  {accStatus === "error" ? "RE-GRANT" : "GRANT"}
                </button>
                <button
                  type="button"
                  className="vx-btn"
                  onClick={() => openPermissionSettings("accessibility").catch(() => {})}
                >
                  SYSTEM SETTINGS
                </button>
              </>
            }
          />

          <StepRow
            n="3"
            icon={<KeyIcon />}
            title="API KEY"
            desc="Add at least one provider key. VOXCTL is bring-your-own-key."
            status={keyStatus}
            doneLabel="ADDED"
            expanded={
              keyStatus === "done" ? (
                <div className="onb-key-summary">
                  <span className="mag">{(readyProvider ?? "").toUpperCase()}</span> key validated — using{" "}
                  <b>{readyModel?.label ?? "default model"}</b>
                  {readyModel ? <span> {costLabel(readyModel)}</span> : null}.
                </div>
              ) : (
                <div>
                  <div className="onb-expand-label">CHOOSE A PROVIDER AND ADD A KEY</div>
                  {registry ? (
                    <div className="prov-list">
                      {registry.providers.map((p) => (
                        <ProviderKeyCard
                          key={p.id}
                          provider={p}
                          registry={registry}
                          validated={providerValidated(providers, p.id)}
                          recording={recording}
                          onChanged={refreshProviders}
                          onValidated={validateProvider}
                          actionLabel="CONNECT"
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="empty">// BOOTING REGISTRY</div>
                  )}
                </div>
              )
            }
          />
        </div>

        <div className="onb-footer">
          <div className="onb-progress">
            <span className="onb-progress-txt">{doneCount} / 3 COMPLETE</span>
            <span className="onb-progress-bar">
              <span className="onb-progress-fill" style={{ width: `${(doneCount / 3) * 100}%` }} />
            </span>
          </div>
          <button
            type="button"
            className={"vx-btn vx-btn--mag onb-enter" + (allDone ? " ready" : "")}
            disabled={!allDone}
            onClick={enterApp}
          >
            {allDone ? "ENTER VOXCTL →" : "COMPLETE ALL STEPS"}
          </button>
        </div>

        {err ? <div className="onb-error">{err}</div> : null}
      </div>
    </div>
  );
}

function StepRow({
  n,
  icon,
  title,
  desc,
  status,
  doneLabel,
  action,
  expanded,
}: {
  n: string;
  icon: ReactNode;
  title: string;
  desc: string;
  status: StepStatus;
  doneLabel: string;
  action?: ReactNode;
  expanded?: ReactNode;
}) {
  const active = status === "waiting" || status === "error";
  return (
    <div
      className={
        "onb-step" +
        (status === "done" ? " is-done" : "") +
        (status === "error" ? " is-error" : "") +
        (active ? " is-active" : "")
      }
    >
      <div className="onb-step-main">
        <span className="onb-step-n">STEP {n}</span>
        <span className="onb-step-ico">{icon}</span>
        <div className="onb-step-body">
          <div className="onb-step-title">{title}</div>
          <div className="onb-step-desc">{desc}</div>
        </div>
        <div className="onb-step-actions">
          <StatusPill status={status} doneLabel={doneLabel} />
          {active && action ? action : null}
        </div>
      </div>
      {expanded ? <div className="onb-step-expand">{expanded}</div> : null}
    </div>
  );
}

function StatusPill({ status, doneLabel }: { status: StepStatus; doneLabel: string }) {
  const label =
    status === "done"
      ? doneLabel
      : status === "progress"
        ? "WORKING…"
        : status === "error"
          ? "NEEDS ATTENTION"
          : "WAITING";
  return (
    <span className={"onb-pill " + status}>
      {status === "done" ? <CheckIcon /> : null}
      {status === "progress" ? <span className="onb-spinner" /> : null}
      {status === "error" ? <AlertIcon /> : null}
      {status === "waiting" ? <span className="onb-pill-dot" /> : null}
      {label}
    </span>
  );
}

function MicIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" />
    </svg>
  );
}

function KeyboardIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 16h8" strokeLinecap="round" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="8" cy="8" r="5" />
      <path d="M11.5 11.5 21 21M17 17l2-2M14 14l2-2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <path d="M4 12.5 9.5 18 20 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 3 22 20H2L12 3Z" strokeLinejoin="round" />
      <path d="M12 10v4M12 17h.01" strokeLinecap="round" />
    </svg>
  );
}
