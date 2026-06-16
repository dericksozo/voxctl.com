// app.jsx — root: nav state, screen routing, tweaks.
(function () {
  const { useState } = React;
  const { WindowBar, HeaderBar, Sidebar, Footer, ContentFrame } = window.Chrome;

  const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
    "density": "comfortable",
    "homeState": "Default",
    "onboarding": "Off",
    "scanlines": true
  }/*EDITMODE-END*/;

  const HOME_STATE_MAP = { 'Default': 'default', 'Loading': 'loading', 'Empty': 'empty', 'Error': 'error' };
  const OB_MAP = {
    'Off': 'off', 'First run': 'first', 'Re-entry · mic': 'reentry-mic',
    'Re-entry · accessibility': 'reentry-acc', 'Re-entry · keys': 'reentry-key',
  };

  const FRAME_LABEL = { home: 'HOME', modes: 'MODES', stats: 'STATS', settings: 'SETTINGS / API PROVIDERS' };

  function App() {
    const [t, setTweak] = window.useTweaks(TWEAK_DEFAULTS);
    const [screen, setScreen] = useState('home');
    const stageRef = React.useRef(null);

    React.useEffect(() => {
      function fit() {
        const el = stageRef.current; if (!el) return;
        const s = Math.min(window.innerWidth / 1440, window.innerHeight / 912, 1);
        el.style.transform = 'scale(' + s + ')';
      }
      fit();
      window.addEventListener('resize', fit);
      return () => window.removeEventListener('resize', fit);
    }, []);

    const obScenario = OB_MAP[t.onboarding] || 'off';
    const homeState = HOME_STATE_MAP[t.homeState] || 'default';
    const scanOpacity = t.scanlines ? 1 : 0;

    function renderScreen() {
      if (screen === 'home') return <window.HomeScreen density={t.density} homeState={homeState} onStateChange={(v) => setTweak('homeState', v === 'default' ? 'Default' : v)} />;
      if (screen === 'modes') return <window.ModesScreen />;
      if (screen === 'stats') return <window.StatsScreen />;
      if (screen === 'settings') return <window.SettingsScreen />;
      return null;
    }

    return (
      <React.Fragment>
        <div className="stage" ref={stageRef}>
          <div className="win">
            <WindowBar />
            <div className="app" style={{ '--scan-opacity': scanOpacity }}>
              {obScenario !== 'off' ? (
                <div className="vscroll" style={{ gridRow: '1 / -1', overflowY: 'auto', position: 'relative', zIndex: 2 }}>
                  <window.OnboardingScreen scenario={obScenario} onComplete={() => { setTweak('onboarding', 'Off'); setScreen('home'); }} />
                </div>
              ) : (
                <React.Fragment>
                  <HeaderBar />
                  <div className="app__main">
                    <Sidebar screen={screen} onNav={setScreen} />
                    <ContentFrame label={FRAME_LABEL[screen]}>
                      {renderScreen()}
                    </ContentFrame>
                  </div>
                  <Footer />
                </React.Fragment>
              )}
            </div>
          </div>
        </div>

        <window.TweaksPanel title="Tweaks">
          <window.TweakSection label="Home" />
          <window.TweakRadio label="Card density" value={t.density}
            options={['comfortable', 'compact']} onChange={(v) => setTweak('density', v)} />
          <window.TweakSelect label="Home state" value={t.homeState}
            options={['Default', 'Loading', 'Empty', 'Error']} onChange={(v) => setTweak('homeState', v)} />

          <window.TweakSection label="Onboarding" />
          <window.TweakSelect label="Setup screen" value={t.onboarding}
            options={['Off', 'First run', 'Re-entry · mic', 'Re-entry · accessibility', 'Re-entry · keys']}
            onChange={(v) => setTweak('onboarding', v)} />

          <window.TweakSection label="Texture" />
          <window.TweakToggle label="Scanline grain" value={t.scanlines} onChange={(v) => setTweak('scanlines', v)} />
        </window.TweaksPanel>
      </React.Fragment>
    );
  }

  ReactDOM.createRoot(document.getElementById('root')).render(<App />);
})();
