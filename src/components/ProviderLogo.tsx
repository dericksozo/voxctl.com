// Monochrome provider brand marks. Rendered in `currentColor` so callers control
// the tint (grayish via --ink-2, darkening to --ink on hover) — see the `.prov`
// class in theme.css. Brand glyphs are a deliberate exception to the otherwise
// icon-free, monospace aesthetic; they're used nominatively to identify each
// provider's key row / model.

import type { ProviderId } from "../lib/registry";

interface LogoProps {
  size?: number;
}

/** OpenAI "knot" mark. */
export function OpenAILogo({ size = 14 }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      role="img"
      aria-label="OpenAI"
    >
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

/** Gemini four-point star. */
export function GeminiLogo({ size = 14 }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      role="img"
      aria-label="Gemini"
    >
      <path d="M12 0c0 3.31-1.34 6.31-3.515 8.485C6.31 10.66 3.31 12 0 12c3.31 0 6.31 1.34 8.485 3.515C10.66 17.69 12 20.69 12 24c0-3.31 1.34-6.31 3.515-8.485C17.69 13.34 20.69 12 24 12c-3.31 0-6.31-1.34-8.485-3.515C13.34 6.31 12 3.31 12 0z" />
    </svg>
  );
}

/** xAI mark — the official single-color "X" glyph (the prototype's was wrong). */
export function XaiLogo({ size = 14 }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 363.81 403.53"
      fill="currentColor"
      role="img"
      aria-label="xAI"
    >
      <polygon points=".09 142.63 182.78 403.53 263.98 403.53 81.29 142.63 .09 142.63" />
      <polygon points="0 403.53 81.25 403.53 121.84 345.57 81.22 287.54 0 403.53" />
      <polygon points="363.81 0 282.56 0 142.16 200.52 182.79 258.53 363.81 0" />
      <polygon points="297.26 403.53 363.81 403.53 363.81 29.01 297.26 124.06 297.26 403.53" />
    </svg>
  );
}

/** Dispatcher keyed by provider id. Returns null for unknown providers. */
export function ProviderLogo({ id, size = 14 }: { id: string; size?: number }) {
  switch (id as ProviderId) {
    case "openai":
      return <OpenAILogo size={size} />;
    case "gemini":
      return <GeminiLogo size={size} />;
    case "xai":
      return <XaiLogo size={size} />;
    default:
      return null;
  }
}
