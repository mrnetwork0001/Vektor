import type { Regime } from "../../hooks/useRegime";

interface Props {
  regime: Regime;
  symbol: string;
  enabled: boolean;
  setEnabled: (v: boolean) => void;
}

const LEVEL_COLOR = { CALM: "#25fab0", ELEVATED: "#f59e0b", EXTREME: "#f43f5e" } as const;

/** Compact regime card: F&G gauge, OI delta, 24h range, level badge, recommendation, guard toggle. Props-only. */
export function RegimePanel({ regime, symbol, enabled, setEnabled }: Props) {
  const a = regime.assessments[symbol];
  const fg = regime.fearGreed;
  const color = a ? LEVEL_COLOR[a.level] : "#888";
  const rec = a?.recommendation;

  return (
    <div className="panel" style={{ borderColor: a && a.level !== "CALM" ? color : undefined }}>
      <div className="panel-header">
        <h3>Market regime - {symbol}</h3>
        {a && <span style={{ color, fontSize: 12, fontWeight: 700, letterSpacing: 0.5 }}>{a.level} · {a.score}</span>}
      </div>

      {/* Fear & Greed gauge */}
      <div className="text-xs text-secondary" style={{ display: "flex", justifyContent: "space-between" }}>
        <span>Fear &amp; Greed</span>
        <span>{fg ? `${fg.value} · ${fg.classification}` : "-"}</span>
      </div>
      <div style={{ position: "relative", height: 8, borderRadius: 4, margin: "4px 0 10px", background: "linear-gradient(90deg, #f43f5e 0%, #f59e0b 35%, #888 50%, #f59e0b 65%, #25fab0 100%)", opacity: fg ? 1 : 0.3 }}>
        {fg && <span style={{ position: "absolute", top: -3, left: `calc(${fg.value}% - 2px)`, width: 4, height: 14, background: "#fff", borderRadius: 2 }} />}
      </div>

      <div className="kv">
        <KV k="Open interest vs baseline" v={a?.raw.oiDeltaPct != null ? `${a.raw.oiDeltaPct > 0 ? "+" : ""}${a.raw.oiDeltaPct}% (${regime.baselineSamples(symbol)} samples)` : "collecting…"} cls={a && Math.abs(a.raw.oiDeltaPct ?? 0) >= 25 ? "text-red" : ""} />
        <KV k="24h range" v={a?.raw.range24hPct != null ? `${a.raw.range24hPct}%` : "-"} cls={a && a.components.range24h >= 50 ? "text-red" : ""} />
        <KV k="Funding (APR)" v={a?.raw.fundingAprPct != null ? `${a.raw.fundingAprPct}%` : "-"} />
      </div>
      {a && (
        <div className="regime-chips" title="Score components (0-100)">
          <span className="regime-chip">sentiment<b>{a.components.sentiment}</b></span>
          <span className="regime-chip">OI shock<b>{a.components.oiShock}</b></span>
          <span className="regime-chip">24h range<b>{a.components.range24h}</b></span>
          <span className="regime-chip">funding<b>{a.components.funding}</b></span>
        </div>
      )}

      {a && (
        <div className="regime-rec" style={{ background: `${color}14`, border: `1px solid ${color}55` }}>
          <b style={{ color }}>{rec?.action}{rec?.widenFactor ? ` ×${rec.widenFactor}` : ""}</b>
          <span className="text-secondary"> - {a.reasons.join("; ")}</span>
        </div>
      )}

      <div className="checkbox-row">
        <input id="regime-guard" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <label htmlFor="regime-guard">Regime guard: pause new rungs when EXTREME, widen range when ELEVATED</label>
      </div>
      <p className="text-xs text-secondary" style={{ marginTop: 6 }}>
        {regime.error ? regime.error + " · " : ""}
        {regime.updatedAt ? `updated ${new Date(regime.updatedAt).toLocaleTimeString()}` : "loading…"} · public /price/v2 endpoints, 60s
      </p>
    </div>
  );
}

const KV = ({ k, v, cls = "" }: { k: string; v: string; cls?: string }) => (
  <div className="connected-row"><span className="text-secondary">{k}</span><span className={`text-sm ${cls}`}>{v}</span></div>
);
