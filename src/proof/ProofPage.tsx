import { useEffect, useMemo, useState } from "react";
import { curlFor, getPublicClosedPositions, getPublicFills, getPublicFunding, getPublicPositions, type PublicCall, type PublicSelector } from "../api/publicHistory";
import type { FillRow } from "../api/history";
import type { PositionResponse } from "../types/position";
import { formatCurrency, formatPrice } from "../math/formatUtils";
import { classify, parseProofQuery, summarize, type ProofSummary } from "./analytics";

/**
 * Read-only, unauthenticated proof of a Vektor account's activity, fetched in
 * the judge's own browser from Strike's public history selectors.
 */
export function ProofPage() {
  const q = useMemo(() => parseProofQuery(window.location.search), []);
  const [input, setInput] = useState(q.account ?? q.address ?? "");
  const [state, setState] = useState<{ loading: boolean; error?: string; fills: FillRow[]; summary?: ProofSummary; positions: PositionResponse[]; closed: number; calls: PublicCall[] }>({ loading: false, fills: [], positions: [], closed: 0, calls: [] });

  const selector: PublicSelector | null = q.account ? { account_id: q.account } : q.address ? { blockchain_address: q.address, blockchain: q.chain } : null;

  useEffect(() => {
    if (!selector) return;
    let cancelled = false;
    const calls: PublicCall[] = [];
    setState((s) => ({ ...s, loading: true, error: undefined, calls }));
    (async () => {
      try {
        const [fills, funding, positions, closed] = await Promise.all([
          getPublicFills(q.base, selector, calls),
          getPublicFunding(q.base, selector, calls).catch(() => []),
          getPublicPositions(q.base, selector, calls).catch(() => []),
          getPublicClosedPositions(q.base, selector, calls).catch(() => []),
        ]);
        if (cancelled) return;
        setState({ loading: false, fills, summary: summarize(fills, funding, q.bps), positions, closed: closed.length, calls });
      } catch (e: any) {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: e.message, calls }));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.account, q.address, q.chain, q.base, q.bps]);

  const go = () => {
    const v = input.trim();
    if (!v) return;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    const u = new URLSearchParams();
    u.set(isUuid ? "account" : "address", v);
    u.set("bps", String(q.bps));
    if (q.base.includes("testnet")) u.set("net", "testnet");
    window.location.search = `?${u.toString()}`;
  };

  const s = state.summary;
  const vektorFills = state.fills.filter((f) => classify(f.client_order_id) !== "other").sort((a, b) => b.timestamp - a.timestamp);

  return (
    <div className="proof">
      <header className="app-header vk-header">
        <div className="vk-brand"><h1>⚡ Vektor</h1><span className="mode-pill live">PUBLIC PROOF · {q.base.includes("testnet") ? "testnet" : "mainnet"}</span></div>
        <div className="vk-telemetry"><a className="btn" href="/app.html">Open terminal →</a></div>
      </header>

      <main className="main-content proof-main">
        <div className="panel">
          <h3>Verify a Vektor account</h3>
          <p className="text-secondary text-sm">Everything on this page is fetched by <em>your</em> browser from Strike's public history endpoints - no login, no Vektor server in between. Fills are attributed by their <code>client_order_id</code> prefix (<code>vektor-grid-</code>, <code>vektor-hedge-</code>, <code>vektor-shield-</code>). Builder fees are reconstructed with Strike's formula <code>floor(notional × {q.bps} bps / 10000, 2)</code>.</p>
          <div className="form-row" style={{ marginTop: 10 }}>
            <input className="proof-input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Strike account_id (UUID) or wallet address" onKeyDown={(e) => e.key === "Enter" && go()} />
            <button className="btn btn-primary" onClick={go}>Load</button>
          </div>
          {state.error && <div className="error" style={{ marginTop: 8 }}>{state.error}</div>}
          {state.loading && <p className="text-secondary text-sm" style={{ marginTop: 8 }}>Fetching from {q.base}…</p>}
        </div>

        {s && (
          <>
            <div className="panel">
              <h3>Summary {s.firstTs ? <span className="text-secondary">· {new Date(s.firstTs).toLocaleString()} → {new Date(s.lastTs!).toLocaleString()}</span> : null}</h3>
              <div className="stat-row">
                <Stat label="Vektor fills" value={`${s.vektorFills} / ${s.totalFills}`} />
                <Stat label="Round trips" value={String(s.roundTrips)} />
                <Stat label="Volume routed" value={formatCurrency(s.volumeUsd)} />
                <Stat label="Realized PnL" value={formatCurrency(s.realizedPnlUsd)} cls={s.realizedPnlUsd >= 0 ? "text-green" : "text-red"} />
                <Stat label="Commission" value={formatCurrency(s.commissionUsd)} />
                <Stat label={`Builder fees @ ${q.bps} bps`} value={formatCurrency(s.builderFeesUsd)} cls="text-green" />
                <Stat label="Funding received" value={`${formatCurrency(s.fundingUsd)} (${s.fundingPayments})`} cls={s.fundingUsd >= 0 ? "text-green" : "text-red"} />
                <Stat label="Open / closed positions" value={`${state.positions.length} / ${state.closed}`} />
              </div>
              <div className="text-xs text-secondary" style={{ marginTop: 8 }}>
                by source: grid {s.bySource.grid} · hedge {s.bySource.hedge} · shield {s.bySource.shield} · flatten {s.bySource.flatten} · non-Vektor {s.bySource.other}
              </div>
              {s.vektorFills === 0 && <p className="text-secondary" style={{ marginTop: 10 }}>No Vektor-tagged fills on this account yet.</p>}
            </div>

            {s.timeline.length > 1 && (
              <div className="panel">
                <h3>Cumulative volume, PnL and builder revenue</h3>
                <Timeline tl={s.timeline} />
              </div>
            )}

            {s.bySymbol.length > 0 && (
              <div className="panel">
                <h3>Per market</h3>
                <table className="mini wide">
                  <thead><tr><th>Market</th><th>Fills</th><th>Round trips</th><th>Volume</th><th>Realized</th><th>Commission</th><th>Builder fees</th><th>Grids</th></tr></thead>
                  <tbody>
                    {s.bySymbol.map((r) => (
                      <tr key={r.symbol}><td>{r.symbol}</td><td>{r.fills}</td><td>{r.roundTrips}</td><td>{formatCurrency(r.volumeUsd)}</td><td className={r.realizedPnlUsd >= 0 ? "text-green" : "text-red"}>{formatCurrency(r.realizedPnlUsd)}</td><td>{formatCurrency(r.feesUsd)}</td><td className="text-green">{formatCurrency(r.builderFeesUsd)}</td><td className="text-secondary">{r.gridIds.length}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {state.positions.length > 0 && (
              <div className="panel">
                <h3>Open positions (public read)</h3>
                <table className="mini wide">
                  <thead><tr><th>Market</th><th>Size</th><th>Entry</th><th>Leverage</th><th>uPnL</th><th>Liq.</th><th>Funding</th></tr></thead>
                  <tbody>
                    {state.positions.map((p) => { const sz = parseFloat(p.size); return (
                      <tr key={p.id}><td>{p.symbol}</td><td className={sz >= 0 ? "text-green" : "text-red"}>{sz >= 0 ? "LONG" : "SHORT"} {Math.abs(sz)}</td><td>{formatPrice(parseFloat(p.entry_price))}</td><td>{p.leverage}x</td><td className={parseFloat(p.upnl) >= 0 ? "text-green" : "text-red"}>{formatCurrency(parseFloat(p.upnl))}</td><td>{formatPrice(parseFloat(p.liquidation_price))}</td><td>{formatCurrency(parseFloat(p.accumulated_funding_fees))}</td></tr>
                    ); })}
                  </tbody>
                </table>
              </div>
            )}

            {vektorFills.length > 0 && (
              <div className="panel">
                <h3>Vektor fills (newest first, max 200 shown)</h3>
                <div className="table-container">
                  <table className="mini wide">
                    <thead><tr><th>Time</th><th>Market</th><th>Source</th><th>Side</th><th>Size</th><th>Price</th><th>Role</th><th>Realized</th><th>client_order_id</th></tr></thead>
                    <tbody>
                      {vektorFills.slice(0, 200).map((f) => (
                        <tr key={f.id}><td className="text-secondary">{new Date(f.timestamp).toLocaleString()}</td><td>{f.symbol}</td><td>{classify(f.client_order_id)}</td><td className={f.side === "buy" ? "text-green" : "text-red"}>{f.side}</td><td>{f.size}</td><td>{formatPrice(parseFloat(f.price))}</td><td>{f.role}</td><td>{formatCurrency(parseFloat(f.realized_pnl || "0"))}</td><td className="mono text-xs text-secondary">{f.client_order_id}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {state.calls.length > 0 && (
          <div className="panel">
            <h3>Verify yourself</h3>
            <p className="text-secondary text-sm">These are the exact requests this page made. Run them in a terminal; the JSON is what the numbers above are computed from.</p>
            <pre className="code-block proof-curl">{state.calls.map((c) => `${curlFor(c)}   # ${c.status}`).join("\n")}</pre>
          </div>
        )}
      </main>
    </div>
  );
}

const Stat = ({ label, value, cls = "" }: { label: string; value: string; cls?: string }) => (
  <div className="stat"><span className="label">{label}</span><span className={`value ${cls}`}>{value}</span></div>
);

function Timeline({ tl }: { tl: ProofSummary["timeline"] }) {
  const W = 800, H = 160, P = 6;
  const t0 = tl[0].t, t1 = tl[tl.length - 1].t || t0 + 1;
  const x = (t: number) => P + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * P);
  const series = (key: keyof ProofSummary["timeline"][number], color: string) => {
    const vals = tl.map((p) => p[key] as number);
    const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    const y = (v: number) => H - P - ((v - lo) / (hi - lo || 1)) * (H - 2 * P);
    const d = tl.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p[key] as number).toFixed(1)}`).join(" ");
    return <path d={d} fill="none" stroke={color} strokeWidth={1.5} />;
  };
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="equity" style={{ height: 160 }} preserveAspectRatio="none">
        {series("cumVolumeUsd", "rgba(255,255,255,0.35)")}
        {series("cumBuilderUsd", "#25fab0")}
        {series("cumPnlUsd", "#60a5fa")}
      </svg>
      <div className="text-xs text-secondary">white = volume · green = builder revenue · blue = realized PnL (each normalised to its own range)</div>
    </>
  );
}
