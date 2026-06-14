// onboarding.jsx — single gated setup screen + re-entry guard scenarios.
(function () {
  const { useState, useEffect } = React;
  const I = window.Icons;
  const Corners = window.Chrome.Corners;

  // scenario -> initial statuses. status: waiting | progress | done | error
  const SCENARIOS = {
    first:        { mic: 'waiting', acc: 'waiting', key: 'waiting', rec: 'waiting', note: 'FIRST LAUNCH' },
    'reentry-mic':{ mic: 'error',   acc: 'done',    key: 'done',    rec: 'done',    note: 'RE-ENTRY · MIC REVOKED' },
    'reentry-acc':{ mic: 'done',    acc: 'error',   key: 'done',    rec: 'done',    note: 'RE-ENTRY · ACCESSIBILITY REVOKED' },
    'reentry-key':{ mic: 'done',    acc: 'done',    key: 'error',   rec: 'done',    note: 'RE-ENTRY · ALL KEYS REMOVED' },
  };

  const STEP_DEFS = [
    { id: 'mic', n: '1', icon: I.Mic,      title: 'MICROPHONE ACCESS',     desc: 'Required to hear your voice for transcription.' },
    { id: 'acc', n: '2', icon: I.Keyboard, title: 'ACCESSIBILITY ACCESS',  desc: 'Required to type transcribed text into your apps.' },
    { id: 'key', n: '3', icon: I.Key,      title: 'API KEY',               desc: 'Add at least one provider key. VOXCTL is bring-your-own-key.' },
    { id: 'rec', n: '4', icon: I.Mic,      title: 'FIRST RECORDING',       desc: 'Hold the capture shortcut and speak a short snippet.' },
  ];

  const STATUS_META = {
    waiting:  { label: 'WAITING',     color: 'var(--ink-3)' },
    progress: { label: 'IN PROGRESS', color: 'var(--warn)' },
    done:     { label: 'GRANTED',     color: 'var(--ok)' },
    error:    { label: 'NEEDS ATTENTION', color: 'var(--err)' },
  };
  const DONE_LABEL = { mic: 'GRANTED', acc: 'GRANTED', key: 'ADDED', rec: 'DONE' };

  function StatusPill({ status, id }) {
    const m = STATUS_META[status];
    const label = status === 'done' ? (DONE_LABEL[id] || 'DONE') : m.label;
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, letterSpacing: '0.12em', color: m.color }}>
        {status === 'done' && <I.Check size={14} />}
        {status === 'progress' && <span style={{ display: 'inline-flex' }}><Spinner /></span>}
        {status === 'error' && <I.Alert size={13} />}
        {status === 'waiting' && <span style={{ width: 7, height: 7, borderRadius: '50%', border: '1.5px solid var(--ink-3)' }} />}
        {label}
      </span>
    );
  }
  function Spinner() {
    return <span style={{ display: 'inline-block', width: 13, height: 13, border: '1.5px solid var(--warn)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'vxspin .7s linear infinite' }} />;
  }

  function StepRow({ def, status, onAct, expanded, children }) {
    const active = status === 'waiting' || status === 'error';
    const Icon = def.icon;
    return (
      <div style={{ border: '1px solid ' + (status === 'error' ? 'var(--err)' : status === 'done' ? 'var(--line-soft)' : 'var(--line)'),
                    background: status === 'error' ? 'rgba(255,45,45,.04)' : status === 'done' ? 'rgba(0,179,104,.035)' : 'var(--panel)',
                    padding: '20px 22px', transition: '.15s', opacity: status === 'done' ? 0.92 : 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <span style={{ fontSize: 12, letterSpacing: '0.1em', color: active ? 'var(--mag)' : 'var(--ink-3)', width: 44 }}>STEP {def.n}</span>
          <span style={{ width: 40, height: 40, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                   border: '1px solid ' + (active ? 'var(--mag-line)' : 'var(--line)'), color: active ? 'var(--mag)' : 'var(--ink-2)',
                   background: active ? 'var(--mag-soft)' : 'transparent', flexShrink: 0 }}>
            <Icon size={19} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15.5, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--ink)', marginBottom: 4 }}>{def.title}</div>
            <div style={{ fontSize: 13, letterSpacing: '0.04em', color: 'var(--ink-3)', lineHeight: 1.5 }}>{def.desc}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
            <StatusPill status={status} id={def.id} />
            {active && (
              <button className="vx-btn vx-btn--mag" onClick={onAct}>
                {def.id === 'mic' && (status === 'error' ? 'RE-GRANT' : 'GRANT')}
                {def.id === 'acc' && (status === 'error' ? 'RE-GRANT' : 'GRANT')}
                {def.id === 'key' && (status === 'error' ? 'ADD KEY' : 'ADD KEY')}
                {def.id === 'rec' && 'RECORD'}
              </button>
            )}
          </div>
        </div>
        {expanded && <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--line-soft)' }}>{children}</div>}
      </div>
    );
  }

  function OnboardingScreen({ scenario = 'first', onComplete }) {
    const init = SCENARIOS[scenario] || SCENARIOS.first;
    const [st, setSt] = useState({ mic: init.mic, acc: init.acc, key: init.key, rec: init.rec });
    const [keyOpen, setKeyOpen] = useState(false);
    const [chosenProvider, setChosenProvider] = useState(null);
    const [recOpen, setRecOpen] = useState(false);

    useEffect(() => { const i = SCENARIOS[scenario] || SCENARIOS.first; setSt({ mic: i.mic, acc: i.acc, key: i.key, rec: i.rec }); setKeyOpen(false); setRecOpen(false); setChosenProvider(null); }, [scenario]);

    function grant(id) {
      setSt((s) => ({ ...s, [id]: 'progress' }));
      setTimeout(() => setSt((s) => ({ ...s, [id]: 'done' })), 850);
    }
    function act(id) {
      if (id === 'key') { setKeyOpen((o) => !o); return; }
      if (id === 'rec') { setRecOpen(true); setSt((s) => ({ ...s, rec: 'progress' })); setTimeout(() => { setSt((s) => ({ ...s, rec: 'done' })); }, 1800); return; }
      grant(id);
    }
    function pickProvider(p) {
      setChosenProvider(p); setSt((s) => ({ ...s, key: 'progress' }));
      setTimeout(() => { setSt((s) => ({ ...s, key: 'done' })); setKeyOpen(false); }, 900);
    }

    const doneCount = Object.values(st).filter((x) => x === 'done').length;
    const allDone = doneCount === 4;

    return (
      <div style={ob.outer}>
        <style>{`@keyframes vxspin{to{transform:rotate(360deg);}}`}</style>
        <div style={ob.panel}>
          <Corners color="var(--ink)" size={22} weight={2} />

          {/* header */}
          <div style={{ textAlign: 'center', marginBottom: 34 }}>
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 14, marginBottom: 18, color: 'var(--ink)' }}>
              <I.Mascot size={40} />
              <span style={{ fontFamily: 'var(--display)', fontWeight: 800, fontSize: 38, color: 'var(--mag)', letterSpacing: '0.02em' }}>VOXCTL</span>
            </div>
            <div style={{ display: 'inline-block', fontSize: 11.5, letterSpacing: '0.2em', color: 'var(--ink-3)', border: '1px solid var(--line)', padding: '4px 12px', marginBottom: 20, whiteSpace: 'nowrap' }}>{init.note}</div>
            <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 26, color: 'var(--ink)', letterSpacing: '0.04em', marginBottom: 12 }}>SETUP REQUIRED</div>
            <p style={{ fontSize: 15, letterSpacing: '0.04em', color: 'var(--ink-2)', margin: 0 }}>VOXCTL needs a few things set up to work properly.</p>
          </div>

          {/* steps */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {STEP_DEFS.map((def) => (
              <StepRow key={def.id} def={def} status={st[def.id]} onAct={() => act(def.id)}
                expanded={(def.id === 'key' && keyOpen) || (def.id === 'key' && st.key === 'done' && chosenProvider) || (def.id === 'rec' && (recOpen || st.rec === 'done') && scenario === 'first')}>
                {def.id === 'key' && st.key !== 'done' && (
                  <div>
                    <div style={{ fontSize: 12, letterSpacing: '0.14em', color: 'var(--ink-3)', marginBottom: 12 }}>CHOOSE A PROVIDER TO ADD A KEY</div>
                    <div style={{ display: 'flex', gap: 12 }}>
                      {[['xai','XAI'],['openai','OPENAI'],['gemini','GEMINI']].map(([id, name]) => (
                        <button key={id} className="vx-btn" style={{ flex: 1, justifyContent: 'center', padding: '14px' }} onClick={() => pickProvider(id)}>
                          <I.ProviderLogo id={id} size={15} />{name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {def.id === 'key' && st.key === 'done' && chosenProvider && (
                  <div style={{ fontSize: 13.5, letterSpacing: '0.06em', color: 'var(--ink-2)' }}>
                    <span style={{ color: 'var(--mag)' }}>{chosenProvider.toUpperCase()}</span> key validated — auto-selected default model{' '}
                    <span style={{ color: 'var(--ink)' }}>{chosenProvider === 'xai' ? 'GROK STT (LIVE)' : chosenProvider === 'openai' ? 'GPT-REALTIME-WHISPER' : 'GEMINI 2.5 FLASH'}</span>.
                  </div>
                )}
                {def.id === 'rec' && st.rec === 'progress' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 14, letterSpacing: '0.06em', color: 'var(--ink-2)' }}>
                    <span style={{ display: 'inline-flex', gap: 3 }}>{Array.from({length:9}).map((_,i)=><span key={i} style={{width:3,height:14+((i*7)%12),background:'var(--mag)',animation:`vxbar .8s ${i*0.08}s infinite ease-in-out`}}/>)}</span>
                    <style>{`@keyframes vxbar{0%,100%{transform:scaleY(.4);}50%{transform:scaleY(1);}}`}</style>
                    RECORDING… HOLD <Kbd>OPTION</Kbd>+<Kbd>SPACE</Kbd>, RELEASE TO STOP
                  </div>
                )}
                {def.id === 'rec' && st.rec === 'done' && scenario === 'first' && (
                  <div style={{ fontSize: 14.5, letterSpacing: '0.06em', color: 'var(--mag)' }}>&#10003; You set up VOXCTL in 30 seconds.</div>
                )}
              </StepRow>
            ))}
          </div>

          {/* footer */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 30, paddingTop: 22, borderTop: '1px solid var(--line-soft)' }}>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 14 }}>
              <span style={{ fontSize: 13, letterSpacing: '0.14em', color: 'var(--ink-2)' }}>{doneCount} / 4 COMPLETE</span>
              <span style={{ flex: 1, maxWidth: 200, height: 5, background: 'var(--line-faint)', position: 'relative' }}>
                <span style={{ position: 'absolute', inset: '0 auto 0 0', width: (doneCount/4*100)+'%', background: 'var(--mag)', transition: 'width .3s' }} />
              </span>
            </div>
            <button className="vx-btn vx-btn--mag" disabled={!allDone} onClick={onComplete}
              style={{ padding: '12px 26px', fontSize: 14, ...(allDone ? { background: 'var(--mag)', color: '#fff', borderColor: 'var(--mag)' } : {}) }}>
              {allDone ? <React.Fragment>ENTER VOXCTL <I.ArrowR size={15} /></React.Fragment> : 'COMPLETE ALL STEPS'}
            </button>
          </div>
        </div>
      </div>
    );
  }
  const Kbd = ({ children }) => (
    <span style={{ fontSize: 11.5, letterSpacing: '0.1em', color: 'var(--ink)', border: '1px solid var(--ink-3)', borderBottomWidth: 2, padding: '2px 7px', background: '#fff', margin: '0 2px' }}>{children}</span>
  );

  const ob = {
    outer: { minHeight: '100%', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '20px 20px 40px' },
    panel: { position: 'relative', width: '100%', maxWidth: 760, padding: '44px 46px' },
  };

  window.OnboardingScreen = OnboardingScreen;
})();
