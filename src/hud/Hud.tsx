import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { HudMeter } from "./HudMeter";
import { Logo } from "../components/Primitives";
import { copyHudResult, dismissHudResult } from "../lib/ipc";
import {
  EVT,
  type BackendError,
  type HudResultEvent,
  type RecState,
} from "../lib/events";

type Phase = "listening" | "transcribing" | "ready" | "copied" | "error";

const IDLE_MS = 15_000;
const COPIED_MS = 900;
const FADE_MS = 150;

/**
 * Recording overlay floating above the focused app.
 *
 * Two-mode surface:
 *  - listening / transcribing: passive meter, click-through.
 *  - ready / copied: interactive result card with copy + dismiss.
 *
 * The transcript itself never reaches this component. Copy/dismiss commands
 * echo back the generation token from the `HUD_RESULT` event, so stale timers
 * cannot act on a newer card or recording.
 */
export function Hud() {
  const [phase, setPhase] = useState<Phase>("listening");
  const [leaving, setLeaving] = useState(false);
  const phaseRef = useRef<Phase>(phase);
  const generationRef = useRef<number | null>(null);
  const hoveredRef = useRef(false);
  const leavingRef = useRef(false);
  const idleTimer = useRef<number | undefined>(undefined);
  const actionTimer = useRef<number | undefined>(undefined);
  const fadeTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const clearTimers = useCallback(() => {
    window.clearTimeout(idleTimer.current);
    window.clearTimeout(actionTimer.current);
    window.clearTimeout(fadeTimer.current);
  }, []);

  const dismiss = useCallback(() => {
    const generation = generationRef.current;
    if (generation == null || leavingRef.current) return;
    leavingRef.current = true;
    clearTimers();
    setLeaving(true);
    fadeTimer.current = window.setTimeout(() => {
      dismissHudResult(generation).catch((e) =>
        console.error("dismiss HUD result failed", e),
      );
      generationRef.current = null;
      leavingRef.current = false;
      setLeaving(false);
      setPhase("listening");
    }, FADE_MS);
  }, [clearTimers]);

  const startIdle = useCallback(() => {
    window.clearTimeout(idleTimer.current);
    if (hoveredRef.current || phaseRef.current !== "ready") return;
    idleTimer.current = window.setTimeout(dismiss, IDLE_MS);
  }, [dismiss]);

  const copy = useCallback(async () => {
    const generation = generationRef.current;
    if (generation == null || leavingRef.current || phaseRef.current !== "ready") return;
    try {
      await copyHudResult(generation);
    } catch (e) {
      // Keep the card up so the user can retry / dismiss manually.
      console.error("copy HUD result failed", e);
      return;
    }
    // A new result/recording may have arrived while the write was in flight.
    if (generationRef.current !== generation || phaseRef.current !== "ready") return;
    window.clearTimeout(idleTimer.current);
    setPhase("copied");
    actionTimer.current = window.setTimeout(dismiss, COPIED_MS);
  }, [dismiss]);

  useEffect(() => {
    const unsubs: Array<Promise<() => void>> = [];

    unsubs.push(
      listen<RecState>(EVT.recState, (e) => {
        if (e.payload.recording) {
          // A new recording always owns the HUD; discard any visible card and
          // invalidate its timers.
          clearTimers();
          generationRef.current = null;
          hoveredRef.current = false;
          leavingRef.current = false;
          setLeaving(false);
          setPhase("listening");
        } else {
          setPhase((p) => (p === "error" ? p : "transcribing"));
        }
      }),
    );

    unsubs.push(
      listen<HudResultEvent>(EVT.hudResult, (e) => {
        clearTimers();
        generationRef.current = e.payload.generation;
        leavingRef.current = false;
        setLeaving(false);
        if (e.payload.autoCopied) {
          // Delivery already wrote the clipboard: show the check, then go.
          setPhase("copied");
          actionTimer.current = window.setTimeout(dismiss, COPIED_MS);
        } else {
          setPhase("ready");
          idleTimer.current = window.setTimeout(dismiss, IDLE_MS);
        }
      }),
    );

    unsubs.push(
      listen<BackendError>(EVT.error, () => {
        // Never clobber a transcript the user can still copy.
        setPhase((p) => (p === "ready" || p === "copied" ? p : "error"));
      }),
    );

    return () => {
      clearTimers();
      unsubs.forEach((p) => p.then((u) => u()));
    };
  }, [clearTimers, dismiss]);

  // Keyboard only reaches the HUD once it has focus (after a click).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
        return;
      }
      if (
        phaseRef.current === "ready" &&
        (e.key === "Enter" || (e.metaKey && e.key.toLowerCase() === "c"))
      ) {
        e.preventDefault();
        void copy();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [copy, dismiss]);

  const interactive = phase === "ready" || phase === "copied";
  const activeLogo = phase === "listening" || phase === "transcribing";

  function onEnter() {
    hoveredRef.current = true;
    window.clearTimeout(idleTimer.current);
  }

  function onLeave() {
    hoveredRef.current = false;
    startIdle();
  }

  return (
    <div
      className={
        "hud" +
        (phase === "transcribing" ? " transcribing" : "") +
        (phase === "error" ? " error" : "") +
        (interactive ? " interactive" : "") +
        (leaving ? " leaving" : "")
      }
      onMouseEnter={interactive ? onEnter : undefined}
      onMouseLeave={interactive ? onLeave : undefined}
      onClick={interactive ? () => void copy() : undefined}
    >
      <Logo recording={activeLogo} dark />
      <HudMeter phase={phase} />
      {interactive ? (
        <>
          <button
            type="button"
            className={"hud-copy" + (phase === "copied" ? " copied" : "")}
            title="Copy transcript"
            aria-label="Copy transcript"
            onClick={(e) => {
              e.stopPropagation();
              void copy();
            }}
          >
            {phase === "copied" ? <CheckIcon /> : <CopyIcon />}
          </button>
          <button
            type="button"
            className="hud-dismiss"
            title="Dismiss"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              dismiss();
            }}
          >
            <XIcon />
          </button>
        </>
      ) : null}
    </div>
  );
}

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      aria-hidden="true"
    >
      <path d="M4 12.5 9.5 18 20 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M5 5l14 14M19 5 5 19" strokeLinecap="round" />
    </svg>
  );
}
