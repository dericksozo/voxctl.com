// settings.jsx — API providers (bring-your-own-key) + capture config.
(function () {
  const { useState } = React;
  const I = window.Icons;

  const PROVIDERS = [
    { id: 'openai', name: 'OPENAI', model: 'GPT-REALTIME-WHISPER', price: '~$0.017/MIN', status: 'notset' },
    { id: 'xai',    name: 'XAI',    model: 'GROK STT (LIVE)',      price: '~$0.2/HR',    status: 'valid' },
    { id: 'gemini', name: 'GEMINI', model: 'GEMINI 2.5 FLASH',     price: '~$0.057/HR',  status: 'notset' },
  ];

  function ProviderCard({ p, state, onSave }) {
    const [val, setVal] = useState(state === 'valid' ? '\u2022'.repeat(18) + '  (stored)' : '');
    const valid = state === 'valid';
    return (
      <div style={{ border: '1px solid ' + (valid ? 'var(--mag)' : 'var(--line-soft)'), padding: '18px 22px', marginBottom: 16, background: valid ? 'rgba(255,10,140,.04)' : 'var(--panel)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: valid ? 'var(--mag)' : 'var(--ink-4)' }} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, color: valid ? 'var(--ink-2)' : 'var(--ink-3)' }}><I.ProviderLogo id={p.id} size={15} /></span>
          <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: '0.1em', color: 'var(--ink)' }}>{p.name}</span>
          <span style={{ fontSize: 13, letterSpacing: '0.08em', color: 'var(--ink-3)' }}>{p.model} · {p.price}</span>
          <button style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, letterSpacing: '0.12em', color: 'var(--ink-3)', display: 'inline-flex', alignItems: 'center', gap: 5 }}
            onMouseEnter={(e) => e.currentTarget.style.color = 'var(--mag)'} onMouseLeave={(e) => e.currentTarget.style.color = 'var(--ink-3)'}>
            DOCS <span style={{ fontSize: 11 }}>&#8599;</span>
          </button>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
          <input value={val} onChange={(e) => setVal(e.target.value)} placeholder="PASTE KEY…"
            style={{ flex: 1, padding: '13px 16px', fontSize: 14, letterSpacing: '0.08em', color: valid ? 'var(--ink-3)' : 'var(--ink)',
                     background: 'rgba(255,255,255,.6)', border: '1px solid var(--line)', outline: 'none' }}
            onFocus={(e) => e.target.style.borderColor = 'var(--mag)'} onBlur={(e) => e.target.style.borderColor = 'var(--line)'} />
          <button className="vx-btn" style={{ padding: '0 22px' }}>SAVE</button>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, letterSpacing: '0.1em', minWidth: 96, justifyContent: 'center',
                   color: valid ? 'var(--mag)' : 'var(--ink-3)' }}>
            {valid ? <React.Fragment><I.Check size={14} />VALIDATED</React.Fragment> : 'NOT SET'}
          </span>
        </div>
      </div>
    );
  }

  function SettingsScreen() {
    return (
      <div>
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--mag)', marginBottom: 6 }}>API PROVIDERS</div>
        <div style={{ fontSize: 13, letterSpacing: '0.1em', color: 'var(--ink-3)', marginBottom: 22 }}>BRING-YOUR-OWN-KEY · ADD ONE TO BEGIN</div>
        {PROVIDERS.map((p) => <ProviderCard key={p.id} p={p} state={p.status} />)}
        <p style={{ fontSize: 13, lineHeight: 1.7, letterSpacing: '0.06em', color: 'var(--ink-3)', maxWidth: '70ch', margin: '6px 0 32px' }}>
          EACH KEY IS VALIDATED WITH ITS PROVIDER, THEN STORED SECURELY IN THE MACOS KEYCHAIN — NEVER IN PLAINTEXT. FILL IN ONE TO START.
        </p>

        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--mag)', marginBottom: 18, paddingTop: 8, borderTop: '1px solid var(--line-soft)' }}>CAPTURE</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <CfgRow k="CAPTURE SHORTCUT" v="OPTION + SPACE" />
          <CfgRow k="OUTPUT" v="TYPE INTO ACTIVE APP" />
          <CfgRow k="INPUT DEVICE" v="MACBOOK PRO MICROPHONE" />
          <CfgRow k="SFX FEEDBACK" v="ON" mag />
        </div>
      </div>
    );
  }
  const CfgRow = ({ k, v, mag }) => (
    <div style={{ border: '1px solid var(--line-soft)', padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--panel)' }}>
      <span style={{ fontSize: 12.5, letterSpacing: '0.14em', color: 'var(--ink-3)' }}>{k}</span>
      <span style={{ fontSize: 14, letterSpacing: '0.08em', color: mag ? 'var(--mag)' : 'var(--ink)' }}>{v}</span>
    </div>
  );

  window.SettingsScreen = SettingsScreen;
})();
