import { useMemo, useState } from "react";
import type { Vektor } from "../../hooks/useVektor";
import type { ConnectedWallet } from "../../api/wallets";
import { getSpotBalance, nativeAssetFor, type SpotBalance } from "../../api/spotBalance";
import { buildHedgePlan } from "../../quant/fundingHarvester";
import { formatCurrency, formatPrice } from "../../math/formatUtils";
import { Field, Row } from "./GridStudio";

export function FundingHarvester({ v, wallet }: { v: Vektor; wallet: ConnectedWallet | null }) {
  const [sel, setSel] = useState<string | null>(null);
  const [spotQty, setSpotQty] = useState(10_000);
  const [spot, setSpot] = useState<SpotBalance | null>(null);
  const [spotErr, setSpotErr] = useState<string | null>(null);
  const readWallet = async () => {
    if (!wallet) return;
    setSpotErr(null);
    try { const b = await getSpotBalance(wallet); setSpot(b); setSpotQty(Number(b.qty.toFixed(4))); } catch (e: any) { setSpotErr(e.message); }
  };
  const [leverage, setLeverage] = useState(2);
  const [slices, setSlices] = useState(4);
  const symbol = sel ?? v.fundingRanked[0]?.symbol ?? v.symbol;
  const opp = v.fundingRanked.find((o) => o.symbol === symbol);
  const snap = v.fundingSnapshots.find((s) => s.symbol === symbol);

  const plan = useMemo(() => {
    if (!opp || !snap) return null;
    return buildHedgePlan({ symbol, spotQty, markPrice: snap.markPrice, leverage, slices, market: v.markets[symbol] ?? null, rules: v.rulesFor(symbol), perpSide: opp.perpSide, fundingRateHourly: snap.fundingRateHourly });
  }, [opp, snap, symbol, spotQty, leverage, slices, v]);

  const h = v.hedge;
  const hedgePos = h ? v.positions.find((p) => p.symbol === h.plan.symbol) : undefined;

  return (
    <div className="quant-grid">
      <div className="panel ladder-panel" data-tour="funding">
        <h3>Funding APR radar (hourly funding × 24 × 365)</h3>
        <table className="mini wide">
          <thead><tr><th>Market</th><th>Mark</th><th>Funding / h</th><th>APR</th><th>Basis</th><th>Receiver</th><th>$ / day on $10k</th><th>Next</th></tr></thead>
          <tbody>
            {v.fundingRanked.map((o) => (
              <tr key={o.symbol} className={o.symbol === symbol ? "selected" : ""} onClick={() => setSel(o.symbol)}>
                <td>{o.symbol}</td>
                <td>{formatPrice(o.markPrice)}</td>
                <td className={o.fundingRateHourlyPct >= 0 ? "text-green" : "text-red"}>{o.fundingRateHourlyPct.toFixed(5)}%</td>
                <td><b>{o.annualizedAprPct.toFixed(2)}%</b></td>
                <td>{o.basisPct.toFixed(4)}%</td>
                <td><span className={o.perpSide === "SHORT" ? "badge-short" : "badge-long"}>{o.perpSide} perp</span></td>
                <td>{formatCurrency(o.dailyYieldPer10kUsd)}</td>
                <td className="text-secondary">{o.hoursToNextFunding}h</td>
              </tr>
            ))}
            {!v.fundingRanked.length && <tr><td colSpan={8} className="text-secondary">Waiting for mark prices…</td></tr>}
          </tbody>
        </table>
        <p className="text-xs text-secondary" style={{ marginTop: 8 }}>
          Positive funding: longs pay shorts every hour at HH:00 UTC. Holding {symbol.split("-")[0]} spot and shorting the perp 1:1 collects it with no price exposure (delta 0).
        </p>
      </div>

      <div className="panel">
        <h3>Delta-neutral hedge sizer - {symbol}</h3>
        <div className="form-row">
          <Field label={`Spot ${symbol.split("-")[0]} held`}>
            <input type="number" min={0} value={spotQty} onChange={(e) => setSpotQty(+e.target.value)} />
            {wallet && nativeAssetFor(wallet.chain) === symbol.split("-")[0] && (
              <button className="btn btn-secondary" style={{ marginTop: 6, width: "100%" }} onClick={readWallet}>Read {nativeAssetFor(wallet.chain)} balance from {wallet.walletId}</button>
            )}
            {spot && spot.asset === symbol.split("-")[0] && <span className="text-xs text-secondary">{spot.qty} {spot.asset} via {spot.source}</span>}
            {spotErr && <span className="error">{spotErr}</span>}
          </Field>
          <Field label="Perp leverage"><input type="number" min={1} max={5} value={leverage} onChange={(e) => setLeverage(+e.target.value)} /></Field>
          <Field label="Slices"><input type="number" min={1} max={20} value={slices} onChange={(e) => setSlices(+e.target.value)} /></Field>
        </div>
        {plan && (
          <div className="kv">
            <Row k="Perp leg" val={`${plan.side} ${plan.totalSize} (${formatCurrency(plan.notionalUsd)})`} />
            <Row k="Margin required" val={formatCurrency(plan.marginUsd)} />
            <Row k="Liquidation (margin tiers)" val={`${formatPrice(plan.liquidationPrice)} (${plan.liquidationDistancePct}% away)`} cls={plan.liquidationDistancePct < 20 ? "text-red" : ""} />
            <Row k="Funding / hour" val={formatCurrency(plan.hourlyFundingUsd)} cls="text-green" />
            <Row k="Funding / day" val={formatCurrency(plan.dailyFundingUsd)} cls="text-green" />
            <Row k="Funding / year" val={formatCurrency(plan.annualFundingUsd)} cls="text-green" />
            <Row k="Entry" val={`${plan.slices} × ${plan.sliceSize} IOC limits, builder fee attached (TWAP endpoint drops it)`} />
            {plan.warnings.map((w, i) => <div key={i} className="error">{w}</div>)}
          </div>
        )}
        <button className="btn btn-primary btn-submit" disabled={!plan || plan.totalSize <= 0 || (h?.status === "RUNNING")} onClick={() => plan && void v.launchHedge(plan)}>
          {h?.status === "RUNNING" ? `Placing slice ${h.placed}/${h.plan.slices}…` : "Launch delta-neutral hedge"}
        </button>
      </div>

      <div className="panel">
        <h3>Harvest tracker</h3>
        {!h ? <p className="text-secondary">No hedge running</p> : (
          <div className="kv">
            <Row k="Status" val={h.status} cls={h.status === "DONE" ? "text-green" : ""} />
            <Row k="Perp" val={`${h.plan.side} ${h.plan.totalSize} ${h.plan.symbol}`} />
            <Row k="Open position" val={hedgePos ? `${hedgePos.positionSide} ${hedgePos.size} @ ${formatPrice(hedgePos.entryPrice)}` : "-"} />
            <Row k="Perp uPnL" val={hedgePos?.uPnL != null ? formatCurrency(hedgePos.uPnL) : "-"} cls={(hedgePos?.uPnL ?? 0) >= 0 ? "text-green" : "text-red"} />
            <Row k={h.source === "history" ? `Funding collected (${h.payments} hourly payments)` : "Funding collected (simulated)"} val={formatCurrency(h.collectedUsd)} cls="text-green" />
            {hedgePos && <Row k="Position funding total (engine)" val={formatCurrency(hedgePos.accumulatedFundingFees)} cls={hedgePos.accumulatedFundingFees >= 0 ? "text-green" : "text-red"} />}
            <Row k="Rule C (flip guard)" val={`unwind after 3 adverse hours · last ${h.fundingHistory.slice(-3).map((r) => (r * 100).toFixed(4) + "%").join(" ") || "-"}`} />
            {(h.status === "DONE" || h.status === "RUNNING") && <button className="btn btn-danger btn-submit" onClick={() => void v.unwindHedge()}>Unwind hedge</button>}
          </div>
        )}
        {v.mode === "sim" && <p className="text-xs text-secondary" style={{ marginTop: 8 }}>Demo accrues funding at ~1 minute per tick so the tracker moves visibly.</p>}
      </div>
    </div>
  );
}
