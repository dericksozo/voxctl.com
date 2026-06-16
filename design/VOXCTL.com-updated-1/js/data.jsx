// data.jsx — fake VOXCTL content. Realistic dictation snippets, modes, providers.
(function () {
  // ---- providers ----
  const PROVIDERS = {
    openai: { id: 'openai', name: 'OPENAI', model: 'GPT-REALTIME-WHISPER' },
    xai:    { id: 'xai',    name: 'XAI',    model: 'GROK STT (LIVE)' },
    gemini: { id: 'gemini', name: 'GEMINI', model: 'GEMINI 2.5 FLASH' },
  };

  // ---- modes (also used by Modes screen + retranscribe picker) ----
  const MODES = [
    { id: 'default',  name: 'DEFAULT',           provider: 'openai', model: 'GPT-REALTIME-WHISPER', live: true,  trigger: '—', lang: 'AUTO', enabled: true, key: 'OPTION+1' },
    { id: 'xailive',  name: 'XAI LIVE',          provider: 'xai',    model: 'GROK STT (LIVE)',      live: true,  trigger: '—', lang: 'AUTO', enabled: true, key: 'OPTION+2' },
    { id: 'chatgpt',  name: 'CHATGPT',           provider: 'openai', model: 'GPT-REALTIME-WHISPER', live: true,  trigger: 'chatgpt.com · chat.openai.com', lang: 'AUTO', enabled: true, key: 'OPTION+3' },
    { id: 'gemini',   name: 'GEMINI FAST',       provider: 'gemini', model: 'GEMINI 2.5 FLASH',     live: false, trigger: 'gemini.google.com', lang: 'AUTO', enabled: true, key: '—' },
    { id: 'lang',     name: 'LANGUAGE LEARNING', provider: 'openai', model: 'GPT-REALTIME-WHISPER', live: true,  trigger: 'preply.com · italki.com · duolingo.com', lang: 'ESPAÑOL', enabled: true, key: '—' },
    { id: 'code',     name: 'CODE DICTATE',      provider: 'openai', model: 'GPT-REALTIME-WHISPER', live: false, trigger: 'cursor · vscode · terminal', lang: 'EN', enabled: true, key: '—' },
    { id: 'email',    name: 'EMAIL FORMAL',      provider: 'gemini', model: 'GEMINI 2.5 FLASH',     live: false, trigger: 'mail.google.com · superhuman', lang: 'EN', enabled: false, key: '—' },
    { id: 'notes',    name: 'QUICK NOTES',       provider: 'xai',    model: 'GROK STT (LIVE)',      live: true,  trigger: 'notion.so · obsidian', lang: 'EN', enabled: true, key: '—' },
  ];

  const modeById = (id) => MODES.find((m) => m.id === id) || MODES[0];

  // ---- transcripts ----
  // versions: original always true. wt = word timestamps, sl = speaker labels.
  const RAW = [
    {
      day: 'TODAY', time: '06:21 PM', modeId: 'xailive', app: 'Cursor',
      dur: 15, size: '713 KB', cost: '$0.0008', wt: true, sl: false,
      text: "Yes, go ahead and remove the screenshot. I've also added screenshots of the main screens to the design folder, so reference those instead when you rebuild the home view.",
    },
    {
      day: 'TODAY', time: '05:54 PM', modeId: 'code', app: 'Cursor',
      dur: 54, size: '2.5 MB', cost: '$0.0019', wt: true, sl: false,
      text: "Okay so the bug is in the expand handler. When you click a second card while one is already open, the gray-out state isn't getting cleared on the first one. I think we need to lift the active id up into a single piece of state instead of tracking open per card. Let me refactor that and then we can test it with three cards stacked.",
    },
    {
      day: 'TODAY', time: '03:12 PM', modeId: 'notes', app: 'Obsidian',
      dur: 9, size: '441 KB', cost: '$0.0004', wt: false, sl: false,
      text: "Note to self, pick up the dry cleaning before five and text Maya about the dinner reservation on Friday.",
    },
    {
      day: 'TODAY', time: '11:38 AM', modeId: 'chatgpt', app: 'Google Chrome',
      dur: 41, size: '1.9 MB', cost: '$0.0012', wt: true, sl: false,
      text: "I'm trying to understand the difference between a debounce and a throttle, and when I'd reach for one over the other. Walk me through a concrete example with a search input and a scroll listener, and keep it short, I just need the intuition not a full essay.",
    },
    {
      day: 'TODAY', time: '09:02 AM', modeId: 'gemini', app: 'Superhuman',
      dur: 28, size: '1.3 MB', cost: '$0.0003', wt: false, sl: false,
      text: "Hi Daniel, thanks for sending over the revised deck last night. The numbers on slide nine look much closer to what finance is expecting. One thing, can we add a footnote clarifying that the Q3 figure is an estimate. Happy to hop on a call tomorrow if that's easier.",
    },
    {
      day: 'YESTERDAY', time: '08:47 PM', modeId: 'xailive', app: 'Cursor',
      dur: 132, size: '6.1 MB', cost: '$0.0073', wt: true, sl: true,
      text: "Better. I want to go through what I've said in the design updates outline file. So ultimately what this markdown file is going to be, I'm going to put this into a design tool to help me redo the design. I want you to go through and make sure that everything is clear, make sure that everything is accurate, study the screenshots that I referenced in the inspiration folder, and just tell me yes, this is accurate, or flag the parts that are ambiguous so I can tighten them up before I hand it off.",
    },
    {
      day: 'YESTERDAY', time: '04:20 PM', modeId: 'lang', app: 'Preply',
      dur: 18, size: '862 KB', cost: '$0.0006', wt: true, sl: false,
      text: "Hola, perdón por llegar tarde a la lección. ¿Podemos repasar el subjuntivo otra vez? Todavía me confundo con cuándo usarlo en las frases condicionales.",
    },
    {
      day: 'YESTERDAY', time: '02:15 PM', modeId: 'default', app: 'TextEdit',
      dur: 6, size: '298 KB', cost: '$0.0002', wt: false, sl: false,
      text: "Remember to cancel the trial before the seventh, otherwise they charge the full year.",
    },
    {
      day: 'YESTERDAY', time: '10:09 AM', modeId: 'email', app: 'Gmail',
      dur: 37, size: '1.7 MB', cost: '$0.0004', wt: false, sl: false,
      text: "Hey team, quick recap from this morning's standup. The onboarding rewrite is on track for Thursday, the search filter cleanup is done and merged, and we're still blocked on the audio playback work until the new build lands. I'll send a calendar hold for the review once the staging link is up.",
    },
    {
      day: 'JUN 04', time: '07:33 PM', modeId: 'notes', app: 'Notion',
      dur: 22, size: '1.0 MB', cost: '$0.0009', wt: true, sl: false,
      text: "Idea for the weekend project, a little CLI that watches a folder and auto-transcribes any new audio file it finds, then drops the text next to it. Could be a fun excuse to learn the file watcher API properly.",
    },
    {
      day: 'JUN 04', time: '01:48 PM', modeId: 'chatgpt', app: 'Google Chrome',
      dur: 64, size: '3.0 MB', cost: '$0.0021', wt: true, sl: true,
      text: "Can you help me draft a polite but firm message to a landlord about a deposit that hasn't been returned. It's been about six weeks past the move-out date, I've followed up twice already by email, and the lease says it should be returned within thirty days. I want to sound reasonable but make it clear I know my rights here.",
    },
    {
      day: 'JUN 04', time: '08:11 AM', modeId: 'default', app: 'Slack',
      dur: 11, size: '512 KB', cost: '$0.0003', wt: false, sl: false,
      text: "Running about ten minutes late to the sync, go ahead and start without me and I'll catch up on the recording.",
    },
  ];

  let _idc = 0;
  function firstSentences(text, n) {
    const parts = text.match(/[^.!?]+[.!?]+(\s|$)/g) || [text];
    const slice = parts.slice(0, n).join('').trim();
    return slice.length ? slice : text;
  }

  const TRANSCRIPTS = RAW.map((r) => {
    const mode = modeById(r.modeId);
    const versions = ['original'];
    if (r.wt) versions.push('wt');
    if (r.sl) versions.push('sl');
    return {
      id: 'vx-' + (++_idc).toString(16).padStart(3, '0'),
      day: r.day,
      time: r.time,
      provider: mode.provider,
      modeName: mode.name,
      modeId: mode.id,
      app: r.app,
      dur: r.dur,
      durLabel: r.dur >= 60 ? Math.floor(r.dur / 60) + ':' + String(r.dur % 60).padStart(2, '0') : r.dur + 's',
      size: r.size,
      cost: r.cost,
      words: r.text.trim().split(/\s+/).length,
      versions,
      text: r.text,
      preview: firstSentences(r.text, 3),
    };
  });

  // group by day, preserving order
  function groupByDay(list) {
    const order = [];
    const map = {};
    list.forEach((t) => {
      if (!map[t.day]) { map[t.day] = []; order.push(t.day); }
      map[t.day].push(t);
    });
    return order.map((day) => ({ day, items: map[day] }));
  }

  const STATS = {
    words: 21330,
    recordings: 150,
    minutes: 333,
    hours: 5.5,
    interfaces: 9,
    spend: '$0.28',
    topModel: { name: 'GROK STT', mode: 'XAI LIVE', pct: 38 },
    topInterfaces: [
      { name: 'VOXCTL.COM', pct: 27 },
      { name: 'GOOGLE CHROME', pct: 23 },
      { name: 'CURSOR', pct: 20 },
      { name: 'TEXTEDIT', pct: 19 },
      { name: 'SLACK', pct: 11 },
    ],
  };

  window.VOX = { PROVIDERS, MODES, modeById, TRANSCRIPTS, groupByDay, STATS, firstSentences };
})();
