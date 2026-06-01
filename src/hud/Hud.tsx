import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { HudMeter } from "./HudMeter";
import { EVT, type BackendError, type RecState } from "../lib/events";
import { LANGUAGES } from "../lib/languages";
import { setRecordingLanguage } from "../lib/ipc";

type Phase = "listening" | "transcribing" | "error";

/** Minimal recording overlay: REC dot, live dB meter, a clear status
 *  (LISTENING → TRANSCRIBING), and an on-the-fly language override (brief §4).
 *  Lives in its own borderless, always-on-top, NEVER-focused window so it floats
 *  over whatever app is focused without stealing key focus. The transcript is
 *  injected into the focused field — it is intentionally NOT shown here (it used
 *  to stream into this pill and clip). On a backend failure it shows a quiet
 *  ERROR status and the backend hides the window shortly after. */
export function Hud() {
  const [lang, setLang] = useState<string>("auto");
  const [phase, setPhase] = useState<Phase>("listening");

  useEffect(() => {
    const unsubs: Array<Promise<() => void>> = [];
    unsubs.push(
      listen<RecState>(EVT.recState, (e) => {
        if (e.payload.recording) {
          setPhase("listening");
          setLang(e.payload.language ?? "auto");
        } else {
          // Stop → transcribing (unless an error already came through).
          setPhase((p) => (p === "error" ? p : "transcribing"));
        }
      }),
    );
    unsubs.push(listen<BackendError>(EVT.error, () => setPhase("error")));
    return () => {
      unsubs.forEach((p) => p.then((u) => u()));
    };
  }, []);

  function onLang(e: React.ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value;
    setLang(v);
    setRecordingLanguage(v === "auto" ? null : v).catch(() => {});
  }

  const text =
    phase === "error" ? "✕ ERROR" : phase === "transcribing" ? "TRANSCRIBING…" : "LISTENING…";

  return (
    <div
      className={
        "hud" +
        (phase === "transcribing" ? " transcribing" : "") +
        (phase === "error" ? " error" : "")
      }
    >
      <span className="hud-dot" />
      <HudMeter />
      <span className="hud-text dim">{text}</span>
      {phase === "listening" ? (
        <select className="hud-lang" value={lang} onChange={onLang} title="Transcription language">
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
