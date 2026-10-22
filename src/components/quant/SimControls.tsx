import type { Vektor } from "../../hooks/useVektor";
import type { Scenario } from "../../sim/priceSim";
import { formatCurrency } from "../../math/formatUtils";
import { Row } from "./GridStudio";

const SCENARIOS: [Scenario, string, string][] = [
  ["FLASH_CRASH", "Flash crash −12%", "btn-danger"],
  ["SQUEEZE", "Squeeze +10%", "btn-primary"],
  ["TREND_DOWN", "Grind down", "btn-secondary"],
  ["TREND_UP", "Grind up", "btn-secondary"],
  ["RANGE", "Back to range", "btn-secondary"],
];

export function SimControls({ v }: { v: Vektor }) {
  const s = v.sim;
  return (
    <div className="panel">
      <h3>Demo market</h3>
      <div className="kv">
        <Row k="Wallet" val={formatCurrency(v.wallet)} />
        <Row k="Open orders" val={String(v.openOrders)} />
        <Row k="Scenario" val={s.scenario.replace("_", " ").toLowerCase()} />
      </div>
      <div className="side-toggle" style={{ margin: "8px 0" }}>
        <button className={`btn ${s.running ? "active" : ""}`} onClick={() => s.setRunning(!s.running)}>{s.running ? "Pause" : "Play"}</button>
        {[1, 3, 8].map((x) => <button key={x} className={`btn ${s.speed === x ? "active" : ""}`} onClick={() => s.setSpeed(x)}>{x}×</button>)}
      </div>
      <div className="scenario-list">
        {SCENARIOS.map(([sc, label, cls]) => (
          <button key={sc} className={`btn ${cls}`} disabled={s.scenario === sc && sc !== "RANGE"} onClick={() => s.trigger(sc)}>{label}</button>
        ))}
      </div>
      <button className="btn btn-secondary" style={{ marginTop: 8, width: "100%" }} onClick={s.reset}>Reset demo</button>
      <p className="text-xs text-secondary" style={{ marginTop: 8 }}>
        Same engines, same order payloads — only the adapter differs. Switch to LIVE to run on Strike testnet with your API wallet.
      </p>
    </div>
  );
}
