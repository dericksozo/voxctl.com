import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { HudMeter } from "./HudMeter";
import { Logo } from "../components/Primitives";
import { EVT, type BackendError, type RecState } from "../lib/events";

type Phase = "listening" | "transcribing" | "error";

/** Recording overlay floating above the focused app. Logo blinks while active. */
export function Hud() {
  const [phase, setPhase] = useState<Phase>("listening");

  useEffect(() => {
    const unsubs: Array<Promise<() => void>> = [];
    unsubs.push(
      listen<RecState>(EVT.recState, (e) => {
        if (e.payload.recording) setPhase("listening");
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
      <Logo recording={phase !== "error"} dark />
      <HudMeter phase={phase} />
    </div>
  );
}
