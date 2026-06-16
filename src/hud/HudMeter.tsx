import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { EVT, type MicLevel } from "../lib/events";

const COUNT = 7;

/** HUD level indicator — square blocks matching the app footer meter
 *  (src/components/VolumeMeter.tsx). Updates the DOM imperatively (no React
 *  re-renders), painting once per animation frame.
 *   - listening:    blocks fill left→right with the live mic level.
 *   - transcribing: indeterminate "scanner" sweep (no mic data while processing).
 *   - error:        all blocks cleared. */
export function HudMeter({ phase }: { phase: "listening" | "transcribing" | "error" }) {
  const blocksRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const blocksEl = blocksRef.current;
    if (!blocksEl) return;
    const cells = blocksEl.children;
    const paint = (lit: (i: number) => boolean) => {
      for (let i = 0; i < cells.length; i++) {
        cells[i].className = "blk accent" + (lit(i) ? " on" : "");
      }
    };

    if (phase === "error") {
      paint(() => false);
      return;
    }

    if (phase === "transcribing") {
      // Indeterminate progress: a 2-wide lit band bounces left↔right.
      const period = 900; // ms for one left→right pass
      let raf = requestAnimationFrame(function draw() {
        const t = (performance.now() % (period * 2)) / period; // 0..2
        const head = (t < 1 ? t : 2 - t) * (COUNT - 1); // triangle 0..(N-1)..0
        paint((i) => Math.abs(i - head) < 1);
        raf = requestAnimationFrame(draw);
      });
      return () => cancelAnimationFrame(raf);
    }

    // listening: live mic level with smooth decay between events
    let level = 0;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen<MicLevel>(EVT.micLevel, (e) => {
      level = Math.max(0, Math.min(1, e.payload.db));
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    let raf = requestAnimationFrame(function draw() {
      const filled = Math.round(level * COUNT);
      paint((i) => i < filled);
      level *= 0.92;
      raf = requestAnimationFrame(draw);
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      unlisten?.();
    };
  }, [phase]);

  const cells = [];
  for (let i = 0; i < COUNT; i++) cells.push(<span key={i} className="blk accent" />);
  return (
    <span className="blocks" ref={blocksRef}>
      {cells}
    </span>
  );
}
