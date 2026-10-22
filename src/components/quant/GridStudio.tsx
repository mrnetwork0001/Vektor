import { useEffect, useMemo, useState } from "react";
import type { Vektor } from "../../hooks/useVektor";
import type { GridMode, GridPlan } from "../../quant/gridEngine";
import { analyzeDepth, slippageForSize } from "../../quant/whaleRadar";
import { formatCurrency, formatPrice } from "../../math/formatUtils";
import { GridLadder } from "./GridLadder";
import { BacktestCard } from "./BacktestCard";
import { HeadToHead } from "./HeadToHead";
import { DepthHeatmap } from "./DepthHeatmap";
import { useL3 } from "../../hooks/useL3";
import { L3Radar } from "./L3Radar";

import { API_BASE_URL } from "../../api/config";
const API_NET = /testnet/i.test(API_BASE_URL) ? "testnet" : "mainnet";

export function GridStudio({ v, accountId }: { v: Vektor; accountId?: string | null }) {
  const { mark, symbol } = v;
  const [lowerPct, setLowerPct] = useState(6);
  const [upperPct, setUpperPct] = useState(6);
  const [levels, setLevels] = useState(12);
  const [margin, setMargin] = useState(600);
  const [leverage, setLeverage] = useState(10);
  const [mode, setMode] = useState<GridMode>("GEOMETRIC");
  const [fundingSkew, setFundingSkew] = useState(false);
  const [maxSkew, setMaxSkew] = useState(0.5);
  const [stopLossPct, setStopLossPct] = useState(0);
  const [sizeProbe, setSizeProbe] = useState(1000);
  const [busy, setBusy] = useState(false);
  const [anchor, setAnchor] = useState(mark);
  const [view, setView] = useState<"ladder" | "heatmap">("ladder");

  // Freeze the range anchor so it doesn't drift with every tick while editing.
  useEffect(() => { if (!v.grid && (!anchor || Math.abs(mark / anchor - 1) > 0.03)) setAnchor(mark); }, [mark, anchor, v.grid]);
  useEffect(() => { setAnchor(mark); }, [symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  const lower = anchor * (1 - lowerPct / 100);
  const upper = anchor * (1 + upperPct / 100);
  const fundingRate = v.fundingSnapshots.find((s) => s.symbol === symbol)?.fundingRateHourly ?? 0;
  const cfg = useMemo(() => ({
    lowerPrice: lower, upperPrice: upper, levels, marginUsd: margin, leverage, mode,
    skew: fundingSkew ? { mode: "FUNDING" as const, fundingRateHourly: fundingRate, maxSkew } : undefined,
    stopLossPct: stopLossPct > 0 ? stopLossPct : undefined,
  }), [lower, upper, levels, margin, leverage, mode, fundingSkew, fundingRate, maxSkew, stopLossPct]);
  const preview = useMemo(() => v.previewGrid(cfg), [v, cfg]);
  const plan: GridPlan | null = "error" in preview ? null : preview;
  const err = "error" in preview ? preview.error : null;

  const depthInfo = useMemo(() => analyzeDepth(v.depth), [v.depth]);
  const slip = useMemo(() => slippageForSize(v.depth, "BUY", sizeProbe / (mark || 1), mark), [v.depth, sizeProbe, mark]);
  const pos = v.positions.find((p) => p.symbol === symbol);
  const g = v.grid;
  const l3 = useL3(symbol, v.rulesFor(symbol).tick, mark, v.mode === "live");
  const regimeRec = v.regime[symbol]?.recommendation;
  const paused = regimeRec?.action === "PAUSE";

  const deploy = async () => {
    setBusy(true);
    try { await v.deployGrid(cfg); } finally { setBusy(false); }
  };

  // "Prove it" preset: a tight micro-grid designed to fill within minutes on a liquid book
  // (±0.4% around the mark, $15 margin, 2x, 6 levels) so real fills + builder fees land fast.
  const proveIt = () => {
    setAnchor(mark); setLowerPct(0.4); setUpperPct(0.4); setLevels(6); setMargin(15); setLeverage(2); setMode("ARITHMETIC");
    setFundingSkew(false); setStopLossPct(0);
  };
  const proofSummary = () => {
    if (!g) return "";
    const lines = [
      `## Live proof — ${symbol} (${new Date().toISOString()})`,
      `- Builder code: vektor @ ${v.fees.builderFeeBps} bps · network: ${API_NET}`,
      `- Grid: ${formatPrice(g.plan.config.lowerPrice)}–${formatPrice(g.plan.config.upperPrice)} · ${g.plan.config.levels} levels · ${g.plan.config.leverage}x · ${g.plan.config.mode.toLowerCase()}`,
      `- Fills: ${g.fills} · round trips: ${g.cycles} · volume: ${formatCurrency(g.volumeUsd)} · realized: ${formatCurrency(g.realizedUsd)}`,
      `- Builder fees charged (from \`builder_fee\` on user-stream fills): ${formatCurrency(g.builderFeesUsd)}`,
      `- Verify: ${window.location.origin}/proof.html?account=${accountId ?? "<account_id>"}&bps=${v.fees.builderFeeBps}`,
    ];
    return lines.join("\n");
  };

  const applyRange = (s: { lower: number; upper: number; levels: number }) => {
    const a = mark || anchor;
    setAnchor(a);
    setLowerPct(Number(((1 - s.lower / a) * 100).toFixed(1)));
    setUpperPct(Number(((s.upper / a - 1) * 100).toFixed(1)));
    setLevels(s.levels);
  };

  return (
    <div className="quant-grid">
      <div className="panel ladder-panel">
        <div className="panel-header">
          <h3>CLOB Grid Studio — {symbol}</h3>
          <div className="panel-tools">
            <span className="text-secondary text-xs">
              {depthInfo ? `Book ${depthInfo.pressure.replace("_", " ")} · bids ${depthInfo.bidImbalancePct}% · spread ${depthInfo.spreadPct}%` : "waiting for depth…"}
            </span>
            <div className="side-toggle">
              <button className={`btn ${view === "ladder" ? "active" : ""}`} onClick={() => setView("ladder")}>Ladder</button>
              <button className={`btn ${view === "heatmap" ? "active" : ""}`} onClick={() => setView("heatmap")}>Liquidity heatmap</button>
            </div>
          </div>
        </div>
        {view === "ladder"
          ? <GridLadder history={v.history} mark={mark} plan={g ? null : plan} grid={g} liquidationPrice={pos?.liquidationPrice} walls={depthInfo?.walls} />
          : <DepthHeatmap frames={v.depthFrames} height={320} />}
        <div className="stat-row">
          <Stat label="Resting" value={g ? String(g.rungs.reduce((a, r) => a + r.resting.length, 0)) : "—"} />
          <Stat label="Fills" value={g ? String(g.fills) : "—"} />
          <Stat label="Round trips" value={g ? String(g.cycles) : "—"} />
          <Stat label="Grid PnL" value={g ? formatCurrency(g.realizedUsd) : "—"} cls={g && g.realizedUsd > 0 ? "text-green" : ""} />
          <Stat label="Inventory" value={g ? `${g.inventory}` : "—"} />
          <Stat label="Volume" value={g ? formatCurrency(g.volumeUsd) : "—"} />
          <Stat label="Builder fees" value={g ? formatCurrency(g.builderFeesUsd) : "—"} cls="text-green" />
          <Stat label="Shifts" value={g ? String(g.shifts ?? 0) : "—"} />
          <Stat label="Stops hit" value={g ? String(g.stops ?? 0) : "—"} cls={g && (g.stops ?? 0) > 0 ? "text-red" : ""} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h3>{g ? "Running grid" : "Design grid"}</h3>
          {!g && v.mode === "live" && <button className="btn btn-secondary" onClick={proveIt} title="±0.4%, $15, 2x, 6 levels — fills within minutes on a liquid book">Prove-it preset</button>}
          {g && v.mode === "live" && <button className="btn btn-secondary" onClick={() => navigator.clipboard?.writeText(proofSummary())} title="Copy a markdown summary of this live grid for the README / submission">Copy proof summary</button>}
        </div>
        {!g && (
          <>
            <div className="form-row">
              <Field label={`Lower −${lowerPct}%`}><input type="range" min={1} max={25} step={0.5} value={lowerPct} onChange={(e) => setLowerPct(+e.target.value)} /></Field>
              <Field label={`Upper +${upperPct}%`}><input type="range" min={1} max={25} step={0.5} value={upperPct} onChange={(e) => setUpperPct(+e.target.value)} /></Field>
            </div>
            <div className="form-row">
              <Field label="Levels"><input type="number" min={4} max={60} value={levels} onChange={(e) => setLevels(+e.target.value)} /></Field>
              <Field label="Margin (USD)"><input type="number" min={10} value={margin} onChange={(e) => setMargin(+e.target.value)} /></Field>
              <Field label="Leverage"><input type="number" min={1} max={20} value={leverage} onChange={(e) => setLeverage(+e.target.value)} /></Field>
            </div>
            <div className="side-toggle" style={{ marginBottom: 10 }}>
              {(["GEOMETRIC", "ARITHMETIC"] as GridMode[]).map((m) => (
                <button key={m} className={`btn ${mode === m ? "active" : ""}`} onClick={() => setMode(m)}>{m.toLowerCase()}</button>
              ))}
            </div>
            <div className="checkbox-row">
              <input id="skew" type="checkbox" checked={fundingSkew} onChange={(e) => setFundingSkew(e.target.checked)} />
              <label htmlFor="skew">Funding skew — tilt sizes so inventory sits on the side that <b>receives</b> funding ({(fundingRate * 100).toFixed(4)}%/h now)</label>
            </div>
            {fundingSkew && <Field label={`Max skew ×${(1 + maxSkew).toFixed(2)} / ×${(1 - maxSkew).toFixed(2)}`}><input type="range" min={0.1} max={1} step={0.05} value={maxSkew} onChange={(e) => setMaxSkew(+e.target.value)} /></Field>}
            <Field label={stopLossPct > 0 ? `Per-rung stop-loss ${stopLossPct}% (bracket via /v2/order/strategy, builder fee on both legs)` : "Per-rung stop-loss: off"}>
              <input type="range" min={0} max={10} step={0.5} value={stopLossPct} onChange={(e) => setStopLossPct(+e.target.value)} />
            </Field>
            {plan && (
              <div className="kv">
                <Row k="Range" val={`${formatPrice(lower)} – ${formatPrice(upper)}`} />
                {fundingSkew && <Row k="Skew applied" val={`${plan.skewApplied > 0 ? "+" : ""}${plan.skewApplied.toFixed(2)} (${plan.skewApplied > 0 ? "sell" : plan.skewApplied < 0 ? "buy" : "no"} side larger) · est. ${formatCurrency(plan.expectedFundingUsdPerDay)}/day funding at full inventory`} cls="text-green" />}
                <Row k="Spacing" val={`${plan.spacingPct}% / rung`} />
                <Row k="Net per round trip" val={`${plan.netCyclePct}% (${plan.netCycleRoePct}% on margin)`} cls={plan.netCyclePct > 0 ? "text-green" : "text-red"} />
                <Row k="Fee floor (maker+taker)" val={`${plan.feeFloorPct}%`} />
                <Row k="Builder fee" val={`${v.fees.builderFeeBps} bps on every fill`} />
                <Row k="Total notional" val={formatCurrency(plan.totalNotionalUsd)} />
                {plan.warnings.map((w, i) => <div key={i} className="error">{w}</div>)}
              </div>
            )}
            {err && <div className="error">{err}</div>}
            {regimeRec && regimeRec.action !== "RUN" && (
              <div className={paused ? "error" : "text-xs"} style={{ color: paused ? undefined : "var(--amber)", marginBottom: 6 }}>
                Regime guard: {paused ? "EXTREME — deploy paused" : `ELEVATED — range will be widened ×${regimeRec.widenFactor}`}. {v.regime[symbol]?.reasons.join("; ")}
              </div>
            )}
            <button className="btn btn-primary btn-submit" disabled={!plan || busy || !mark || paused} onClick={deploy} title={paused ? v.regime[symbol]?.reasons.join("; ") : undefined}>
              {busy ? "Placing…" : paused ? "Paused by regime guard" : `Deploy ${plan ? plan.rungs.filter((r) => r.entrySide !== "NONE").length : ""} rungs via /v2/orders/batch`}
            </button>
            {v.mode === "live" && <p className="text-xs text-secondary" style={{ marginTop: 6 }}>Live mode places real post-only orders on {symbol}. Counter orders fire from user-stream fills while this tab is open; the grid is saved locally and reconciled against open orders after a reload.</p>}
          </>
        )}
        {g && (
          <>
            <div className="kv">
              <Row k="Range" val={`${formatPrice(g.plan.config.lowerPrice)} – ${formatPrice(g.plan.config.upperPrice)}`} />
              <Row k="Mode" val={`${g.plan.config.mode.toLowerCase()} · ${g.plan.config.levels} levels · ${g.plan.config.leverage}x`} />
              <Row k="Net per round trip" val={`${g.plan.netCyclePct}%`} />
              <Row k="Fees paid" val={`${formatCurrency(g.feesUsd)} + ${formatCurrency(g.builderFeesUsd)} builder`} />
            </div>
            <div className="checkbox-row">
              <input id="autoshift" type="checkbox" checked={!!v.autoShift[symbol]} onChange={(e) => v.setAutoShift(symbol, e.target.checked)} />
              <label htmlFor="autoshift">Auto-shift (trailing) — re-centre via one /v2/orders/replace when price leaves the range{v.mode === "live" ? " (wipes every order on this symbol, incl. a native bot)" : ""}</label>
            </div>
            {(v.heldOrders[symbol]?.length ?? 0) > 0 && <div className="error">Regime PAUSE: {v.heldOrders[symbol].length} counter order(s) held until conditions calm</div>}
            <button className="btn btn-danger btn-submit" onClick={() => void v.stopGrid()}>Stop grid & cancel rungs</button>
            <div className="log">
              {[...g.log].reverse().slice(0, 14).map((l, i) => (
                <div key={i} className={`log-line log-${l.kind.toLowerCase()}`}><span className="text-secondary">{new Date(l.t).toLocaleTimeString()}</span> {l.msg}</div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="panel">
        <h3>Whale radar & impact</h3>
        {depthInfo ? (
          <>
            <div className="imbalance"><div style={{ width: `${depthInfo.bidImbalancePct}%` }} /></div>
            <div className="kv">
              <Row k="Bid depth (top 20)" val={formatCurrency(depthInfo.bidNotionalUsd)} cls="text-green" />
              <Row k="Ask depth (top 20)" val={formatCurrency(depthInfo.askNotionalUsd)} cls="text-red" />
            </div>
            <table className="mini">
              <thead><tr><th>Wall</th><th>Price</th><th>Notional</th><th>× avg</th></tr></thead>
              <tbody>
                {depthInfo.walls.map((w, i) => (
                  <tr key={i}><td className={w.side === "BID" ? "text-green" : "text-red"}>{w.side}</td><td>{formatPrice(w.price)}</td><td>{formatCurrency(w.notionalUsd)}</td><td>{w.multipleOfAvg}×</td></tr>
                ))}
                {!depthInfo.walls.length && <tr><td colSpan={4} className="text-secondary">No walls above 2.5× average</td></tr>}
              </tbody>
            </table>
            <Field label={`Market buy of ${formatCurrency(sizeProbe)} → slippage`}>
              <input type="range" min={100} max={50000} step={100} value={sizeProbe} onChange={(e) => setSizeProbe(+e.target.value)} />
            </Field>
            <div className="kv"><Row k="VWAP" val={slip ? `${formatPrice(slip.vwap)} (${slip.slippagePct > 0 ? "+" : ""}${slip.slippagePct}%)` : "book too thin"} /></div>
          </>
        ) : <p className="text-secondary">No order book yet</p>}
      </div>

      <BacktestCard v={v} cfg={cfg} onApplyRange={applyRange} />
      <HeadToHead v={v} cfg={cfg} />
      <L3Radar signals={l3.signals} events={l3.events} walls={l3.walls} mark={mark} status={{ connected: l3.connected, synced: l3.synced, reason: l3.reason, eventsPerSec: l3.eventsPerSec }} />
    </div>
  );
}

export const Stat = ({ label, value, cls = "" }: { label: string; value: string; cls?: string }) => (
  <div className="stat"><span className="label">{label}</span><span className={`value ${cls}`}>{value}</span></div>
);
export const Row = ({ k, val, cls = "" }: { k: string; val: string; cls?: string }) => (
  <div className="connected-row"><span className="text-secondary">{k}</span><span className={`text-sm ${cls}`}>{val}</span></div>
);
export const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="form-group"><label>{label}</label>{children}</div>
);
