import type { Vektor } from "../../hooks/useVektor";
import { formatCurrency, formatPrice } from "../../math/formatUtils";

/** One row per running grid across symbols; click to focus, stop inline. */
export function ActiveGrids({ v }: { v: Vektor }) {
  const entries = Object.entries(v.grids);
  if (!entries.length) return null;
  return (
    <div className="panel">
      <h3>Active grids ({entries.length})</h3>
      {entries.map(([sym, g]) => (
        <div key={sym} className={`grid-row ${sym === v.symbol ? "selected" : ""}`} onClick={() => v.setSymbol(sym)}>
          <div>
            <b>{sym}</b> <span className="text-secondary text-xs">{formatPrice(g.plan.config.lowerPrice)}–{formatPrice(g.plan.config.upperPrice)} · {g.plan.config.leverage}x</span>
            <div className="text-xs">{g.cycles} trips · <span className={g.realizedUsd >= 0 ? "text-green" : "text-red"}>{formatCurrency(g.realizedUsd)}</span> · inv {g.inventory} · <span className="text-green">{formatCurrency(g.builderFeesUsd)} fees</span></div>
          </div>
          <button className="btn btn-danger" onClick={(e) => { e.stopPropagation(); void v.stopGrid(sym); }}>stop</button>
        </div>
      ))}
    </div>
  );
}
