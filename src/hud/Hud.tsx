import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { HudMeter } from "./HudMeter";
import { EVT, type RecState } from "../lib/events";
import { LANGUAGES } from "../lib/languages";
import { setRecordingLanguage } from "../lib/ipc";

type Phase = "listening" | "transcribing";

/** Minimal recording overlay: REC dot, live dB meter, partial transcript, and
 *  an on-the-fly language override (brief §4). Lives in its own borderless,
 *  always-on-top window so it floats over whatever app is focused. After stop it
 *  stays up briefly showing the streaming transcript until the backend hides it. */
export function Hud() {
  const [partial, setPartial] = useState("");
  const [lang, setLang] = useState<string>("auto");
  const [phase, setPhase] = useState<Phase>("listening");

  useEffect(() => {
    const unsubs: Array<Promise<() => void>> = [];
    unsubs.push(
      listen<RecState>(EVT.recState, (e) => {
        if (e.payload.recording) {
          setPartial("");
          setPhase("listening");
          setLang(e.payload.language ?? "auto");
        } else {
          setPhase("transcribing");
        }
      }),
    );
    unsubs.push(listen<{ text: string }>(EVT.transcriptPartial, (e) => setPartial(e.payload.text)));
    return () => {
      unsubs.forEach((p) => p.then((u) => u()));
    };
  }, []);

  function onLang(e: React.ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value;
    setLang(v);
    setRecordingLanguage(v === "auto" ? null : v).catch(() => {});
  }

  const text = partial
    ? partial
    : phase === "transcribing"
      ? "TRANSCRIBING…"
      : "LISTENING…";

  return (
    <div className={"hud" + (phase === "transcribing" ? " transcribing" : "")}>
      <span className="hud-dot" />
      <HudMeter />
      <span className={"hud-text" + (partial ? "" : " dim")}>{text}</span>
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
