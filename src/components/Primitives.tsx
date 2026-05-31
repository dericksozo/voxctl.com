// Stateless presentational primitives, ported from the design prototype.
import type { CSSProperties, ReactNode } from "react";

/** Primary framed window with corner brackets. Top-level windows only. */
export function Frame({
  children,
  className,
  style,
  label,
  tr,
}: {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  label?: ReactNode;
  tr?: ReactNode;
}) {
  return (
    <div className={"frame " + (className || "")} style={style}>
      <span className="ck tl" />
      <span className="ck tr" />
      <span className="ck bl" />
      <span className="ck br" />
      {label ? <span className="frame-tag">{label}</span> : null}
      {tr ? <span className="frame-tag frame-tag-r">{tr}</span> : null}
      {children}
    </div>
  );
}

/** Plain inner card — no corner brackets. */
export function Card({
  children,
  className,
  label,
  style,
}: {
  children?: ReactNode;
  className?: string;
  label?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={"card " + (className || "")} style={style}>
      {label ? <div className="card-tag">{label}</div> : null}
      {children}
    </div>
  );
}

/** Discrete block meter. `value` is 0..1. */
export function Blocks({ value, count, accent }: { value: number; count: number; accent?: boolean }) {
  const filled = Math.max(0, Math.min(count, Math.round(value * count)));
  const cells = [];
  for (let i = 0; i < count; i++) {
    cells.push(<span key={i} className={"blk" + (i < filled ? " on" : "") + (accent ? " accent" : "")} />);
  }
  return <span className="blocks">{cells}</span>;
}

export function Toggle({
  on,
  onToggle,
  labels,
}: {
  on: boolean;
  onToggle: () => void;
  labels?: [string, string];
}) {
  const [a, b] = labels || ["ON", "OFF"];
  return (
    <button type="button" className={"toggle" + (on ? " on" : "")} onClick={onToggle}>
      <span className="toggle-track">
        <span className="toggle-knob" />
      </span>
      <span className="toggle-label">{on ? a : b}</span>
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          className={"seg-opt" + (o.value === value ? " on" : "")}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Deterministic stylized QR glyph (decorative greeble). */
export function Qr({ seed, n = 7 }: { seed: number; n?: number }) {
  let s = seed || 7;
  const cells = [];
  for (let i = 0; i < n * n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const r = Math.floor(i / n);
    const c = i % n;
    const finder = (r < 3 && c < 3) || (r < 3 && c >= n - 3) || (r >= n - 3 && c < 3);
    const edge = r === 0 || c === 0 || r === 2 || c === 2 || r === n - 1 || c === n - 1 || r === n - 3 || c === n - 3;
    const on = finder ? edge : s % 5 > 1;
    cells.push(<i key={i} className={on ? "on" : ""} />);
  }
  return (
    <span className="qr" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}>
      {cells}
    </span>
  );
}
