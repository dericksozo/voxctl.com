import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { EVT, type MicLevel } from "../lib/events";

/** Canvas dB meter for the HUD. Subscribes to the single mic-level event and
 *  paints directly to canvas — never triggers React re-render. */
export function HudMeter() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const bars = 16;
    const gap = 2;
    const bw = (w - gap * (bars - 1)) / bars;
    let level = 0;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let raf = 0;

    listen<MicLevel>(EVT.micLevel, (e) => {
      level = Math.max(0, Math.min(1, e.payload.db));
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });

    const pink = getComputedStyle(document.documentElement).getPropertyValue("--pink").trim() || "#f60092";

    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      const filled = Math.round(level * bars);
      for (let i = 0; i < bars; i++) {
        const bh = Math.max(2, (h * (0.25 + (i / bars) * 0.75)) | 0);
        ctx.fillStyle = i < filled ? pink : "rgba(22,25,29,0.12)";
        ctx.fillRect(i * (bw + gap), (h - bh) / 2, bw, bh);
      }
      // smooth decay so the meter falls back even between events
      level *= 0.92;
      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      unlisten?.();
    };
  }, []);

  return <canvas className="hud-meter" ref={ref} />;
}
