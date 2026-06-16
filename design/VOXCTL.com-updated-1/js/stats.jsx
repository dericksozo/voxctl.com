// stats.jsx — dedicated usage dashboard (former Home).
(function () {
  const I = window.Icons;
  const VOX = window.VOX;

  function BigStat({ label, value, sub, mag, border }) {
    return (
      <div style={{ padding: '4px 28px', borderRight: border ? '1px solid var(--line-soft)' : 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 12.5, letterSpacing: '0.16em', color: 'var(--ink-3)', lineHeight: 1.4, minHeight: 34 }}>{label}</div>
        <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 52, lineHeight: 0.95, color: mag ? 'var(--mag)' : 'var(--ink)', letterSpacing: '0.005em' }}>{value}</div>
        <div style={{ fontSize: 12.5, letterSpacing: '0.12em', color: 'var(--ink-3)', marginTop: 4 }}>{sub}</div>
      </div>
    );
  }

  function GettingStarted() {
    const rows = [
      { t: 'CUSTOMIZE YOUR SHORTCUT', d: 'Change the global capture shortcut for VOXCTL.' },
      { t: 'DEFINE A MODE', d: 'Bind language + triggers to your favourite apps.' },
      { t: 'CONNECT YOUR API KEY', d: 'Add a provider key to begin transcribing.' },
    ];
    return (
      <div style={{ border: '1px solid var(--line-soft)', padding: '20px 24px', display: 'flex', flexDirection: 'column' }}>
        <div className="lbl" style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 6 }}>GETTING STARTED</div>
        {rows.map((r, i) => (
          <button key={i} style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 14, textAlign: 'left',
                   background: 'none', border: 'none', borderTop: i === 0 ? 'none' : '1px solid var(--line-faint)', padding: '20px 0', cursor: 'pointer' }}
            onMouseEnter={(e) => e.currentTarget.querySelector('.gs-arr').style.color = 'var(--mag)'}
            onMouseLeave={(e) => e.currentTarget.querySelector('.gs-arr').style.color = 'var(--ink-3)'}>
            <span>
              <span style={{ display: 'block', fontSize: 15, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--ink)', marginBottom: 6 }}>{r.t}</span>
              <span style={{ display: 'block', fontSize: 13, letterSpacing: '0.04em', color: 'var(--ink-3)', lineHeight: 1.5 }}>{r.d}</span>
            </span>
            <span className="gs-arr" style={{ color: 'var(--ink-3)', transition: '.12s' }}><I.ArrowR size={20} /></span>
          </button>
        ))}
      </div>
    );
  }

  function TopInterfaces() {
    const items = VOX.STATS.topInterfaces;
    return (
      <div style={{ border: '1px solid var(--line-soft)', padding: '20px 24px' }}>
        <div className="lbl" style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 18 }}>TOP INTERFACES</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {items.map((it, i) => (
            <div key={i}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                <span style={{ fontSize: 14, letterSpacing: '0.08em', color: 'var(--ink)' }}>{it.name}</span>
                <span style={{ fontSize: 12.5, letterSpacing: '0.1em', color: 'var(--ink-3)' }}>{it.pct}%</span>
              </div>
              <div style={{ height: 6, background: 'var(--line-faint)', position: 'relative' }}>
                <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: it.pct + '%', background: i === 0 ? 'var(--mag)' : 'var(--ink)' }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function StatsScreen() {
    const s = VOX.STATS;
    return (
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', border: '1px solid var(--line-soft)', background: 'rgba(255,255,255,.4)', padding: '24px 0', marginBottom: 22 }}>
          <BigStat label="WORDS // ALL TIME" value={s.words.toLocaleString()} sub={s.recordings + ' RECORDINGS'} border />
          <BigStat label="MINUTES CAPTURED" value={s.minutes} sub={'\u2248 ' + s.hours + ' HRS'} border />
          <BigStat label="INTERFACES ENGAGED" value={String(s.interfaces).padStart(2, '0')} sub="DISTINCT APPS" border />
          <BigStat label="EST. SPEND // ALL TIME" value={s.spend} sub="LOCAL ESTIMATE" mag />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 22 }}>
          <GettingStarted />
          <TopInterfaces />
        </div>
      </div>
    );
  }

  window.StatsScreen = StatsScreen;
})();
