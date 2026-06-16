// home.jsx — transcripts-first Home: stats strip, search, day-grouped cards, expand.
(function () {
  const { useState, useEffect, useRef, useMemo } = React;
  const I = window.Icons;
  const VOX = window.VOX;

  // ---- inject interaction CSS once ----
  const CSS = `
  .vx-btn{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:13px;
    letter-spacing:.12em;text-transform:uppercase;color:var(--ink);background:rgba(255,255,255,.55);
    border:1px solid var(--line);padding:8px 13px;cursor:pointer;transition:background .1s,border-color .1s,transform .04s;white-space:nowrap;}
  .vx-btn:hover{background:#fff;border-color:var(--ink-3);}
  .vx-btn:active{transform:translateY(1px);}
  .vx-btn--mag{color:var(--mag);border-color:var(--mag-line);}
  .vx-btn--mag:hover{background:var(--mag-soft);border-color:var(--mag);}
  .vx-btn--danger:hover{background:rgba(255,45,45,.08);border-color:var(--err);color:var(--err);}
  .vx-btn[disabled]{opacity:.4;cursor:not-allowed;pointer-events:none;}

  .vx-ico{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;
    border:1px solid var(--line);background:rgba(255,255,255,.55);color:var(--ink-2);cursor:pointer;transition:.1s;}
  .vx-ico:hover{background:#fff;color:var(--ink);border-color:var(--ink-3);}
  .vx-ico:active{transform:translateY(1px);}

  .tcard{position:relative;border:1px solid var(--line-soft);background:var(--panel);transition:opacity .18s,border-color .12s,background .12s;}
  .tcard:hover{border-color:var(--line);}
  .tcard .hovctl{opacity:0;transition:opacity .12s;}
  .tcard:hover .hovctl{opacity:1;}
  .tcard--dim{opacity:.34;}
  .tcard--dim:hover{opacity:.62;}
  .tcard--open{background:rgba(255,255,255,.72);border-color:var(--ink);opacity:1;}

  .vx-tab{font-family:var(--mono);font-size:12.5px;letter-spacing:.1em;text-transform:uppercase;
    padding:7px 14px;border:1px solid transparent;background:none;color:var(--ink-3);cursor:pointer;transition:.1s;}
  .vx-tab:hover{color:var(--ink);}
  .vx-tab--on{color:var(--ink);background:rgba(255,255,255,.85);border-color:var(--line);}

  .splitcopy{display:inline-flex;border:1px solid var(--line);background:rgba(255,255,255,.55);}
  .splitcopy>button{background:none;border:none;}
  .splitcopy .sc-main{display:inline-flex;align-items:center;gap:8px;padding:8px 13px;font-size:13px;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;color:var(--ink);transition:.1s;}
  .splitcopy .sc-main:hover{background:#fff;}
  .splitcopy .sc-div{width:1px;background:var(--line);}
  .splitcopy .sc-caret{padding:0 9px;display:inline-flex;align-items:center;cursor:pointer;color:var(--ink-2);transition:.1s;}
  .splitcopy .sc-caret:hover{background:#fff;color:var(--ink);}

  .prov{display:inline-flex;align-items:center;justify-content:center;position:relative;color:var(--ink-2);}
  .prov .tip{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);
    background:var(--ink);color:#fff;font-size:11px;letter-spacing:.14em;padding:4px 8px;white-space:nowrap;
    opacity:0;pointer-events:none;transition:.1s;}
  .prov .tip::after{content:"";position:absolute;top:100%;left:50%;transform:translateX(-50%);
    border:4px solid transparent;border-top-color:var(--ink);}
  .prov:hover .tip{opacity:1;}
  .prov:hover{color:var(--ink);}

  @keyframes vxshimmer{0%{background-position:-340px 0;}100%{background-position:340px 0;}}
  .skel{background:linear-gradient(90deg,rgba(16,20,26,.05) 25%,rgba(16,20,26,.10) 37%,rgba(16,20,26,.05) 63%);
    background-size:680px 100%;animation:vxshimmer 1.25s infinite linear;}
  @media (prefers-reduced-motion: reduce){.skel{animation:none;}}
  `;
  function useInjectCSS() {
    useEffect(() => {
      if (document.getElementById('vx-home-css')) return;
      const s = document.createElement('style'); s.id = 'vx-home-css'; s.textContent = CSS;
      document.head.appendChild(s);
    }, []);
  }

  // ---- version rendering helpers ----
  function renderVersion(text, version) {
    if (version === 'wt') {
      const words = text.split(/\s+/);
      const chunks = [];
      for (let i = 0; i < words.length; i += 5) chunks.push(words.slice(i, i + 5).join(' '));
      let t = 0;
      return chunks.map((c, i) => { const ts = t; t += 2; return (
        <span key={i}><span style={{ color: 'var(--mag)', fontSize: '0.82em', letterSpacing: '0.04em' }}>[{String(Math.floor(ts/60)).padStart(2,'0')}:{String(ts%60).padStart(2,'0')}] </span>{c} </span>
      ); });
    }
    if (version === 'sl') {
      const sents = text.match(/[^.!?]+[.!?]+(\s|$)/g) || [text];
      return sents.map((s, i) => (
        <span key={i} style={{ display: 'block', marginBottom: 7 }}>
          <span style={{ color: 'var(--mag)', letterSpacing: '0.1em', fontSize: '0.82em' }}>SPEAKER {(i % 2) + 1} &#9656; </span>{s.trim()}
        </span>
      ));
    }
    return text;
  }
  function plainVersion(text, version) {
    if (version === 'wt') {
      const words = text.split(/\s+/); let out = ''; let t = 0;
      for (let i = 0; i < words.length; i += 5) { out += `[${String(Math.floor(t/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}] ${words.slice(i,i+5).join(' ')} `; t += 2; }
      return out.trim();
    }
    if (version === 'sl') {
      const sents = text.match(/[^.!?]+[.!?]+(\s|$)/g) || [text];
      return sents.map((s, i) => `SPEAKER ${(i%2)+1}: ${s.trim()}`).join('\n');
    }
    return text;
  }
  const VERSION_LABEL = { original: 'ORIGINAL', wt: 'WORD TIMESTAMPS', sl: 'SPEAKER LABELS' };
  const COPY_LABEL = { original: 'Copy plain text', wt: 'Copy with word timestamps', sl: 'Copy with speaker labels' };

  // ---------- provider chip with mode tooltip ----------
  function ProviderChip({ provider, mode, size = 14 }) {
    return (
      <span className="prov" style={{ width: size + 8, height: size + 8 }}>
        <I.ProviderLogo id={provider} size={size} />
        <span className="tip">{mode}</span>
      </span>
    );
  }

  // ---------- transcript card ----------
  function TranscriptCard({ t, open, dimmed, density, onToggle, onDelete }) {
    const [version, setVersion] = useState('original');
    const [playing, setPlaying] = useState(false);
    const [copied, setCopied] = useState(false);
    const [copyMenu, setCopyMenu] = useState(false);
    const [confirmDel, setConfirmDel] = useState(false);
    const [retr, setRetr] = useState(false);
    const [queued, setQueued] = useState(null);
    const [elapsed, setElapsed] = useState(0);
    const timer = useRef(null);

    useEffect(() => { if (!open) { setVersion('original'); setCopyMenu(false); setConfirmDel(false); setRetr(false); setPlaying(false); stop(); } }, [open]);
    function stop() { if (timer.current) { clearInterval(timer.current); timer.current = null; } }
    function togglePlay() {
      if (playing) { setPlaying(false); stop(); return; }
      setPlaying(true); setElapsed(0);
      timer.current = setInterval(() => setElapsed((e) => { if (e + 1 >= t.dur) { stop(); setPlaying(false); return 0; } return e + 1; }), 1000);
    }
    useEffect(() => () => stop(), []);

    function doCopy(v) { setCopied(true); setCopyMenu(false); setTimeout(() => setCopied(false), 1400); }
    const fmtT = (s) => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
    const pad = density === 'compact' ? { py: 13, px: 18, prev: 14.5, gap: 10 } : { py: 19, px: 24, prev: 16, gap: 16 };
    const hasTabs = t.versions.length > 1;

    return (
      <div className={'tcard' + (open ? ' tcard--open' : dimmed ? ' tcard--dim' : '')}>
        {/* collapsed header — always visible, click toggles */}
        <div onClick={onToggle} style={{ display: 'flex', alignItems: 'flex-start', gap: 18, padding: `${pad.py}px ${pad.px}px`, cursor: 'pointer' }}>
          <div style={{ fontSize: 16, letterSpacing: '0.08em', color: open ? 'var(--ink)' : 'var(--ink-2)', fontWeight: 500, minWidth: 86, paddingTop: 1 }}>{t.time}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: pad.prev, lineHeight: 1.6, color: 'var(--ink)', letterSpacing: '0.01em',
                        ...(open ? {} : { display: '-webkit-box', WebkitLineClamp: density === 'compact' ? 2 : 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }) }}>
              {open ? null : t.preview}
            </p>
          </div>
          {/* hover controls — collapsed only */}
          {!open && (
            <div className="hovctl" style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 1 }} onClick={(e) => e.stopPropagation()}>
              <button className="vx-ico" title="Copy transcript" onClick={() => doCopy('original')} style={{ width: 30, height: 30 }}>
                {copied ? <span style={{ color: 'var(--mag)' }}><I.Check size={15} /></span> : <I.Copy size={15} />}
              </button>
              <ProviderChip provider={t.provider} mode={t.modeName} size={15} />
            </div>
          )}
        </div>

        {/* expanded body */}
        {open && (
          <div style={{ padding: `0 ${pad.px}px ${pad.px}px`, animation: 'none' }}>
            {/* transcript text (version-aware) */}
            <div style={{ fontSize: 16.5, lineHeight: 1.72, color: 'var(--ink)', letterSpacing: '0.01em', marginBottom: 20, maxWidth: '64ch' }}>
              {renderVersion(t.text, version)}
            </div>

            {/* play control */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
              <button className="vx-btn vx-btn--mag" onClick={togglePlay} style={{ minWidth: 96, justifyContent: 'center' }}>
                {playing ? <I.Stop size={13} /> : <I.Play size={13} />}{playing ? 'STOP' : 'PLAY'}
              </button>
              <span style={{ fontSize: 13.5, letterSpacing: '0.1em', color: 'var(--ink-2)' }}>
                {fmtT(elapsed)} / {fmtT(t.dur)}
              </span>
            </div>

            {/* version tabs */}
            {hasTabs && (
              <div style={{ display: 'inline-flex', gap: 4, border: '1px solid var(--line)', padding: 4, marginBottom: 20 }}>
                {t.versions.map((v) => (
                  <button key={v} className={'vx-tab' + (version === v ? ' vx-tab--on' : '')} onClick={() => setVersion(v)}>
                    {VERSION_LABEL[v]}
                  </button>
                ))}
              </div>
            )}

            {/* action row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 22 }}>
              {/* split copy */}
              <div style={{ position: 'relative' }}>
                <div className="splitcopy">
                  <button className="sc-main" onClick={() => doCopy(version)}>
                    {copied ? <span style={{ color: 'var(--mag)' }}><I.Check size={14} /></span> : <I.Copy size={14} />}
                    {copied ? 'COPIED' : 'COPY'}
                  </button>
                  <span className="sc-div" />
                  <button className="sc-caret" onClick={() => setCopyMenu((m) => !m)} aria-label="copy options"><I.ChevDown size={14} /></button>
                </div>
                {copyMenu && (
                  <div style={menuStyle}>
                    {t.versions.map((v) => (
                      <button key={v} style={menuItem} onClick={() => doCopy(v)}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--mag-soft)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                        {COPY_LABEL[v]}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* retranscribe */}
              <div style={{ position: 'relative' }}>
                <button className="vx-btn" onClick={() => { setRetr((r) => !r); setQueued(null); }}>
                  <I.Rerun size={14} />RE-TRANSCRIBE<span style={{ color: 'var(--ink-3)' }}><I.ChevDown size={12} /></span>
                </button>
                {retr && (
                  <div style={{ ...menuStyle, minWidth: 230 }}>
                    <div style={{ padding: '8px 14px 6px', fontSize: 11, letterSpacing: '0.16em', color: 'var(--ink-3)' }}>RE-RUN THROUGH MODE</div>
                    {VOX.MODES.filter((m) => m.id !== t.modeId && m.enabled).map((m) => (
                      <button key={m.id} style={menuItem} onClick={() => { setQueued(m.name); setRetr(false); }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--mag-soft)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
                          <span style={{ color: 'var(--ink-2)' }}><I.ProviderLogo id={m.provider} size={13} /></span>{m.name}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {queued && (
                <span style={{ fontSize: 13, letterSpacing: '0.1em', color: 'var(--mag)' }}>QUEUED &#9656; {queued}</span>
              )}

              {/* delete */}
              <div style={{ marginLeft: 'auto' }}>
                {!confirmDel ? (
                  <button className="vx-btn vx-btn--danger" onClick={() => setConfirmDel(true)}><I.Trash size={14} />DELETE</button>
                ) : (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, border: '1px solid var(--err)', padding: '6px 6px 6px 14px', background: 'rgba(255,45,45,.05)' }}>
                    <span style={{ fontSize: 13, letterSpacing: '0.08em', color: 'var(--ink)' }}>Delete recording?</span>
                    <button className="vx-btn" onClick={() => setConfirmDel(false)}>CANCEL</button>
                    <button className="vx-btn" style={{ color: '#fff', background: 'var(--err)', borderColor: 'var(--err)' }} onClick={() => onDelete(t.id)}>DELETE</button>
                  </div>
                )}
              </div>
            </div>

            {/* metadata row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 22, paddingTop: 16, borderTop: '1px solid var(--line-soft)', fontSize: 13.5, letterSpacing: '0.08em', color: 'var(--ink-2)' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
                <ProviderChip provider={t.provider} mode={t.modeName} size={15} />
                <span style={{ color: 'var(--ink-3)' }}>{t.provider.toUpperCase()}</span>
              </span>
              <Meta k="DUR" v={t.durLabel} />
              <Meta k="SIZE" v={t.size} />
              <Meta k="WORDS" v={t.words} />
              <Meta k="COST" v={t.cost} mag />
            </div>
          </div>
        )}
      </div>
    );
  }
  const Meta = ({ k, v, mag }) => (
    <span style={{ whiteSpace: 'nowrap' }}><span style={{ color: 'var(--ink-3)', marginRight: 7 }}>{k}</span><span style={{ color: mag ? 'var(--mag)' : 'var(--ink)' }}>{v}</span></span>
  );
  const menuStyle = { position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 30, minWidth: 210, background: '#fff', border: '1px solid var(--ink)', boxShadow: '4px 4px 0 rgba(16,20,26,.12)', padding: '4px 0' };
  const menuItem = { display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', padding: '9px 14px', fontSize: 13, letterSpacing: '0.04em', color: 'var(--ink)', cursor: 'pointer' };

  // ---------- stats strip ----------
  function StatsStrip() {
    const s = VOX.STATS;
    const cell = (label, val, sub, mag) => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '0 26px', borderRight: '1px solid var(--line-soft)' }}>
        <span style={{ fontSize: 11.5, letterSpacing: '0.18em', color: 'var(--ink-3)' }}>{label}</span>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontFamily: 'var(--display)', fontWeight: 600, fontSize: 22, color: mag ? 'var(--mag)' : 'var(--ink)', letterSpacing: '0.01em' }}>{val}</span>
          <span style={{ fontSize: 11.5, letterSpacing: '0.12em', color: 'var(--ink-3)' }}>{sub}</span>
        </span>
      </div>
    );
    return (
      <div style={{ display: 'flex', alignItems: 'center', border: '1px solid var(--line-soft)', background: 'rgba(255,255,255,.4)', padding: '14px 0', marginBottom: 22 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, padding: '0 26px', borderRight: '1px solid var(--line-soft)', color: 'var(--ink-2)' }}>
          <I.ProviderLogo id="xai" size={15} />
          <span style={{ flexDirection: 'column', display: 'flex', gap: 3 }}>
            <span style={{ fontSize: 11.5, letterSpacing: '0.18em', color: 'var(--ink-3)' }}>TOP MODEL</span>
            <span style={{ fontFamily: 'var(--display)', fontWeight: 600, fontSize: 18, color: 'var(--ink)', letterSpacing: '0.01em' }}>{s.topModel.name}</span>
          </span>
        </span>
        {cell('TOTAL SPEND', s.spend, 'LOCAL EST', true)}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '0 26px' }}>
          <span style={{ fontSize: 11.5, letterSpacing: '0.18em', color: 'var(--ink-3)' }}>MINUTES CAPTURED</span>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontFamily: 'var(--display)', fontWeight: 600, fontSize: 22, color: 'var(--ink)', letterSpacing: '0.01em' }}>{s.minutes}</span>
            <span style={{ fontSize: 11.5, letterSpacing: '0.12em', color: 'var(--ink-3)' }}>&#8776; {s.hours} HRS</span>
          </span>
        </div>
      </div>
    );
  }

  // ---------- search bar ----------
  function SearchBar({ value, onChange }) {
    return (
      <div style={{ position: 'relative', marginBottom: 22 }}>
        <span style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-3)' }}><I.Search size={17} /></span>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search transcripts"
          style={{ width: '100%', boxSizing: 'border-box', padding: '14px 48px 14px 46px', fontSize: 15, letterSpacing: '0.04em',
                   color: 'var(--ink)', background: 'rgba(255,255,255,.55)', border: '1px solid var(--line)', outline: 'none' }}
          onFocus={(e) => e.target.style.borderColor = 'var(--mag)'}
          onBlur={(e) => e.target.style.borderColor = 'var(--line)'}
        />
        {value && (
          <button className="vx-ico" onClick={() => onChange('')} title="Clear"
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', width: 28, height: 28, border: 'none', background: 'transparent' }}>
            <I.Close size={15} />
          </button>
        )}
      </div>
    );
  }

  // ---------- day header ----------
  const DayHead = ({ day }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, margin: '6px 0 14px' }}>
      <span style={{ fontSize: 13, letterSpacing: '0.22em', color: 'var(--ink-2)', fontWeight: 500 }}>{day}</span>
      <span style={{ flex: 1, height: 1, background: 'var(--line-soft)' }} />
    </div>
  );

  // ---------- skeleton ----------
  const Skeleton = () => (
    <div>
      <div style={{ display: 'flex', gap: 16, margin: '6px 0 14px' }}><span className="skel" style={{ height: 12, width: 90 }} /><span style={{ flex: 1, height: 1, background: 'var(--line-soft)', alignSelf: 'center' }} /></div>
      {[0,1,2].map((i) => (
        <div key={i} style={{ border: '1px solid var(--line-soft)', padding: '20px 24px', marginBottom: 16, display: 'flex', gap: 18 }}>
          <span className="skel" style={{ height: 14, width: 70 }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 9 }}>
            <span className="skel" style={{ height: 12, width: '92%' }} />
            <span className="skel" style={{ height: 12, width: '78%' }} />
            <span className="skel" style={{ height: 12, width: '40%' }} />
          </div>
        </div>
      ))}
    </div>
  );

  // ---------- placeholders ----------
  function StatePanel({ children }) {
    return <div style={{ minHeight: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 40 }}>{children}</div>;
  }
  const EmptyAll = () => (
    <StatePanel>
      <div style={{ maxWidth: 520 }}>
        <div style={{ color: 'var(--ink)', marginBottom: 22, display: 'flex', justifyContent: 'center' }}><I.Mic size={40} stroke={1.4} /></div>
        <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 26, color: 'var(--ink)', letterSpacing: '0.02em', marginBottom: 16, lineHeight: 1.2 }}>TAKE CONTROL OF YOUR VOICE</div>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--ink-2)', letterSpacing: '0.03em', margin: '0 0 24px' }}>
          No transmissions logged yet. Hold the capture shortcut and speak — your first transcription appears here.
        </p>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12, border: '1px solid var(--mag-line)', background: 'var(--mag-soft)', padding: '12px 20px' }}>
          <span style={{ fontSize: 12, letterSpacing: '0.14em', color: 'var(--ink-2)' }}>HOLD</span>
          <Kbd>OPTION</Kbd><span style={{ color: 'var(--ink-3)' }}>+</span><Kbd>SPACE</Kbd>
          <span style={{ fontSize: 12, letterSpacing: '0.14em', color: 'var(--mag)' }}>TO RECORD</span>
        </div>
      </div>
    </StatePanel>
  );
  const Kbd = ({ children }) => (
    <span style={{ fontSize: 12, letterSpacing: '0.12em', color: 'var(--ink)', border: '1px solid var(--ink-3)', borderBottomWidth: 2, padding: '4px 9px', background: '#fff' }}>{children}</span>
  );
  const EmptySearch = ({ q }) => (
    <StatePanel>
      <div style={{ maxWidth: 460 }}>
        <div style={{ color: 'var(--ink-3)', marginBottom: 18, display: 'flex', justifyContent: 'center' }}><I.Search size={34} /></div>
        <div style={{ fontSize: 15, letterSpacing: '0.1em', color: 'var(--ink)', marginBottom: 8 }}>NO TRANSCRIPTS MATCH</div>
        <p style={{ fontSize: 14, color: 'var(--ink-2)', letterSpacing: '0.03em', margin: 0 }}>Nothing found for &ldquo;<span style={{ color: 'var(--mag)' }}>{q}</span>&rdquo;. Try a different term.</p>
      </div>
    </StatePanel>
  );
  const ErrorPanel = ({ onRetry }) => (
    <StatePanel>
      <div style={{ maxWidth: 480 }}>
        <div style={{ color: 'var(--err)', marginBottom: 18, display: 'flex', justifyContent: 'center' }}><I.Alert size={38} /></div>
        <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 19, color: 'var(--ink)', letterSpacing: '0.04em', marginBottom: 10 }}>ARCHIVE UNREACHABLE</div>
        <p style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--ink-2)', letterSpacing: '0.03em', margin: '0 0 22px' }}>
          VX-0xA7 could not read the local transmission log. The store may be locked by another process.
        </p>
        <button className="vx-btn vx-btn--mag" onClick={onRetry}><I.Rerun size={14} />RETRY</button>
      </div>
    </StatePanel>
  );

  // ---------- home screen ----------
  function HomeScreen({ density, homeState, onStateChange }) {
    useInjectCSS();
    const [list, setList] = useState(VOX.TRANSCRIPTS);
    const [q, setQ] = useState('');
    const [openId, setOpenId] = useState(null);

    useEffect(() => { if (homeState !== 'default') setOpenId(null); }, [homeState]);

    const filtered = useMemo(() => {
      const base = list;
      if (!q.trim()) return base;
      const needle = q.toLowerCase();
      return base.filter((t) => t.text.toLowerCase().includes(needle) || t.modeName.toLowerCase().includes(needle) || t.app.toLowerCase().includes(needle));
    }, [list, q]);

    const groups = VOX.groupByDay(filtered);

    function onDelete(id) { setList((l) => l.filter((x) => x.id !== id)); setOpenId(null); }

    let body;
    if (homeState === 'loading') body = <Skeleton />;
    else if (homeState === 'error') body = <ErrorPanel onRetry={() => onStateChange && onStateChange('default')} />;
    else if (homeState === 'empty' || list.length === 0) body = <EmptyAll />;
    else if (filtered.length === 0) body = <EmptySearch q={q} />;
    else body = (
      <div>
        {groups.map((g) => (
          <div key={g.day} style={{ marginBottom: 26 }}>
            <DayHead day={g.day} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: density === 'compact' ? 10 : 14 }}>
              {g.items.map((t) => (
                <TranscriptCard key={t.id} t={t} density={density}
                  open={openId === t.id}
                  dimmed={openId !== null && openId !== t.id}
                  onToggle={() => setOpenId((cur) => cur === t.id ? null : t.id)}
                  onDelete={onDelete} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );

    const showSearchAndStats = homeState !== 'empty' && list.length > 0 && homeState !== 'error';

    return (
      <div onClick={(e) => { /* close menus handled per-card */ }}>
        {showSearchAndStats && <StatsStrip />}
        {showSearchAndStats && <SearchBar value={q} onChange={setQ} />}
        {body}
      </div>
    );
  }

  window.HomeScreen = HomeScreen;
})();
