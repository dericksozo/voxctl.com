// modes.jsx — context-aware presets list.
(function () {
  const { useState } = React;
  const I = window.Icons;
  const VOX = window.VOX;

  function Toggle({ on, onClick }) {
    return (
      <button onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 12, background: 'none', border: 'none', cursor: 'pointer' }}>
        <span style={{ width: 46, height: 24, border: '1px solid ' + (on ? 'var(--mag)' : 'var(--line)'), background: on ? 'var(--mag-soft)' : 'rgba(255,255,255,.5)', position: 'relative', transition: '.12s' }}>
          <span style={{ position: 'absolute', top: 2, bottom: 2, width: 18, left: on ? 24 : 2, background: on ? 'var(--mag)' : 'var(--ink-3)', transition: 'left .12s, background .12s' }} />
        </span>
        <span style={{ fontSize: 12.5, letterSpacing: '0.14em', color: on ? 'var(--mag)' : 'var(--ink-3)' }}>{on ? 'ENABLED' : 'OFF'}</span>
      </button>
    );
  }

  function ModeCard({ m, on, onToggle }) {
    return (
      <div style={{ border: '1px solid var(--line-soft)', background: 'var(--panel)', padding: '22px 26px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 26, color: 'var(--ink)', letterSpacing: '0.02em' }}>{m.name}</div>
          {m.key !== '—' && <span style={{ fontSize: 11.5, letterSpacing: '0.12em', color: 'var(--ink-3)', border: '1px solid var(--line)', padding: '3px 7px' }}>{m.key}</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16 }}>
            <button className="vx-btn">EDIT</button>
            <Toggle on={on} onClick={onToggle} />
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 30px', marginTop: 16, fontSize: 13.5, letterSpacing: '0.06em' }}>
          <Field k="MODEL">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--ink)' }}>
              <span style={{ color: 'var(--ink-2)' }}><I.ProviderLogo id={m.provider} size={13} /></span>
              {m.provider.toUpperCase()} · {m.model}
              {m.live && <span style={{ fontSize: 11, letterSpacing: '0.12em', color: 'var(--mag)', border: '1px solid var(--mag-line)', padding: '1px 5px' }}>LIVE</span>}
            </span>
          </Field>
          <Field k="TRIGGER"><span style={{ color: m.trigger === '—' ? 'var(--ink-3)' : 'var(--ink)' }}>{m.trigger}</span></Field>
          <Field k="LANG"><span style={{ color: 'var(--ink)' }}>{m.lang}</span></Field>
        </div>
      </div>
    );
  }
  const Field = ({ k, children }) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
      <span style={{ color: 'var(--ink-3)' }}>{k}</span>{children}
    </span>
  );

  function ModesScreen() {
    const [states, setStates] = useState(() => Object.fromEntries(VOX.MODES.map((m) => [m.id, m.enabled])));
    return (
      <div>
        <button style={{ width: '100%', border: '1.5px dashed var(--mag-line)', background: 'var(--mag-soft)', color: 'var(--mag)',
                 padding: '18px', fontSize: 15, letterSpacing: '0.16em', textTransform: 'uppercase', cursor: 'pointer', marginBottom: 20,
                 display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 12, transition: '.12s' }}
          onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,10,140,.16)'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'var(--mag-soft)'}>
          <I.Plus size={16} />DEFINE NEW MODE
        </button>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {VOX.MODES.map((m) => (
            <ModeCard key={m.id} m={m} on={states[m.id]} onToggle={() => setStates((s) => ({ ...s, [m.id]: !s[m.id] }))} />
          ))}
        </div>
      </div>
    );
  }

  window.ModesScreen = ModesScreen;
})();
