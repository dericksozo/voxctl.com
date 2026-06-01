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
      <path fill="var(--ink)" d="M 278 405 L 279 416 L 284 421 L 355 461 L 363 461 L 371 455 L 435 342 L 441 336 L 453 331 L 802 331 L 812 335 L 818 340 L 884 456 L 891 461 L 899 461 L 969 422 L 975 417 L 977 411 L 976 404 L 917 304 L 906 283 L 895 267 L 880 252 L 872 246 L 852 235 L 834 229 L 811 226 L 620 226 L 619 227 L 615 226 L 556 226 L 555 227 L 444 226 L 425 228 L 405 234 L 389 242 L 376 251 L 365 261 L 356 272 Z" />
      <path fill="var(--ink)" d="M 289 638 L 289 647 L 346 743 L 349 750 L 359 764 L 372 777 L 391 790 L 415 800 L 437 804 L 817 804 L 839 800 L 853 795 L 868 787 L 882 777 L 895 764 L 906 749 L 909 742 L 965 647 L 965 637 L 961 631 L 886 589 L 878 589 L 870 595 L 818 687 L 812 693 L 804 697 L 665 697 L 664 698 L 660 697 L 460 697 L 455 698 L 445 695 L 435 686 L 385 597 L 380 591 L 376 589 L 368 589 L 295 630 Z" />
      <path fill="var(--ink)" d="M 260 1024 L 262 1031 L 266 1035 L 329 1070 L 337 1070 L 343 1066 L 400 967 L 406 962 L 413 959 L 842 959 L 850 963 L 855 968 L 911 1066 L 917 1070 L 925 1070 L 983 1038 L 992 1031 L 994 1026 L 991 1016 L 931 913 L 921 899 L 901 881 L 883 871 L 864 865 L 847 863 L 408 863 L 386 866 L 371 871 L 354 880 L 347 885 L 332 900 L 326 908 L 263 1016 Z" />
      <path className="logo-pink" fill="var(--pink)" d="M 416 461 L 416 468 L 418 473 L 474 570 L 484 584 L 500 600 L 518 612 L 539 621 L 565 626 L 690 626 L 712 622 L 736 612 L 756 598 L 776 576 L 837 471 L 838 467 L 837 458 L 831 451 L 758 411 L 750 412 L 743 418 L 695 503 L 688 512 L 678 517 L 576 517 L 571 515 L 560 504 L 512 419 L 508 414 L 502 411 L 496 411 L 454 435 L 427 449 L 418 456 Z" />
    </svg>
  );
}
