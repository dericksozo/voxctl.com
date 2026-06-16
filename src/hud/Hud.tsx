import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { HudMeter } from "./HudMeter";
import { Logo } from "../components/Primitives";
import { EVT, type BackendError, type RecState } from "../lib/events";

type Phase = "listening" | "transcribing" | "error";

/** Minimal recording overlay matching the app's CRT aesthetic: a framed panel
 *  with grid + scanlines + corner brackets, the VOXCTL logo (its pink chevron
 *  blinks — slowly while recording, faster while the transcript is processing),
 *  and a square level meter. No text and no language picker (transcription is
 *  realtime and language-agnostic). Lives in its own borderless, always-on-top,
 *  NEVER-focused window so it floats over the focused app without stealing key
 *  focus (critical for text injection). The transcript is injected into the
 *  focused field — intentionally NOT shown here. */
export function Hud() {
  const [phase, setPhase] = useState<Phase>("listening");

  useEffect(() => {
    const unsubs: Array<Promise<() => void>> = [];
    unsubs.push(
      listen<RecState>(EVT.recState, (e) => {
        if (e.payload.recording) setPhase("listening");
        // Stop → processing (unless an error already came through).
        else setPhase((p) => (p === "error" ? p : "transcribing"));
      }),
    );
    unsubs.push(listen<BackendError>(EVT.error, () => setPhase("error")));
    return () => {
      unsubs.forEach((p) => p.then((u) => u()));
    };
  }, []);

  return (
    <div
      className={
        "hud" +
        (phase === "transcribing" ? " transcribing" : "") +
        (phase === "error" ? " error" : "")
      }
    >
      <Logo recording={phase !== "error"} />
      <HudMeter phase={phase} />
    </div>
  );
}
