// icons.jsx — provider logos (brand exception) + UI glyphs, terminal-adapted.
(function () {
  const S = (props) => {
    const { size = 16, stroke = 1.6, children, ...rest } = props;
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth={stroke} strokeLinecap="square"
           strokeLinejoin="miter" {...rest}>{children}</svg>
    );
  };

  // ---------- provider logos (monochrome, adapt to currentColor) ----------
  const OpenAI = ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-label="OpenAI">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/>
    </svg>
  );

  const Gemini = ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-label="Gemini">
      <path d="M12 0c0 3.31-1.34 6.31-3.515 8.485C6.31 10.66 3.31 12 0 12c3.31 0 6.31 1.34 8.485 3.515C10.66 17.69 12 20.69 12 24c0-3.31 1.34-6.31 3.515-8.485C17.69 13.34 20.69 12 24 12c-3.31 0-6.31-1.34-8.485-3.515C13.34 6.31 12 3.31 12 0z"/>
    </svg>
  );

  const Xai = ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-label="xAI">
      <path d="M3.2 2.4h5.05l5.02 7.16-2.52 3.6L3.2 2.4z"/>
      <path d="M3.0 21.6l6.02-8.6 2.52 3.6-2.85 5h-5.7z"/>
      <path d="M20.8 2.4l-7.16 10.22-2.52-3.6L15.1 2.4h5.7z"/>
      <path d="M14.55 12.84l2.52-3.6L20.8 21.6h-5.05l-1.2-8.76z"/>
    </svg>
  );

  const ProviderLogo = ({ id, size = 14 }) => {
    if (id === 'openai') return <OpenAI size={size} />;
    if (id === 'gemini') return <Gemini size={size} />;
    if (id === 'xai') return <Xai size={size} />;
    return null;
  };

  // ---------- UI glyphs ----------
  const Search = (p) => (<S {...p}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></S>);
  const Close  = (p) => (<S {...p}><path d="M6 6l12 12M18 6L6 18" /></S>);
  const Copy   = (p) => (<S {...p}><rect x="8.5" y="8.5" width="11" height="11" /><path d="M5.5 15.5h-1v-11h11v1" /></S>);
  const Play   = (p) => (<svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5l13 7.5-13 7.5z" /></svg>);
  const Stop   = (p) => (<svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="currentColor"><rect x="5.5" y="5.5" width="13" height="13" /></svg>);
  const ChevDown = (p) => (<S {...p} strokeLinecap="round"><path d="M5 9l7 7 7-7" /></S>);
  const Rerun  = (p) => (<S {...p} strokeLinecap="round"><path d="M20 11a8 8 0 1 0-.6 4" /><path d="M20 4v5h-5" /></S>);
  const Trash  = (p) => (<S {...p}><path d="M4 7h16" /><path d="M9 7V4.5h6V7" /><path d="M6 7l1 13h10l1-13" /></S>);
  const Check  = (p) => (<S {...p} strokeLinecap="round" strokeLinejoin="round"><path d="M4 12.5l5 5L20 6" /></S>);
  const ArrowR = (p) => (<S {...p} strokeLinecap="round"><path d="M4 12h15M13 6l6 6-6 6" /></S>);
  const Plus   = (p) => (<S {...p}><path d="M12 5v14M5 12h14" /></S>);
  const Star   = (p) => (<svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill={p.fill||'none'} stroke="currentColor" strokeWidth={p.stroke||1.6} strokeLinejoin="round"><path d="M12 3.5l2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 16.9l-5.25 2.8 1-5.85L3.5 9.65l5.9-.85z" /></svg>);
  const Mic    = (p) => (<S {...p} strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></S>);
  const Keyboard = (p) => (<S {...p} strokeLinecap="round"><rect x="3" y="6" width="18" height="12" rx="1" /><path d="M7 10h0M11 10h0M15 10h0M8 14h8" /></S>);
  const Key    = (p) => (<S {...p}><circle cx="8" cy="8" r="4" /><path d="M11 11l8 8M16 16l2-2M18.5 18.5l1.5-1.5" /></S>);
  const Waiting = (p) => (<S {...p} strokeLinecap="round"><path d="M12 4a8 8 0 1 0 8 8" /></S>);
  const Alert  = (p) => (<S {...p} strokeLinecap="round"><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17h0" /></S>);

  // ---------- mascot ----------
  const Mascot = ({ size = 34 }) => (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      <path d="M6 14 L6 8 L14 8" stroke="currentColor" strokeWidth="3" />
      <path d="M42 14 L42 8 L34 8" stroke="currentColor" strokeWidth="3" />
      <path d="M6 34 L6 40 L14 40" stroke="currentColor" strokeWidth="3" />
      <path d="M42 34 L42 40 L34 40" stroke="currentColor" strokeWidth="3" />
      <rect x="12" y="16" width="24" height="16" rx="2" fill="currentColor" />
      <circle cx="19" cy="24" r="2.4" fill="var(--mag)" />
      <circle cx="29" cy="24" r="2.4" fill="var(--mag)" />
      <rect x="20" y="28.5" width="8" height="1.6" fill="var(--mag)" />
    </svg>
  );

  // ---------- QR glyph (deterministic) ----------
  const QR = ({ size = 26, cells = 9 }) => {
    const seed = [
      1,1,1,0,1,0,1,1,1,
      1,0,1,1,0,1,0,0,1,
      1,1,1,0,1,1,1,0,1,
      0,0,0,1,0,0,1,1,0,
      1,1,0,1,1,0,1,0,1,
      0,1,1,0,0,1,0,1,1,
      1,1,1,0,1,0,1,1,1,
      1,0,0,1,1,1,0,0,0,
      1,1,1,0,1,0,1,1,1,
    ];
    const g = size / cells;
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="currentColor">
        {seed.map((v, i) => v ? <rect key={i} x={(i % cells) * g} y={Math.floor(i / cells) * g} width={g} height={g} /> : null)}
      </svg>
    );
  };

  window.Icons = {
    ProviderLogo, OpenAI, Gemini, Xai,
    Search, Close, Copy, Play, Stop, ChevDown, Rerun, Trash, Check, ArrowR, Plus, Star,
    Mic, Keyboard, Key, Waiting, Alert, Mascot, QR,
  };
})();
