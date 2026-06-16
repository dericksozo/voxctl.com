import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { pinMode, unpinMode } from "../lib/ipc";
import { modeUsable, type ProviderStatus, type Registry } from "../lib/registry";
import type { ActiveMode, Mode } from "../lib/types";

/** Top-bar active-mode control: shows the active mode + WHY it's active
 *  (pinned/auto/default), and is a dropdown to pin a different mode or unpin.
 *  A manual pin is sticky across app switches until explicitly unpinned. */
export function ModeSwitcher({
  modes,
  active,
  registry,
  providers,
  onChange,
  recording = false,
}: {
  modes: Mode[];
  active: ActiveMode | null;
  registry: Registry | null;
  providers: ProviderStatus;
  onChange: () => void;
  /** While recording, the mode is locked — the switcher is disabled. */
  recording?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Recording locks the active mode — make sure an open menu closes.
  useEffect(() => {
    if (recording) setOpen(false);
  }, [recording]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [open]);

  const enabled = modes.filter((m) => m.enabled);
  const name = active?.mode.name ?? "—";
  const reason = active?.reason ?? null;
  const pinned = reason === "pinned";

  async function pick(id: string) {
    try {
      await pinMode(id);
    } catch {
      /* ignore */
    }
    setOpen(false);
    onChange();
  }
  async function unpin() {
    try {
      await unpinMode();
    } catch {
      /* ignore */
    }
    setOpen(false);
    onChange();
  }

  return (
    <div className="mode-switch" ref={ref}>
      <button
        type="button"
        className={"mode-pill" + (pinned ? " pinned" : "")}
        onClick={() => setOpen((o) => !o)}
        disabled={recording}
        title={recording ? t("mode.lockedRecording") : undefined}
      >
        {t("header.activeMode")} <b>▸ {name}</b>
        {reason ? <span className="ms-reason">{t("mode.reason." + reason)}</span> : null}
      </button>
      {open ? (
        <div className="ms-menu">
          <div className="ms-menu-head">{t("mode.switch")}</div>
          {enabled.length === 0 ? (
            <div className="ms-empty">// NO ENABLED MODES</div>
          ) : (
            enabled.map((m) => {
              // A mode whose provider key was removed can't run — don't let it
              // be selected. Show it locked instead of silently pinning a dud.
              const usable = modeUsable(registry, providers, m.model);
              return (
                <button
                  key={m.id}
                  type="button"
                  className={
                    "ms-item" +
                    (m.id === active?.mode.id ? " sel" : "") +
                    (usable ? "" : " is-locked")
                  }
                  disabled={!usable}
                  onClick={() => pick(m.id)}
                >
                  <span className="ms-radio">{m.id === active?.mode.id ? "●" : "○"}</span>
                  <span className="ms-name">{m.name}</span>
                  {usable ? null : <span className="ms-lock">{t("modes.keyRequired")}</span>}
                </button>
              );
            })
          )}
          {pinned ? (
            <button type="button" className="ms-unpin" onClick={unpin}>
              ✕ {t("mode.unpin")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
