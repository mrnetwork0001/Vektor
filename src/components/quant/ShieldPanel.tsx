import { useState } from "react";
import type { Vektor } from "../../hooks/useVektor";
import { formatCurrency, formatPrice } from "../../math/formatUtils";
import { alertsEnabled, requestAlerts } from "../../lib/notify";
import { confirmDialog } from "./ConfirmDialog";
import { Field, Row } from "./GridStudio";

export function ShieldPanel({ v }: { v: Vektor }) {
  const { shield, healths, setShieldRules } = v;
  const r = shield.rules;
  const [alerts, setAlerts] = useState(alertsEnabled());
  return (
    <div className="quant-grid">
      <div className="panel ladder-panel">
        <h3>Aegis liquidation shield — live buffers</h3>
        {!healths.length && <p className="text-secondary">No open positions. Deploy a grid, launch a hedge, or (demo) trigger a crash to see the shield act.</p>}
        {healths.map((h) => {
          const pos = v.positions.find((p) => p.symbol === h.symbol);
          const pct = Math.min(100, Math.max(0, h.distanceToLiqPct));
          const color = h.health === "CRITICAL" ? "#f43f5e" : h.health === "WARNING" ? "#f59e0b" : "#25fab0";
          return (
            <div key={h.symbol} className="gauge-row">
              <div className="gauge-head">
                <span><b>{h.symbol}</b> <span className={h.side === "LONG" ? "badge-long" : "badge-short"}>{h.side}</span> {h.size}</span>
                <span style={{ color }}>{h.health} · {h.distanceToLiqPct}% to liquidation</span>
              </div>
              <div className="gauge"><div style={{ width: `${Math.min(100, pct * 2.5)}%`, background: color }} />
                <span className="tick" style={{ left: `${r.warnPct * 2.5}%` }} title="Rule A" />
                <span className="tick" style={{ left: `${r.criticalPct * 2.5}%` }} title="Rule B" />
              </div>
              <div className="gauge-foot text-xs text-secondary">
                mark {formatPrice(h.markPrice)} · liq {h.liquidationPrice ? formatPrice(h.liquidationPrice) : "none"} · margin ratio {h.marginRatioPct}% · uPnL {pos?.uPnL != null ? formatCurrency(pos.uPnL) : "—"}
              </div>
            </div>
          );
        })}
      </div>

      <div className="panel">
        <h3>Rules</h3>
        <div className="checkbox-row"><input id="sh-on" type="checkbox" checked={r.enabled} onChange={(e) => setShieldRules({ enabled: e.target.checked })} /><label htmlFor="sh-on"><b>Shield enabled</b></label></div>
        <div className="checkbox-row"><input id="sh-a" type="checkbox" checked={r.ruleA} onChange={(e) => setShieldRules({ ruleA: e.target.checked })} /><label htmlFor="sh-a">Rule A — cancel resting buy rungs</label></div>
        <Field label={`…when buffer < ${r.warnPct}%`}><input type="range" min={2} max={25} step={0.5} value={r.warnPct} onChange={(e) => setShieldRules({ warnPct: +e.target.value })} /></Field>
        <div className="checkbox-row"><input id="sh-b" type="checkbox" checked={r.ruleB} onChange={(e) => setShieldRules({ ruleB: e.target.checked })} /><label htmlFor="sh-b">Rule B — reduce-only market trim</label></div>
        <Field label={`…when buffer < ${r.criticalPct}%, trim ${Math.round(r.trimFraction * 100)}%`}>
          <input type="range" min={1} max={20} step={0.5} value={r.criticalPct} onChange={(e) => setShieldRules({ criticalPct: +e.target.value })} />
          <input type="range" min={0.1} max={1} step={0.05} value={r.trimFraction} onChange={(e) => setShieldRules({ trimFraction: +e.target.value })} />
        </Field>
        <Field label={`Trim cooldown ${r.cooldownMs / 1000}s`}><input type="range" min={2} max={60} step={1} value={r.cooldownMs / 1000} onChange={(e) => setShieldRules({ cooldownMs: +e.target.value * 1000 })} /></Field>
        <div className="kv"><Row k="Rule C" val="funding flip guard lives in the Harvester (unwinds the hedge after 3 adverse hours)" /></div>
        <button className="btn btn-secondary btn-submit" disabled={alerts} onClick={() => requestAlerts().then(setAlerts)}>
          {alerts ? "Browser alerts on — shield & round trips notify even in the background" : "Enable browser alerts"}
        </button>
        <button className="btn btn-danger btn-submit" onClick={() => void confirmDialog("Cancel every open order on every symbol and close every position with reduce-only market orders. This cannot be undone.", { title: "PANIC — flatten everything?", okLabel: "Flatten everything", danger: true }).then((ok) => { if (ok) void v.panic(); })}>PANIC — flatten everything</button>
      </div>

      <div className="panel">
        <h3>Shield log</h3>
        <div className="log tall">
          {[...shield.log].reverse().map((l, i) => (
            <div key={i} className={`log-line log-${l.level}`}><span className="text-secondary">{new Date(l.t).toLocaleTimeString()}</span> <b>{l.symbol}</b> {l.msg}</div>
          ))}
          {!shield.log.length && <p className="text-secondary">Nothing yet</p>}
        </div>
      </div>
    </div>
  );
}
