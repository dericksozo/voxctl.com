import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { EVT, type MicLevel, type RecState } from "../lib/events";

const pad = (n: number) => String(n).padStart(2, "0");

/** Footer INPUT meter. Subscribes to the single high-frequency mic-level event
 *  and updates DOM nodes imperatively (toggling block classes + the dB text),
 *  bypassing React reconciliation entirely. When idle no event fires, so the
 *  meter sits at zero and costs nothing. */
export function VolumeMeter({ count = 12 }: { count?: number }) {
  const blocksRef = useRef<HTMLSpanElement>(null);
  const dbRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const blocksEl = blocksRef.current;
    const dbEl = dbRef.current;
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    // Gate level updates on the recording lifecycle. Because no event fires when
    // idle, the meter would otherwise freeze on whatever level was emitted last
    // when recording stopped (showing residual pink blocks). We reset to zero on
    // stop and ignore any straggler mic-level events that arrive after it.
    let recording = false;

    function render(v: number) {
      if (!blocksEl) return;
      const filled = Math.round(v * count);
      const children = blocksEl.children;
      for (let i = 0; i < children.length; i++) {
        children[i].className = "blk accent" + (i < filled ? " on" : "");
      }
      if (dbEl) dbEl.textContent = `${pad(Math.round(v * 60))} dB`;
    }

    const track = (p: Promise<() => void>) =>
      p.then((u) => {
        if (disposed) u();
        else unlisteners.push(u);
      });

    track(
      listen<MicLevel>(EVT.micLevel, (e) => {
        if (!recording) return;
        render(Math.max(0, Math.min(1, e.payload.db)));
      }),
    );
    track(
      listen<RecState>(EVT.recState, (e) => {
        recording = e.payload.recording;
        if (!recording) render(0);
      }),
    );

    return () => {
      disposed = true;
      unlisteners.forEach((u) => u());
    };
  }, [count]);

  const cells = [];
  for (let i = 0; i < count; i++) cells.push(<span key={i} className="blk accent" />);

  return (
    <>
      <span className="blocks" ref={blocksRef}>
        {cells}
      </span>
      <span className="gr-v num" ref={dbRef}>
        00 dB
      </span>
    </>
  );
}
