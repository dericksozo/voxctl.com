import "../styles/panels/stats.css";
import { Card } from "../components/Primitives";
import { ProviderLogo } from "../components/ProviderLogo";
import { t } from "../i18n";
import { estimateCost, formatCost, modelById, type Registry } from "../lib/registry";
import type { HistoryItem } from "../lib/types";

/** Usage overview computed from real history. Zeros on first run (honest). */
export function HomePanel({
  history,
  registry,
  go,
}: {
  history: HistoryItem[];
  registry: Registry | null;
  go: (panel: string) => void;
}) {
  const words = history.reduce((s, h) => s + h.words, 0);
  const minutes = Math.round(history.reduce((s, h) => s + h.durationSecs, 0) / 60);
  // All-time local cost estimate (duration × model rate). Never the provider's
  // billing API — just a trust signal for a BYOK app.
  const totalCost = history.reduce(
    (s, h) => s + estimateCost(modelById(registry, h.modelId), h.durationSecs),
    0,
  );

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

  // Most-used model (by recording count) — surfaces the provider mark. Purely
  // derived from existing history; no new data source.
  const modelCounts = new Map<string, number>();
  for (const h of history) modelCounts.set(h.modelId, (modelCounts.get(h.modelId) || 0) + 1);
  const topModelEntry = [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const topModel = topModelEntry ? modelById(registry, topModelEntry[0]) : undefined;

  const stats = [
    { k: t("home.words"), v: words.toLocaleString(), d: `${history.length} RECORDINGS`, mag: false },
    { k: t("home.minutes"), v: String(minutes), d: `≈ ${(minutes / 60).toFixed(1)} HRS`, mag: false },
    {
      k: t("home.interfaces"),
      v: String(counts.size).padStart(2, "0"),
      d: "DISTINCT APPS",
      mag: false,
    },
    { k: t("home.spend"), v: formatCost(totalCost), d: t("home.spendSub"), mag: true },
  ];
  const start = [
    { t: t("home.start.shortcut.t"), d: t("home.start.shortcut.d"), to: "settings" },
    { t: t("home.start.mode.t"), d: t("home.start.mode.d"), to: "modes" },
    { t: t("home.start.key.t"), d: t("home.start.key.d"), to: "settings" },
  ];

  return (
    <div className="panel-body stats-panel">
      <div className="bigstat-row">
        {stats.map((s) => (
          <div className={"bigstat" + (s.mag ? " bigstat--mag" : "")} key={s.k}>
            <div className="bigstat-k">{s.k}</div>
            <div className="bigstat-v">{s.v}</div>
            <div className="bigstat-d">{s.d}</div>
          </div>
        ))}
      </div>

      <div className="stats-grid">
        <Card className="gs-card" label={t("home.gettingStarted")}>
          <ul className="gs-list">
            {start.map((g, i) => (
              <li key={i}>
                <button type="button" className="gs-row" onClick={() => go(g.to)}>
                  <span className="gs-text">
                    <span className="gs-t">{g.t}</span>
                    <span className="gs-d">{g.d}</span>
                  </span>
                  <span className="gs-arr" aria-hidden="true">
                    →
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <div className="stats-rcol">
          {topModel ? (
            <Card className="pm-card" label="PRIMARY MODEL">
              <div className="pm-body">
                <span className="prov pm-logo">
                  <ProviderLogo id={topModel.provider} size={22} />
                </span>
                <span className="pm-meta">
                  <span className="pm-name">{topModel.label}</span>
                  <span className="pm-sub">{topModelEntry[1]} RECORDINGS</span>
                </span>
              </div>
            </Card>
          ) : null}

          <Card className="ti-card" label={t("home.topInterfaces")}>
            {apps.length === 0 ? (
              <div className="ti-empty">// NO DATA YET</div>
            ) : (
              <ul className="ti-list">
                {apps.map((a, i) => (
                  <li key={a.n} className="ti-item">
                    <div className="ti-head">
                      <span className="ti-n">{a.n}</span>
                      <span className="ti-p">{Math.round(a.p * 100)}%</span>
                    </div>
                    <span className="ti-bar">
                      <i
                        className={i === 0 ? "is-top" : ""}
                        style={{ width: a.p * 100 + "%" }}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
