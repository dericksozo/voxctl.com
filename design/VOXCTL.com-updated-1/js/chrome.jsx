// chrome.jsx — window shell, sidebar, header, footer, content frame.
(function () {
  const { useState, useEffect } = React;
  const I = window.Icons;

  // ---------- macOS window bar ----------
  function WindowBar() {
    return (
      <div className="win__bar">
        <div className="lights">
          <span className="light light--r" />
          <span className="light light--y" />
          <span className="light light--g" />
        </div>
        <div className="win__title">VOXCTL</div>
        <div />
      </div>
    );
  }

  // ---------- corner brackets ----------
  function Corners({ color = 'var(--ink)', size = 18, weight = 2 }) {
    const base = { position: 'absolute', width: size, height: size, pointerEvents: 'none' };
    const b = `${weight}px solid ${color}`;
    return (
      <React.Fragment>
        <span style={{ ...base, top: 0, left: 0, borderTop: b, borderLeft: b }} />
        <span style={{ ...base, top: 0, right: 0, borderTop: b, borderRight: b }} />
        <span style={{ ...base, bottom: 0, left: 0, borderBottom: b, borderLeft: b }} />
        <span style={{ ...base, bottom: 0, right: 0, borderBottom: b, borderRight: b }} />
      </React.Fragment>
    );
  }

  // ---------- header (wordmark + active mode) ----------
  function HeaderBar() {
    return (
      <header style={hdr.wrap}>
        <div style={hdr.left}>
          <div style={hdr.kicker}>VOCAL CONTROL PROTOCOL</div>
          <div style={hdr.word}>VOXCTL</div>
        </div>
        <div style={hdr.rule}>
          <span style={hdr.ruleLine} />
          <span style={hdr.diamond} />
        </div>
        <div style={hdr.right}>
          <div style={hdr.modePill}>
            <span style={{ color: 'var(--ink-2)', letterSpacing: '0.18em' }}>ACTIVE MODE</span>
            <span style={{ color: 'var(--mag)' }}>&#9656;</span>
            <span style={{ color: 'var(--mag)', fontWeight: 700, letterSpacing: '0.14em' }}>XAI LIVE</span>
            <span style={hdr.pinned}>PINNED</span>
          </div>
          <div style={hdr.status}>
            <Stat label="LINK" /> <Dot /> <Stat label="KEY" /> <Dot /> <Stat label="SET" />
          </div>
        </div>
      </header>
    );
  }
  const Dot = () => <span style={{ color: 'var(--ink-4)', margin: '0 4px' }}>&middot;</span>;
  const Stat = ({ label }) => (
    <span>{label} <span style={{ color: 'var(--mag)' }}>&#10003;</span></span>
  );

  // ---------- sidebar ----------
  const NAV = [
    { id: 'home',     n: '01', label: 'HOME',     sub: '150 RECORDINGS · 333 MIN' },
    { id: 'modes',    n: '02', label: 'MODES',    sub: '8 MODES · CONTEXT-AWARE PRESETS' },
    { id: 'stats',    n: '03', label: 'STATS',    sub: 'USAGE · TIME · SPEND' },
    { id: 'settings', n: '04', label: 'SETTINGS', sub: 'SYSTEM CONFIG' },
  ];

  const SYSDESC = {
    home:     'TRANSMISSION LOG. SEARCH, PLAY BACK AUDIO, COPY TRANSCRIPTS, RE-TRANSCRIBE, PURGE ARCHIVES.',
    modes:    'CONTEXT PRESETS. BIND LANGUAGE, KEYWORDS AND TRIGGERS TO APPS AND WEBSITES.',
    stats:    'USAGE DASHBOARD. WORDS CAPTURED, RECLAIMED TIME AND ACTIVE INTERFACES AT A GLANCE.',
    settings: 'MANAGE PROVIDER KEYS. EACH IS VALIDATED AND STORED IN THE MACOS KEYCHAIN — NEVER IN PLAINTEXT.',
  };

  function Sidebar({ screen, onNav }) {
    return (
      <aside style={side.wrap}>
        <div style={side.navHead} className="lbl">// SELECT FUNCTION</div>
        <nav style={side.nav}>
          {NAV.map((item) => {
            const active = item.id === screen;
            return (
              <button key={item.id} onClick={() => onNav(item.id)} style={side.item(active)}>
                <span style={side.cursor(active)}>&#8629;</span>
                <span style={side.num(active)}>{item.n}</span>
                <span style={side.itemBody}>
                  <span style={side.label(active)}>{item.label}</span>
                  <span style={side.sub(active)}>{item.sub}</span>
                </span>
              </button>
            );
          })}
        </nav>

        <div style={side.foot}>
          <div style={side.mascotRow}>
            <span style={{ color: 'var(--ink)' }}><I.Mascot size={42} /></span>
            <div>
              <div style={side.mascotId}>VX-MENU-0xA7</div>
              <div style={side.mascotRev}>REV 2.4 · <span style={{ color: 'var(--ink-2)' }}>READY</span></div>
            </div>
          </div>
          <div style={side.descHead} className="lbl">// SYS.DESC</div>
          <div style={side.descBox}>
            <Corners color="var(--ink-3)" size={14} weight={1.5} />
            <p style={side.descText}>
              {SYSDESC[screen]}<span className="caret" />
            </p>
          </div>
        </div>
      </aside>
    );
  }

  // ---------- footer ----------
  function Footer() {
    const [clock, setClock] = useState(fmt());
    function fmt() {
      const d = new Date();
      return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
        .map((x) => String(x).padStart(2, '0')).join(':');
    }
    useEffect(() => { const t = setInterval(() => setClock(fmt()), 1000); return () => clearInterval(t); }, []);
    const meter = Array.from({ length: 14 });
    return (
      <footer style={ft.wrap}>
        <div style={ft.left}>
          <span className="lbl" style={{ color: 'var(--ink-2)' }}>INPUT</span>
          <span style={ft.meter}>
            {meter.map((_, i) => (
              <span key={i} style={{ width: 8, height: 12, border: '1px solid var(--ink-4)', background: 'transparent' }} />
            ))}
          </span>
          <span style={{ color: 'var(--ink-2)', letterSpacing: '0.12em' }}>00 dB</span>
          <span style={ft.sep} />
          <span className="lbl" style={{ color: 'var(--ink-2)' }}>MODE</span>
          <span style={{ color: 'var(--mag)' }}>&#9656; XAI LIVE</span>
          <span style={ft.sep} />
          <span className="lbl" style={{ color: 'var(--ink-2)' }}>SFX</span>
          <span style={{ color: 'var(--mag)', fontWeight: 600 }}>ON</span>
        </div>
        <div style={ft.right}>
          <span style={{ color: 'var(--ink-2)', letterSpacing: '0.12em' }}>UTC {clock}</span>
          <span style={{ color: 'var(--ink)' }}><I.QR size={24} /></span>
        </div>
      </footer>
    );
  }

  // ---------- content frame ----------
  function ContentFrame({ label, children, scroll = true }) {
    return (
      <section style={cf.wrap}>
        <Corners color="var(--ink)" size={20} weight={2} />
        <div style={cf.head}>
          <span style={cf.label} className="lbl">// {label}</span>
          <span style={cf.line} />
          <span style={cf.tag} className="lbl">VX-0xA7</span>
        </div>
        <div className={scroll ? 'vscroll' : ''} style={cf.body(scroll)}>
          {children}
        </div>
      </section>
    );
  }

  window.Chrome = { WindowBar, HeaderBar, Sidebar, Footer, ContentFrame, Corners };

  /* ---------------- styles ---------------- */
  const hdr = {
    wrap: { display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center', gap: 28, padding: '26px 40px 18px' },
    left: {},
    kicker: { fontSize: 13, letterSpacing: '0.34em', color: 'var(--ink-2)', fontWeight: 500, marginBottom: 6 },
    word: { fontFamily: 'var(--display)', fontWeight: 800, fontSize: 58, lineHeight: 0.86, letterSpacing: '0.01em', color: 'var(--mag)' },
    rule: { position: 'relative', display: 'flex', alignItems: 'center', height: '100%', minWidth: 60, marginTop: 18 },
    ruleLine: { flex: 1, height: 1, background: 'var(--line)' },
    diamond: { width: 12, height: 12, background: 'var(--mag)', transform: 'rotate(45deg)', marginLeft: -2 },
    right: { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 8, minWidth: 440, marginTop: 8 },
    modePill: { display: 'flex', alignItems: 'center', gap: 11, border: '1.5px solid var(--mag)', background: 'var(--mag-soft)', padding: '11px 18px', fontSize: 16, fontWeight: 500, whiteSpace: 'nowrap' },
    pinned: { marginLeft: 'auto', fontSize: 11, letterSpacing: '0.16em', color: 'var(--mag)', border: '1px solid var(--mag-line)', padding: '2px 6px' },
    status: { alignSelf: 'flex-end', fontSize: 13, letterSpacing: '0.16em', color: 'var(--ink-2)', fontWeight: 500, whiteSpace: 'nowrap' },
  };

  const side = {
    wrap: { display: 'flex', flexDirection: 'column', padding: '4px 34px 26px 40px', borderRight: '1px solid var(--line-soft)', minHeight: 0 },
    navHead: { fontSize: 13, marginBottom: 22 },
    nav: { display: 'flex', flexDirection: 'column', gap: 26 },
    item: (a) => ({ display: 'grid', gridTemplateColumns: '22px 30px 1fr', alignItems: 'start', gap: 8, background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer' }),
    cursor: (a) => ({ fontSize: 20, lineHeight: '1', color: 'var(--mag)', opacity: a ? 1 : 0, transform: 'translateY(8px)' }),
    num: (a) => ({ fontSize: 13, color: a ? 'var(--mag)' : 'var(--ink-3)', letterSpacing: '0.1em', marginTop: 10, fontWeight: 500 }),
    itemBody: { display: 'flex', flexDirection: 'column', gap: 2 },
    label: (a) => ({ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 34, lineHeight: 1.0, color: a ? 'var(--mag)' : 'var(--ink)', letterSpacing: '0.01em', transition: 'color .12s' }),
    sub: (a) => ({ fontSize: 12.5, letterSpacing: '0.12em', color: 'var(--ink-3)', marginTop: 3 }),
    foot: { marginTop: 'auto', paddingTop: 30 },
    mascotRow: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22 },
    mascotId: { fontSize: 14, letterSpacing: '0.12em', color: 'var(--ink)', fontWeight: 500 },
    mascotRev: { fontSize: 12.5, letterSpacing: '0.1em', color: 'var(--ink-3)', marginTop: 3 },
    descHead: { fontSize: 12, marginBottom: 10, marginLeft: 4 },
    descBox: { position: 'relative', padding: '18px 18px', minHeight: 96 },
    descText: { margin: 0, fontSize: 14, lineHeight: 1.65, letterSpacing: '0.05em', color: 'var(--ink)' },
  };

  const ft = {
    wrap: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 40px', borderTop: '1px solid var(--line-soft)', position: 'relative', zIndex: 2, fontSize: 14 },
    left: { display: 'flex', alignItems: 'center', gap: 14 },
    meter: { display: 'flex', gap: 4 },
    sep: { width: 1, height: 16, background: 'var(--line)', margin: '0 6px' },
    right: { display: 'flex', alignItems: 'center', gap: 18 },
  };

  const cf = {
    wrap: { position: 'relative', margin: '4px 40px 0 14px', padding: '0 0 0 0', display: 'flex', flexDirection: 'column', minHeight: 0 },
    head: { display: 'flex', alignItems: 'center', gap: 16, padding: '16px 22px 0' },
    label: { fontSize: 14, color: 'var(--ink-2)' },
    line: { flex: 1, height: 1, background: 'var(--line)' },
    tag: { fontSize: 13, color: 'var(--ink-3)' },
    body: (s) => ({ flex: 1, minHeight: 0, padding: '20px 26px 26px', ...(s ? {} : { overflow: 'hidden' }) }),
  };
})();
