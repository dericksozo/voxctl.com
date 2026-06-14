/* voxctl-panels.jsx — shared primitives + the four content panels.
   Data for FILES and MODES is lifted to the app; panels receive props.
   Exports to window so voxctl-app.jsx (separate Babel scope) can use it. */
const { useState, useRef } = React;

/* ---------- shared primitives ---------- */

/* primary framed window — corner brackets. Use ONLY for top-level windows. */
function Frame({ children, className, style, label, tr }) {
  return (
    <div className={"frame " + (className || "")} style={style}>
      <span className="ck tl" /><span className="ck tr" />
      <span className="ck bl" /><span className="ck br" />
      {label ? <span className="frame-tag">{label}</span> : null}
      {tr ? <span className="frame-tag frame-tag-r">{tr}</span> : null}
      {children}
    </div>
  );
}

/* plain inner card — no corner brackets. */
function Card({ children, className, label, style }) {
  return (
    <div className={"card " + (className || "")} style={style}>
      {label ? <div className="card-tag">{label}</div> : null}
      {children}
    </div>
  );
}

function Blocks({ value, count, accent }) {
  const filled = Math.max(0, Math.min(count, Math.round(value * count)));
  const cells = [];
  for (let i = 0; i < count; i++) {
    cells.push(<span key={i} className={"blk" + (i < filled ? " on" : "") + (accent ? " accent" : "")} />);
  }
  return <span className="blocks">{cells}</span>;
}

function Toggle({ on, onToggle, labels }) {
  const [a, b] = labels || ["ON", "OFF"];
  return (
    <button type="button" className={"toggle" + (on ? " on" : "")} onClick={onToggle}>
      <span className="toggle-track"><span className="toggle-knob" /></span>
      <span className="toggle-label">{on ? a : b}</span>
    </button>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button type="button" key={o}
          className={"seg-opt" + (o === value ? " on" : "")}
          onClick={() => onChange(o)}>{o}</button>
      ))}
    </div>
  );
}

/* deterministic stylized QR glyph */
function Qr({ seed, n }) {
  n = n || 7;
  let s = seed || 7;
  const cells = [];
  for (let i = 0; i < n * n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const r = Math.floor(i / n), c = i % n;
    // finder squares in three corners
    const finder = (r < 3 && c < 3) || (r < 3 && c >= n - 3) || (r >= n - 3 && c < 3);
    const edge = (r === 0 || c === 0 || r === 2 || c === 2 ||
                  r === n - 1 || c === n - 1 || r === n - 3 || c === n - 3);
    const on = finder ? edge : (s % 5) > 1;
    cells.push(<i key={i} className={on ? "on" : ""} />);
  }
  return <span className="qr" style={{ gridTemplateColumns: "repeat(" + n + ", 1fr)" }}>{cells}</span>;
}

