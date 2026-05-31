import { Card } from "../components/Primitives";
import { t } from "../i18n";
import type { HistoryItem } from "../lib/types";

/** Usage overview computed from real history. Zeros on first run (honest). */
export function HomePanel({ history, go }: { history: HistoryItem[]; go: (panel: string) => void }) {
  const words = history.reduce((s, h) => s + h.words, 0);
  const minutes = Math.round(history.reduce((s, h) => s + h.durationSecs, 0) / 60);

  const counts = new Map<string, number>();
  for (const h of history) {
    const k = h.appName || h.website || "—";
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const total = history.length || 1;
  const apps = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([n, c]) => ({ n: n.toUpperCase(), p: c / total }));

  const stats = [
    { k: t("home.words"), v: words.toLocaleString(), d: `${history.length} RECORDINGS` },
    { k: t("home.minutes"), v: String(minutes), d: `≈ ${(minutes / 60).toFixed(1)} HRS` },
    { k: t("home.interfaces"), v: String(counts.size).padStart(2, "0"), d: "DISTINCT APPS" },
  ];
  const start = [
    { t: t("home.start.shortcut.t"), d: t("home.start.shortcut.d"), to: "settings" },
    { t: t("home.start.mode.t"), d: t("home.start.mode.d"), to: "modes" },
    { t: t("home.start.key.t"), d: t("home.start.key.d"), to: "settings" },
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
        <Card className="home-start" label={t("home.gettingStarted")}>
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
        <Card className="home-apps" label={t("home.topInterfaces")}>
          {apps.length === 0 ? (
            <div className="empty" style={{ padding: "10px 4px" }}>
              // NO DATA YET
            </div>
          ) : (
            <ul className="app-list">
              {apps.map((a) => (
                <li key={a.n}>
                  <span className="app-n">{a.n}</span>
                  <span className="app-bar">
                    <i style={{ width: a.p * 100 + "%" }} />
                  </span>
                  <span className="app-p">{Math.round(a.p * 100)}%</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
