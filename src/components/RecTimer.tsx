import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { EVT, type RecState } from "../lib/events";
import { t } from "../i18n";

const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (secs: number) => `${Math.floor(secs / 60)}:${pad(Math.floor(secs % 60))}`;

/** Footer recording timer. Self-contained leaf (like Clock): owns its interval
 *  and visibility so the rest of the app never re-renders on the second. Counts
 *  from the authoritative `startedAt` carried by the rec-state start event; hides
 *  on stop. */
export function RecTimer() {
  const [label, setLabel] = useState<string | null>(null);
  const startedAt = useRef<number>(0);

  useEffect(() => {
    let disposed = false;
    let iv: ReturnType<typeof setInterval> | null = null;
    const unlisteners: Array<() => void> = [];

    const stop = () => {
      if (iv) {
        clearInterval(iv);
        iv = null;
      }
    };

    const track = (p: Promise<() => void>) =>
      p.then((u) => {
        if (disposed) u();
        else unlisteners.push(u);
      });

    track(
      listen<RecState>(EVT.recState, (e) => {
        if (e.payload.recording) {
          startedAt.current = e.payload.startedAt ?? Date.now();
          const tick = () =>
            setLabel(fmt(Math.max(0, (Date.now() - startedAt.current) / 1000)));
          tick();
          stop();
          iv = setInterval(tick, 1000);
        } else {
          stop();
          setLabel(null);
        }
      }),
    );

    return () => {
      disposed = true;
      stop();
      unlisteners.forEach((u) => u());
    };
  }, []);

  if (label === null) return null;
  return (
    <div className="gr">
      <span className="gr-k">{t("footer.rec")}</span>
      <span className="gr-v num">{label}</span>
    </div>
  );
}
