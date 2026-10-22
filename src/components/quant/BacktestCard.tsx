import { useState } from "react";
import type { Vektor } from "../../hooks/useVektor";
import type { GridMode } from "../../quant/gridEngine";
import { getMainnetKlines } from "../../api/vektor";
import { parseKlines, runGridBacktest, type BacktestResult, type Candle } from "../../quant/backtest";
import { suggestRange, type RangeSuggestion } from "../../quant/rangeSuggest";
import { formatCurrency, formatPrice } from "../../math/formatUtils";
import { Row, Stat } from "./GridStudio";

interface Props {
  v: Vektor;
  cfg: { lowerPrice: number; upperPrice: number; levels: number; marginUsd: number; leverage: number; mode: GridMode };
  onApplyRange: (s: RangeSuggestion) => void;
}

const WINDOWS: [string, number, string][] = [["24h", 1, "15m"], ["7d", 7, "1h"], ["30d", 30, "4h"]];

/** Backtest-before-deploy on real mainnet candles, plus an ATR-based range suggestion. */
export function BacktestCard({ v, cfg, onApplyRange }: Props) {
  const [win, setWin] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<BacktestResult | null>(null);
  const [sugg, setSugg] = useState<RangeSuggestion | null>(null);
  const [candles, setCandles] = useState<Candle[] | null>(null);

  const load = async (): Promise<Candle[]> => {
    const [, days, interval] = WINDOWS[win];
    const rows = await getMainnetKlines(v.symbol, interval, days);
    const cs = parseKlines(rows);
    if (cs.length < 15) throw new Error("not enough mainnet history for this market");
    setCandles(cs);
    return cs;
  };

  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const cs = await load();
      // Backtest the user's range as a % offset from the window's start price, so the shape of the grid is what's tested.
      const scale = cs[0].o / (v.mark || cs[cs.length - 1].c);
      setRes(runGridBacktest({ symbol: v.symbol, ...cfg, lowerPrice: cfg.lowerPrice * scale, upperPrice: cfg.upperPrice * scale }, cs, v.rulesFor(v.symbol), v.fees));
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const smart = async () => {
    setBusy(true); setErr(null);
    try {
      const cs = candles ?? (await load());
      const s = suggestRange(cs, v.fees);
      if (!s) throw new Error("could not derive a range");
      // Re-anchor the suggestion to the current mark (mainnet close may differ from the active mode's mark)
      const last = cs[cs.length - 1].c;
      const k = (v.mark || last) / last;
      setSugg({ ...s, lower: s.lower * k, upper: s.upper * k });
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="panel" data-tour="backtest">
      <div className="panel-header">
        <h3>Backtest before you deploy</h3>
        <div className="side-toggle">
          {WINDOWS.map(([label], i) => <button key={label} className={`btn ${win === i ? "active" : ""}`} onClick={() => { setWin(i); setCandles(null); }}>{label}</button>)}
        </div>
      </div>
      <div className="form-row">
        <button className="btn btn-primary" disabled={busy || !v.mark} onClick={run}>{busy ? "…" : `Backtest this grid (${WINDOWS[win][0]} mainnet ${v.symbol})`}</button>
        <button className="btn btn-secondary" disabled={busy} onClick={smart}>Smart range (ATR)</button>
      </div>
      {err && <div className="error">{err}</div>}
      {sugg && (
        <div className="kv">
          <Row k="Suggested" val={`${formatPrice(sugg.lower)} – ${formatPrice(sugg.upper)} · ${sugg.levels} levels · ${sugg.spacingPct}% spacing`} />
          <Row k="Basis" val={`${sugg.basis}; ATR ${sugg.atrPct}% of price; fee floor ${sugg.feeFloorPct}%`} />
          <button className="btn btn-secondary" onClick={() => onApplyRange(sugg)}>Apply to grid</button>
        </div>
      )}
      {res && (
        <>
          <Equity equity={res.equity} />
          <div className="stat-row">
            <Stat label="Net" value={formatCurrency(res.netUsd)} cls={res.netUsd >= 0 ? "text-green" : "text-red"} />
            <Stat label="On margin" value={`${res.netPctOnMargin}%`} cls={res.netPctOnMargin >= 0 ? "text-green" : "text-red"} />
            <Stat label="Annualised" value={`${res.annualizedPct}%`} />
            <Stat label="Round trips" value={String(res.cycles)} />
            <Stat label="Max DD" value={formatCurrency(res.maxDrawdownUsd)} cls="text-red" />
            <Stat label="In range" value={`${res.timeInRangePct}%`} />
          </div>
          <div className="kv">
            <Row k="Realized / inventory" val={`${formatCurrency(res.realizedUsd)} / ${formatCurrency(res.inventoryPnlUsd)} (${res.final.inventory} held at end)`} />
            <Row k="Fees / builder fees" val={`${formatCurrency(res.feesUsd)} / ${formatCurrency(res.builderFeesUsd)} on ${formatCurrency(res.volumeUsd)} volume`} />
            <Row k="Window" val={`${new Date(res.from).toLocaleString()} → ${new Date(res.to).toLocaleString()} · ${res.candles} candles`} />
          </div>
          <p className="text-xs text-secondary">Same matching engine and grid code as the live grid; wicks fill every rung they touch. Past range ≠ future range.</p>
        </>
      )}
    </div>
  );
}

function Equity({ equity }: { equity: number[] }) {
  const W = 600, H = 70;
  const min = Math.min(0, ...equity), max = Math.max(0, ...equity);
  const y = (v: number) => H - ((v - min) / (max - min || 1)) * (H - 4) - 2;
  const d = equity.map((e, i) => `${i === 0 ? "M" : "L"}${(i / (equity.length - 1)) * W},${y(e)}`).join(" ");
  const last = equity[equity.length - 1] ?? 0;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="equity" preserveAspectRatio="none">
      <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="rgba(255,255,255,0.2)" strokeDasharray="3 3" />
      <path d={d} fill="none" stroke={last >= 0 ? "#25fab0" : "#f43f5e"} strokeWidth={1.5} />
    </svg>
  );
}
