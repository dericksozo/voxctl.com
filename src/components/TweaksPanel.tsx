// DEV-only visual tweaks panel. Rendered behind an `import.meta.env.DEV` guard
// in App, so it is tree-shaken out of production builds. Self-contained styles
// to keep the production theme.css clean.

import { useState } from "react";

export interface Theme {
  pink: string;
  scanlines: boolean;
  grid: boolean;
  headerFont: "Orbitron" | "Share Tech Mono";
}

export const DEFAULT_THEME: Theme = {
  pink: "#F60092",
  scanlines: true,
  grid: true,
  headerFont: "Orbitron",
};

const PINKS = ["#F60092", "#FF1744", "#D500F9", "#FF6D00"];
const box: React.CSSProperties = {
  position: "fixed",
  right: 16,
  bottom: 16,
  zIndex: 2147483646,
  width: 232,
  background: "rgba(250,249,247,.82)",
  backdropFilter: "blur(20px) saturate(160%)",
  WebkitBackdropFilter: "blur(20px) saturate(160%)",
  border: ".5px solid rgba(255,255,255,.6)",
  borderRadius: 12,
  boxShadow: "0 12px 40px rgba(0,0,0,.18)",
  font: "11.5px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif",
  color: "#29261b",
  padding: "10px 12px 12px",
};

export function TweaksPanel({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  const [open, setOpen] = useState(false);
  const set = <K extends keyof Theme>(k: K, v: Theme[K]) => onChange({ ...theme, [k]: v });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          position: "fixed",
          right: 16,
          bottom: 16,
          zIndex: 2147483646,
          padding: "6px 10px",
          borderRadius: 8,
          border: ".5px solid rgba(0,0,0,.15)",
          background: "rgba(250,249,247,.82)",
          backdropFilter: "blur(20px)",
          font: "11px ui-sans-serif,system-ui,sans-serif",
        }}
      >
        ⚙ tweaks
      </button>
    );
  }

  return (
    <div style={box}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <b style={{ fontSize: 12 }}>Tweaks · DEV</b>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={{ border: 0, background: "transparent", fontSize: 13, color: "rgba(41,38,27,.55)" }}
        >
          ✕
        </button>
      </div>

      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".06em", opacity: 0.5, margin: "6px 0 4px" }}>
        PALETTE
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {PINKS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => set("pink", c)}
            aria-label={c}
            style={{
              flex: 1,
              height: 26,
              borderRadius: 6,
              border: theme.pink === c ? "2px solid rgba(0,0,0,.8)" : ".5px solid rgba(0,0,0,.15)",
              background: c,
            }}
          />
        ))}
      </div>

      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".06em", opacity: 0.5, margin: "10px 0 4px" }}>
        DISPLAY
      </div>
      <Row label="Scanlines" on={theme.scanlines} onClick={() => set("scanlines", !theme.scanlines)} />
      <Row label="Grid field" on={theme.grid} onClick={() => set("grid", !theme.grid)} />
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        {(["Orbitron", "Share Tech Mono"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => set("headerFont", f)}
            style={{
              flex: 1,
              padding: "5px 4px",
              borderRadius: 6,
              border: 0,
              fontSize: 10,
              background: theme.headerFont === f ? "rgba(0,0,0,.8)" : "rgba(0,0,0,.06)",
              color: theme.headerFont === f ? "#fff" : "inherit",
            }}
          >
            {f}
          </button>
        ))}
      </div>
    </div>
  );
}

function Row({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0" }}>
      <span style={{ opacity: 0.72 }}>{label}</span>
      <button
        type="button"
        onClick={onClick}
        style={{
          position: "relative",
          width: 32,
          height: 18,
          borderRadius: 999,
          border: 0,
          background: on ? "#34c759" : "rgba(0,0,0,.15)",
        }}
      >
        <i
          style={{
            position: "absolute",
            top: 2,
            left: 2,
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: "#fff",
            transform: on ? "translateX(14px)" : "none",
            transition: "transform .15s",
          }}
        />
      </button>
    </div>
  );
}
