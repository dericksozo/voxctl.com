import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { EVT, type MicLevel } from "../lib/events";

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
    let unlisten: (() => void) | undefined;
    let disposed = false;

    listen<MicLevel>(EVT.micLevel, (e) => {
      if (!blocksEl) return;
      const v = Math.max(0, Math.min(1, e.payload.db));
      const filled = Math.round(v * count);
      const children = blocksEl.children;
      for (let i = 0; i < children.length; i++) {
        children[i].className = "blk accent" + (i < filled ? " on" : "");
      }
      if (dbEl) dbEl.textContent = `${pad(Math.round(v * 60))} dB`;
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });

    return () => {
      disposed = true;
      unlisten?.();
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
