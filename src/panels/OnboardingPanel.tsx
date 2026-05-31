import { t } from "../i18n";
import type { PermissionStatus } from "../lib/types";

/** Permission review surface. Shown from the header banner when a required
 *  permission is missing; prompts and/or deep-links into System Settings. */
export function OnboardingPanel({
  permissions,
  onRecheck,
  onRequestMic,
  onRequestAccessibility,
  onOpen,
}: {
  permissions: PermissionStatus;
  onRecheck: () => void;
  onRequestMic: () => void;
  onRequestAccessibility: () => void;
  onOpen: (which: "microphone" | "accessibility") => void;
}) {
  return (
    <div className="panel-body onboard">
      <PermCard
        name={t("perm.mic.name")}
        desc={t("perm.mic.desc")}
        granted={permissions.microphone}
        actionLabel={t("perm.grant")}
        onAction={onRequestMic}
        onOpen={() => onOpen("microphone")}
      />
      <PermCard
        name={t("perm.ax.name")}
        desc={t("perm.ax.desc")}
        granted={permissions.accessibility}
        actionLabel={t("perm.grant")}
        onAction={onRequestAccessibility}
        onOpen={() => onOpen("accessibility")}
      />
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="button" className="pc-btn secondary" onClick={onRecheck}>
          ↻ {t("perm.recheck")}
        </button>
      </div>
    </div>
  );
}

function PermCard({
  name,
  desc,
  granted,
  actionLabel,
  onAction,
  onOpen,
}: {
  name: string;
  desc: string;
  granted: boolean;
  actionLabel: string;
  onAction: () => void;
  onOpen: () => void;
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
        <button type="button" className="pc-btn secondary" onClick={onOpen}>
          {t("perm.open")}
        </button>
        {granted ? null : (
          <button type="button" className="pc-btn" onClick={onAction}>
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}
