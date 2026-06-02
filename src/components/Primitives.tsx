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

/** VOXCTL emblem. Inlined (not <img>) so the paths can be themed with --pink/--ink
 *  and the pink chevron can blink while recording. */
export function Logo({ recording = false }: { recording?: boolean }) {
  return (
    <svg
      className={"logo-mark" + (recording ? " recording" : "")}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1254 1254"
      fillRule="evenodd"
      role="img"
      aria-label="VOXCTL"
    >
      <path fill="var(--ink)" d="M90.199 265.955L91.6848 282.299L99.1137 289.727L204.604 349.159H216.49L228.377 340.244L323.467 172.351L332.381 163.436L350.211 156.007H868.749L883.607 161.95L892.521 169.379L990.583 341.73L1000.98 349.159H1012.87L1116.87 291.213L1125.79 283.784L1128.76 274.87L1127.27 264.469L1039.61 115.891L1023.27 84.6896L1006.93 60.917L984.64 38.6303L972.753 29.7156L943.038 13.372L916.294 4.45735L882.121 0H598.336L596.851 1.48578L590.908 0H503.246L501.761 1.48578L336.839 0L308.609 2.97156L278.893 11.8863L255.121 23.7725L235.806 37.1445L219.462 52.0024L206.09 68.346L90.199 265.955Z" />
      <path fill="var(--ink)" d="M106.543 612.142V625.514L191.232 768.149L195.69 778.55L210.547 799.351L229.863 818.666L258.092 837.981L293.751 852.839L326.438 858.782H891.036L923.723 852.839L944.524 845.41L966.81 833.524L987.611 818.666L1006.93 799.351L1023.27 777.064L1027.73 766.663L1110.93 625.514V610.656L1104.99 601.742L993.554 539.339H981.668L969.782 548.254L892.521 684.945L883.607 693.86L871.72 699.803H665.197L663.711 701.289L657.768 699.803H360.611L353.182 701.289L338.325 696.832L323.467 683.46L249.178 551.225L241.749 542.31L235.806 539.339H223.919L115.457 600.256L106.543 612.142Z" />
      <path fill="var(--ink)" d="M63.455 1185.65L66.4265 1196.05L72.3696 1202L165.974 1254H177.86L186.775 1248.06L271.464 1100.96L280.379 1093.54L290.78 1089.08H928.18L940.066 1095.02L947.495 1102.45L1030.7 1248.06L1039.61 1254H1051.5L1137.68 1206.45L1151.05 1196.05L1154.02 1188.63L1149.56 1173.77L1060.41 1020.73L1045.56 999.931L1015.84 973.187L989.097 958.329L960.867 949.415L935.609 946.443H283.351L250.663 950.9L228.377 958.329L203.118 971.701L192.718 979.13L170.431 1001.42L161.517 1013.3L67.9123 1173.77L63.455 1185.65Z" />
      <path className="logo-pink" fill="var(--pink)" d="M295.237 349.159V359.559L298.209 366.988L381.412 511.109L396.27 531.91L420.043 555.682L446.787 573.512L477.988 586.884L516.619 594.313H702.341L735.028 588.37L770.687 573.512L800.403 552.711L830.119 520.024L920.751 364.016L922.237 358.073L920.751 344.701L911.837 334.301L803.374 274.87L791.488 276.355L781.088 285.27L709.77 411.561L699.37 424.934L684.512 432.362H532.962L525.533 429.391L509.19 413.047L437.872 286.756L431.929 279.327L423.014 274.87H414.1L351.697 310.528L311.581 331.329L298.209 341.73L295.237 349.159Z" />
    </svg>
  );
}
