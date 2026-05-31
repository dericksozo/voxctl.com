/* voxctl-app.jsx — VOXCTL shell: header, menu, SYS.DESC, switchable content, footer. */
const { useState, useEffect, useRef, useCallback } = React;
const { Frame, Qr, Blocks, HomePanel, FilesPanel, ModesPanel, SettingsPanel } = window;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "pink": "#E5007A",
  "scanlines": true,
  "grid": true,
  "headerFont": "Orbitron"
}/*EDITMODE-END*/;

const FILES0 = [
  { id: 1, day: "TODAY", time: "14:22", mode: "CLAUDE", dur: "1:48", secs: 108, words: 312,
    text: "Refactor the auth middleware to use the new token rotation scheme and add retry logic with exponential backoff. Make the refresh endpoint idempotent and log every rotation for the audit trail." },
  { id: 2, day: "TODAY", time: "11:09", mode: "SLACK", dur: "0:54", secs: 54, words: 141,
    text: "Pushing the release to Thursday — QA found an edge case in the payment flow we need to patch first. I'll update the ticket and let the support team know about the new timeline." },
  { id: 3, day: "TODAY", time: "09:41", mode: "PREPLY", dur: "2:12", secs: 132, words: 268,
    text: "Me gustaría practicar el pretérito perfecto y revisar algunos verbos irregulares hoy. ¿Podemos empezar con una conversación corta sobre mi fin de semana y luego corregir los errores?" },
  { id: 4, day: "YESTERDAY", time: "18:30", mode: "CODE", dur: "0:32", secs: 32, words: 84,
    text: "Write a function that debounces the search input by 250 milliseconds and cancels prior requests with an abort controller so we don't get race conditions on fast typing." },
  { id: 5, day: "YESTERDAY", time: "16:05", mode: "CHATGPT", dur: "1:12", secs: 72, words: 190,
    text: "Draft a short product update email announcing the new voice modes. Keep the tone friendly and concise, and end with a clear call to action to try it out today." },
  { id: 6, day: "WED 28 MAY 2026", time: "10:12", mode: "GEMINI", dur: "0:47", secs: 47, words: 120,
    text: "Summarize the key findings from the user research sessions and list the top three usability issues we should fix before the beta launch." },
];

const MODES0 = [
  { id: "claude", n: "CLAUDE", trig: "claude.ai", lang: "EN", model: "gpt-realtime-whisper", on: true, active: true },
  { id: "gpt", n: "CHATGPT", trig: "chatgpt.com", lang: "EN", model: "gpt-realtime-whisper", on: true, active: false },
  { id: "gemini", n: "GEMINI", trig: "gemini.google.com", lang: "AUTO", model: "whisper-large-v3", on: true, active: false },
  { id: "code", n: "CODE", trig: "VS CODE · TERMINAL", lang: "EN", model: "whisper-large-v3", on: true, active: false },
  { id: "lang", n: "LANGUAGE LEARNING", trig: "preply.com", lang: "ES", model: "whisper-large-v3", on: false, active: false },
];

function pad(n) { return String(n).padStart(2, "0"); }