/* ---------- HOME ---------- */
function HomePanel({ go }) {
  const stats = [
    { k: "WORDS // THIS CYCLE", v: "12,480", d: "+18% VS LAST" },
    { k: "MINUTES RECLAIMED", v: "47", d: "≈ 0.8 HRS SAVED" },
    { k: "INTERFACES ENGAGED", v: "08", d: "ACROSS 3 DEVICES" },
  ];
  const start = [
    { t: "CUSTOMIZE YOUR SHORTCUTS", d: "CHANGE THE GLOBAL KEYBOARD SHORTCUTS FOR VOXCTL.", to: 3 },
    { t: "DEFINE A MODE", d: "BIND LANGUAGE + MODEL RULES TO YOUR FAVOURITE APPS.", to: 2 },
    { t: "CONNECT YOUR API KEY", d: "ADD YOUR OPENAI KEY TO BEGIN TRANSCRIBING.", to: 3 },
  ];
  const apps = [
    { n: "CLAUDE.AI", p: 0.42 },
    { n: "VS CODE", p: 0.27 },
    { n: "CHATGPT", p: 0.19 },
    { n: "SLACK", p: 0.12 },
  ];
  return (
    <div className="panel-body home">
      <div className="stat-row">
        {stats.map((s) => (
          <div className="stat" key={s.k}>
            <div className="stat-k">{s.k}</div>
            <div className="stat-v">{s.v}</div>
            <div className="stat-d">{s.d}</div>
          </div>
        ))}
      </div>
      <div className="home-grid">
        <Card className="home-start" label="GETTING STARTED">
          <ul className="start-list">
            {start.map((g, i) => (
              <li key={i} className="start-item" onClick={() => go(g.to)}>
                <span className="start-main">
                  <span className="start-t">{g.t}</span>
                  <span className="start-d">{g.d}</span>
                </span>
                <span className="start-arr">→</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="home-apps" label="TOP INTERFACES">
          <ul className="app-list">
            {apps.map((a) => (
              <li key={a.n}>
                <span className="app-n">{a.n}</span>
                <span className="app-bar"><i style={{ width: (a.p * 100) + "%" }} /></span>
                <span className="app-p">{Math.round(a.p * 100)}%</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

/* ---------- FILES ---------- */
function FilesPanel({ files, onDelete }) {
  const [expanded, setExpanded] = useState(null);
  const [copied, setCopied] = useState(null);
  const tref = useRef(null);
  function doCopy(e, f) {
    e.stopPropagation();
    try { navigator.clipboard.writeText(f.text); } catch (_) {}
    setCopied(f.id);
    clearTimeout(tref.current);
    tref.current = setTimeout(() => setCopied(null), 1100);
  }
  function stop(e) { e.stopPropagation(); }

  const groups = [];
  files.forEach((f) => {
    const g = groups.find((x) => x.day === f.day);
    if (g) g.items.push(f); else groups.push({ day: f.day, items: [f] });
  });

  return (
    <div className="panel-body files">
      {files.length === 0 ? <div className="empty">// LOG EMPTY — NO TRANSMISSIONS ARCHIVED</div> : null}
      {groups.map((g) => (
        <div className="file-group" key={g.day}>
          <div className="file-group-head">{g.day}</div>
          {g.items.map((f) => {
            const exp = expanded === f.id;
            const cp = copied === f.id;
            return (
              <div key={f.id} className={"file-card" + (exp ? " expanded" : "")}
                onClick={() => setExpanded(exp ? null : f.id)}>
                <div className="file-head">
                  <span className="file-time">{f.time}</span>
                  <span className="file-chip">{f.mode}</span>
                </div>
                <p className="file-preview">{f.text}</p>
                <div className="file-foot">
                  <div className="file-actions">
                    <button type="button" className={"fa" + (cp ? " copied" : "")} onClick={(e) => doCopy(e, f)}>
                      {cp ? "✓ COPIED" : "⧉ COPY"}
                    </button>
                    <button type="button" className="fa" onClick={stop}>▶ PLAY</button>
                    <button type="button" className="fa danger" onClick={(e) => { stop(e); onDelete(f.id); }}>✕</button>
                  </div>
                  <div className="file-meta2">
                    <span>{f.dur}</span><span>{f.words} WORDS</span>
                    <span className="file-exp">⌄</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ---------- MODES ---------- */
function ModesPanel({ modes, onToggle, onAdd }) {
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ n: "", trig: "", lang: "AUTO", model: "whisper-large-v3" });
  function set(k, v) { setForm((s) => ({ ...s, [k]: v })); }
  function cancel() { setCreating(false); setForm({ n: "", trig: "", lang: "AUTO", model: "whisper-large-v3" }); }
  function save() { onAdd(form); cancel(); }

  if (creating) {
    return (
      <div className="panel-body modes-new">
        <div className="nm-head">
          <span className="nm-title">DEFINE NEW MODE</span>
          <button type="button" className="nm-cancel" onClick={cancel}>✕ CANCEL</button>
        </div>
        <div className="nm-field">
          <label>MODE NAME</label>
          <input className="key-input" value={form.n} placeholder="E.G. EMAIL"
            onChange={(e) => set("n", e.target.value.toUpperCase())} />
        </div>
        <div className="nm-field">
          <label>TRIGGER <span>APP OR WEBSITE</span></label>
          <input className="key-input" value={form.trig} placeholder="example.com"
            onChange={(e) => set("trig", e.target.value)} />
        </div>
        <div className="nm-grid">
          <div className="nm-field">
            <label>LANGUAGE</label>
            <select className="set-select" value={form.lang} onChange={(e) => set("lang", e.target.value)}>
              <option>AUTO</option><option>EN</option><option>ES</option><option>DE</option><option>FR</option><option>JA</option>
            </select>
          </div>
          <div className="nm-field">
            <label>MODEL</label>
            <select className="set-select" value={form.model} onChange={(e) => set("model", e.target.value)}>
              <option>whisper-large-v3</option><option>gpt-realtime-whisper</option>
            </select>
          </div>
        </div>
        <button type="button" className="nm-save" onClick={save}>✓ SAVE MODE</button>
      </div>
    );
  }

  return (
    <div className="panel-body modes">
      <button type="button" className="add-mode top" onClick={() => setCreating(true)}>＋ DEFINE NEW MODE</button>
      {modes.map((m) => (
        <div key={m.id} className={"mode-card" + (m.active ? " active" : "") + (m.on ? "" : " off")}>
          <div className="mode-top">
            <div className="mode-id">
              <span className="mode-n">{m.n}</span>
              {m.active ? <span className="mode-badge">● ACTIVE</span> : null}
            </div>
            <Toggle on={m.on} onToggle={() => onToggle(m.id)} labels={["ENABLED", "DISABLED"]} />
          </div>
          <div className="mode-rules">
            <span className="mr"><span className="mr-k">TRIGGER</span> {m.trig}</span>
            <span className="mr"><span className="mr-k">LANG</span> {m.lang}</span>
            <span className="mr"><span className="mr-k">MODEL</span> {m.model}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- SETTINGS ---------- */
function SettingsPanel() {
  const [key, setKey] = useState("sk-proj-•••••••••••••••••4f2a");
  const [recMode, setRecMode] = useState("TOGGLE");
  const [sfx, setSfx] = useState(true);
  const [notify, setNotify] = useState(true);
  const [lang, setLang] = useState("ENGLISH (US)");
  const [reveal, setReveal] = useState(false);
  return (
    <div className="panel-body settings">
      <div className="set-row">
        <div className="set-label">OPENAI API KEY <span className="set-sub">BRING-YOUR-OWN-KEY</span></div>
        <div className="set-key">
          <input className="key-input" value={key} onChange={(e) => setKey(e.target.value)}
            type={reveal ? "text" : "password"} spellCheck="false" />
          <button type="button" className="key-eye" onClick={() => setReveal((r) => !r)}>{reveal ? "HIDE" : "SHOW"}</button>
          <span className="set-ok">✓ VALID</span>
        </div>
      </div>
      <div className="set-row">
        <div className="set-label">CAPTURE BEHAVIOR</div>
        <Segmented value={recMode} options={["TOGGLE", "PUSH-TO-TALK"]} onChange={setRecMode} />
        <div className="set-hint">{recMode === "TOGGLE"
          ? "PRESS ⌥SPACE TO START · PRESS AGAIN TO STOP + TRANSCRIBE."
          : "HOLD ⌥SPACE TO RECORD · RELEASE TO TRANSCRIBE."}</div>
      </div>
      <div className="set-grid">
        <div className="set-cell">
          <div className="set-label">GLOBAL SHORTCUT</div>
          <div className="kbd">⌥ <span>SPACE</span></div>
        </div>
        <div className="set-cell">
          <div className="set-label">APP LANGUAGE</div>
          <select className="set-select" value={lang} onChange={(e) => setLang(e.target.value)}>
            <option>ENGLISH (US)</option><option>ESPAÑOL</option><option>DEUTSCH</option>
            <option>日本語</option><option>FRANÇAIS</option>
          </select>
        </div>
      </div>
      <div className="set-row inline">
        <div className="set-label">SOUND EFFECTS <span className="set-sub">START / STOP CUES</span></div>
        <Toggle on={sfx} onToggle={() => setSfx((s) => !s)} labels={["ON", "SILENT"]} />
      </div>
      <div className="set-row inline">
        <div className="set-label">AUTO-SWITCH ALERTS <span className="set-sub">NOTIFY ON MODE CHANGE</span></div>
        <Toggle on={notify} onToggle={() => setNotify((n) => !n)} labels={["ON", "OFF"]} />
      </div>
    </div>
  );
}

Object.assign(window, {
  Frame, Card, Blocks, Toggle, Segmented, Qr,
  HomePanel, FilesPanel, ModesPanel, SettingsPanel,
});