/* typewriter hook */
function useTypewriter(text, run, speed) {
  const [out, setOut] = useState(run ? "" : text);
  useEffect(() => {
    if (!run) { setOut(text); return; }
    setOut(""); let i = 0;
    const iv = setInterval(() => {
      i++; setOut(text.slice(0, i));
      if (i >= text.length) clearInterval(iv);
    }, speed || 12);
    return () => clearInterval(iv);
  }, [text, run]);
  return out;
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [selected, setSelected] = useState(0);
  const [phase, setPhase] = useState("idle"); // idle | closing | opening
  const [clock, setClock] = useState("");
  const [db, setDb] = useState(0.12);
  const [caretOn, setCaretOn] = useState(true);
  const [files, setFiles] = useState(FILES0);
  const [modes, setModes] = useState(MODES0);
  const timers = useRef([]);

  const totalMin = Math.round(files.reduce((s, f) => s + f.secs, 0) / 60);
  const activeMode = (modes.find((m) => m.active) || modes[0] || {}).n || "—";

  const MENU = [
    { id: "home", label: "HOME", panel: "home",
      meta: "USAGE OVERVIEW",
      desc: "VOCAL CONTROL DASHBOARD. CYCLE OUTPUT, RECLAIMED TIME AND ACTIVE INTERFACES AT A GLANCE." },
    { id: "files", label: "FILES", panel: "files",
      meta: files.length + " RECORDINGS · " + totalMin + " MIN",
      desc: "TRANSMISSION LOG. PLAY BACK AUDIO, COPY TRANSCRIPTS, INSPECT CONFIDENCE, PURGE ARCHIVES." },
    { id: "modes", label: "MODES", panel: "modes",
      meta: modes.length + " MODES · ▸ " + activeMode,
      desc: "CONTEXT PRESETS. BIND LANGUAGE, MODEL AND FORMATTING RULES TO APPS AND WEBSITES." },
    { id: "settings", label: "SETTINGS", panel: "settings",
      meta: "API · SHORTCUT · SFX · LOCALE",
      desc: "SYSTEM CONFIG. API KEY, CAPTURE BEHAVIOR, SHORTCUTS, LOCALE AND AUDIO FEEDBACK." },
  ];
  const item = MENU[selected];
  const descTyped = useTypewriter(item.desc, phase !== "closing", 11);
  const labelTyped = useTypewriter("// " + item.label, phase !== "closing", 24);

  useEffect(() => {
    document.documentElement.style.setProperty("--pink", t.pink);
  }, [t.pink]);

  useEffect(() => {
    const iv = setInterval(() => {
      const d = new Date();
      setClock(pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()));
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  /* single blink source so SYS.DESC + active-tab carets stay in lockstep */
  useEffect(() => {
    const iv = setInterval(() => setCaretOn((c) => !c), 500);
    return () => clearInterval(iv);
  }, []);

  /* simulated input level — calm smoothed walk */
  useEffect(() => {
    let level = 0.2;
    const iv = setInterval(() => {
      const target = 0.1 + Math.random() * Math.random() * 0.8;
      level += (target - level) * 0.35;
      setDb(level);
    }, 150);
    return () => clearInterval(iv);
  }, []);

  /* fast window close → swap → open */
  const switchTo = useCallback((i) => {
    if (i === selected || phase !== "idle") return;
    timers.current.forEach(clearTimeout);
    setPhase("closing");
    timers.current = [
      setTimeout(() => { setSelected(i); setPhase("opening"); }, 150),
      setTimeout(() => setPhase("idle"), 150 + 210),
    ];
  }, [selected, phase]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "ArrowDown" || e.key === "j") { switchTo((selected + 1) % MENU.length); e.preventDefault(); }
      else if (e.key === "ArrowUp" || e.key === "k") { switchTo((selected - 1 + MENU.length) % MENU.length); e.preventDefault(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [switchTo, selected, MENU.length]);

  /* files + modes handlers */
  const onCopy = useCallback((id) => setFiles((xs) => xs.map((x) => x.id === id ? { ...x, copies: x.copies + 1 } : x)), []);
  const onDelete = useCallback((id) => setFiles((xs) => xs.filter((x) => x.id !== id)), []);
  const onToggleMode = useCallback((id) => setModes((ms) => ms.map((m) => m.id === id ? { ...m, on: !m.on } : m)), []);
  const onAddMode = useCallback((f) => setModes((ms) => ms.concat([{
    id: "m" + Date.now(), n: (f.n || "UNTITLED"), trig: (f.trig || "—"), lang: f.lang, model: f.model, on: true, active: false,
  }])), []);

  function renderPanel() {
    switch (item.panel) {
      case "home": return <HomePanel go={switchTo} />;
      case "files": return <FilesPanel files={files} onDelete={onDelete} />;
      case "modes": return <ModesPanel modes={modes} onToggle={onToggleMode} onAdd={onAddMode} />;
      case "settings": return <SettingsPanel />;
      default: return null;
    }
  }

  const dbVal = Math.max(0, Math.round(db * 60));
  const frameCls = "content-frame " + (phase === "closing" ? "closing" : phase === "opening" ? "opening" : "");

  return (
    <div className={"app" + (t.scanlines ? " scan" : "") + (t.grid ? " gridbg" : "")}>

      {/* ===== header ===== */}
      <header className="head">
        <div className="head-brand">
          <div className="head-crumb">VOCAL CONTROL PROTOCOL</div>
          <h1 className="head-title" style={{ fontFamily: t.headerFont + ", sans-serif" }}>VOXCTL</h1>
        </div>
        <div className="trace">
          <span className="trace-line" />
          <span className="trace-step" />
          <span className="trace-line short" />
          <span className="trace-dot" />
        </div>
        <div className="head-right">
          <div className="mode-pill">ACTIVE MODE <b>▸ {activeMode}</b></div>
          <div className="head-stat">LINK <span className="ok">✓ OK</span> · KEY <span className="ok">✓ SET</span></div>
        </div>
      </header>

      {/* ===== main ===== */}
      <main className="main">
        <div className="side">
          <nav className="nav">
            <div className="nav-label">// SELECT FUNCTION</div>
            <ul className="nav-list">
              {MENU.map((m, i) => (
                <li key={m.id}
                  className={"nav-item" + (i === selected ? " active" : "")}
                  onClick={() => switchTo(i)}>
                  <span className="cursor">↵</span>
                  <span className="nav-n">{pad(i + 1)}</span>
                  <span className="nav-main">
                    <span className="nav-title-row">
                      <span className="nav-text" style={{ fontFamily: t.headerFont + ", sans-serif" }}>{m.label}</span>
                      {i === selected ? <span className="nav-caret" style={{ opacity: caretOn ? 1 : 0 }} /> : null}
                    </span>
                    <span className="nav-meta">{m.meta}</span>
                  </span>
                </li>
              ))}
            </ul>
          </nav>

          <div className="side-qr">
            <Qr seed={1471} n={7} />
            <div className="side-qr-txt">
              <span>VX-MENU-0xA7</span>
              <span className="dim">REV 2.4 · BUILD 2197</span>
            </div>
          </div>

          <Frame className="sysdesc" label="// SYS.DESC">
            <p className="sysdesc-text">{descTyped}<span className="caret" style={{ opacity: caretOn ? 1 : 0 }}>█</span></p>
          </Frame>
        </div>

        <div className="stage">
          <Frame className={frameCls} label={labelTyped} tr="VX-0xA7">
            <div className="content">{renderPanel()}</div>
          </Frame>
        </div>
      </main>

      {/* ===== footer greebles ===== */}
      <footer className="foot">
        <div className="gr">
          <span className="gr-k">INPUT</span>
          <Blocks value={db} count={12} accent />
          <span className="gr-v num">{pad(dbVal)} dB</span>
        </div>
        <div className="gr">
          <span className="gr-k">STORAGE</span>
          <Blocks value={0.62} count={8} />
          <span className="gr-v">12.4 GB FREE</span>
        </div>
        <div className="gr">
          <span className="gr-k">SFX</span>
          <span className="gr-v on-pink">ON</span>
        </div>
        <div className="gr gr-clock">
          <span className="gr-k">UTC</span>
          <span className="gr-v num">{clock}</span>
          <Qr seed={733} n={5} />
        </div>
      </footer>

      <TweaksPanel>
        <TweakSection label="Palette" />
        <TweakColor label="Primary" value={t.pink}
          options={["#E5007A", "#FF1744", "#D500F9", "#FF6D00"]}
          onChange={(v) => setTweak("pink", v)} />
        <TweakSection label="Display" />
        <TweakToggle label="Scanlines" value={t.scanlines} onChange={(v) => setTweak("scanlines", v)} />
        <TweakToggle label="Grid field" value={t.grid} onChange={(v) => setTweak("grid", v)} />
        <TweakRadio label="Header type" value={t.headerFont}
          options={["Orbitron", "Share Tech Mono"]}
          onChange={(v) => setTweak("headerFont", v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
