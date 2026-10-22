import { useMemo } from "react";
import type { L3Event, L3Signal } from "../../quant/l3Radar";
import { formatCurrency, formatPrice } from "../../math/formatUtils";

interface Props {
  signals: L3Signal[];
  events: L3Event[]; // timeline from the radar, oldest first
  mark: number;
  walls?: { side: "BID" | "ASK"; price: number; notional: number; ageMs: number; reliability: number | null }[];
  status?: { connected: boolean; synced: boolean; reason?: string; eventsPerSec?: number };
  windowMs?: number;
}

/**
 * Spoof & iceberg radar over Strike's L3 market-by-order feed. Timeline:
 * x = time (last `windowMs`), y = price; wall placements are bars that end at
 * the cancel (×) or fill (●). Pure props — mount anywhere.
 */
export function L3Radar({ signals, events, mark, walls = [], status, windowMs = 5 * 60_000 }: Props) {
  const W = 800, H = 220, PAD_R = 64, now = events.length ? Math.max(events[events.length - 1].t, Date.now() - 1000) : Date.now();
  const from = now - windowMs;

  const { lo, hi, spans, fills } = useMemo(() => {
    const vals = [mark, ...events.map((e) => e.price)].filter((v) => v > 0);
    const min = Math.min(...vals), max = Math.max(...vals);
    const pad = (max - min || max * 0.002) * 0.1;
    // Build wall spans: open → (cancel | last fill | now)
    const openAt = new Map<string, L3Event>();
    const spans: { side: "BID" | "ASK"; price: number; t0: number; t1: number; end: "cancel" | "fill" | "live"; notional: number }[] = [];
    const fills: L3Event[] = [];
    for (const e of events) {
      if (e.action === "open") openAt.set(e.orderId, e);
      else if (e.action === "cancel") { const o = openAt.get(e.orderId); if (o) { spans.push({ side: o.side, price: o.price, t0: o.t, t1: e.t, end: "cancel", notional: o.remainingSize * o.price }); openAt.delete(e.orderId); } }
      else if (e.action === "partial_fill" || e.action === "full_fill") {
        fills.push(e);
        const o = openAt.get(e.orderId);
        if (o && e.action === "full_fill") { spans.push({ side: o.side, price: o.price, t0: o.t, t1: e.t, end: "fill", notional: o.remainingSize * o.price }); openAt.delete(e.orderId); }
      }
    }
    for (const o of openAt.values()) spans.push({ side: o.side, price: o.price, t0: o.t, t1: now, end: "live", notional: o.remainingSize * o.price });
    return { lo: min - pad, hi: max + pad, spans, fills };
  }, [events, mark, now]);

  const x = (t: number) => Math.max(0, Math.min(W - PAD_R, ((t - from) / windowMs) * (W - PAD_R)));
  const y = (p: number) => 8 + (H - 16) * (1 - (p - lo) / (hi - lo || 1));
  const maxN = Math.max(1, ...spans.map((s) => s.notional));

  return (
    <div className="panel l3-panel">
      <div className="panel-header">
        <h3>L3 spoof &amp; iceberg radar</h3>
        <span className="text-xs text-secondary">
          {status ? (status.synced ? `synced · ${status.eventsPerSec ?? 0} ev/s` : status.connected ? "syncing…" : `offline${status.reason ? ` · ${status.reason}` : ""}`) : ""}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="l3-timeline" preserveAspectRatio="none">
        {spans.map((s, i) => {
          const c = s.side === "BID" ? "#25fab0" : "#f43f5e";
          const h = 1.5 + 4 * Math.sqrt(s.notional / maxN);
          return (
            <g key={i}>
              <rect x={x(s.t0)} y={y(s.price) - h / 2} width={Math.max(1, x(s.t1) - x(s.t0))} height={h} fill={c} opacity={s.end === "cancel" ? 0.45 : 0.85}>
                <title>{s.side} wall {formatCurrency(s.notional)} @ {formatPrice(s.price)} · {s.end}</title>
              </rect>
              {s.end === "cancel" && <text x={x(s.t1) + 1} y={y(s.price) + 3.5} fontSize={10} fill="#f59e0b" fontFamily="monospace">×</text>}
            </g>
          );
        })}
        {fills.map((f, i) => <circle key={i} cx={x(f.t)} cy={y(f.price)} r={2} fill="#fff" opacity={0.9} />)}
        {signals.map((s, i) => (
          <text key={`s${i}`} x={x(s.t) - 4} y={y(s.price) - 6} fontSize={9} fill={s.kind === "SPOOF" ? "#f59e0b" : "#60a5fa"} fontFamily="monospace" fontWeight={700}>{s.kind === "SPOOF" ? "SPOOF" : "ICE"}</text>
        ))}
        {mark > 0 && <line x1={0} x2={W - PAD_R} y1={y(mark)} y2={y(mark)} stroke="rgba(255,255,255,0.35)" strokeDasharray="3 3" />}
        <text x={W - PAD_R + 4} y={y(hi - (hi - lo) * 0.05) + 3} fontSize={9} fill="#888" fontFamily="monospace">{formatPrice(hi - (hi - lo) * 0.05)}</text>
        <text x={W - PAD_R + 4} y={y(lo + (hi - lo) * 0.05) + 3} fontSize={9} fill="#888" fontFamily="monospace">{formatPrice(lo + (hi - lo) * 0.05)}</text>
        {mark > 0 && <text x={W - PAD_R + 4} y={y(mark) + 3} fontSize={9} fill="#fff" fontFamily="monospace">{formatPrice(mark)}</text>}
        {!events.length && <text x={W / 2 - 90} y={H / 2} fontSize={11} fill="#666" fontFamily="monospace">{status?.connected ? "waiting for wall activity…" : "L3 feed offline"}</text>}
      </svg>
      <div className="l3-grid">
        <div>
          <div className="text-xs text-secondary" style={{ marginBottom: 4 }}>Signals (last {Math.round(windowMs / 60_000)} min)</div>
          <table className="mini">
            <thead><tr><th>Time</th><th>Kind</th><th>Side</th><th>Price</th><th>Notional</th><th>Evidence</th></tr></thead>
            <tbody>
              {signals.slice(0, 8).map((s, i) => (
                <tr key={i}>
                  <td className="text-secondary">{new Date(s.t).toLocaleTimeString()}</td>
                  <td className={s.kind === "SPOOF" ? "l3-spoof" : "l3-ice"}>{s.kind}</td>
                  <td className={s.side === "BID" ? "text-green" : "text-red"}>{s.side}</td>
                  <td>{formatPrice(s.price)}</td>
                  <td>{formatCurrency(s.notional)}</td>
                  <td className="text-secondary text-xs">{s.evidence}</td>
                </tr>
              ))}
              {!signals.length && <tr><td colSpan={6} className="text-secondary">Nothing suspicious yet</td></tr>}
            </tbody>
          </table>
        </div>
        <div>
          <div className="text-xs text-secondary" style={{ marginBottom: 4 }}>Resting walls · reliability = hit ÷ (hit + pulled near touch)</div>
          <table className="mini">
            <thead><tr><th>Side</th><th>Price</th><th>Notional</th><th>Age</th><th>Reliability</th></tr></thead>
            <tbody>
              {walls.slice(0, 8).map((w, i) => (
                <tr key={i}>
                  <td className={w.side === "BID" ? "text-green" : "text-red"}>{w.side}</td>
                  <td>{formatPrice(w.price)}</td>
                  <td>{formatCurrency(w.notional)}</td>
                  <td className="text-secondary">{Math.round(w.ageMs / 1000)}s</td>
                  <td className={w.reliability == null ? "text-secondary" : w.reliability < 0.4 ? "l3-spoof" : "text-green"}>{w.reliability == null ? "unknown" : `${Math.round(w.reliability * 100)}%`}</td>
                </tr>
              ))}
              {!walls.length && <tr><td colSpan={5} className="text-secondary">No walls resting</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-xs text-secondary">Wall = order ≥ 4× the average open notional. SPOOF = wall pulled within 15 s, untouched, after the mark came within 6 ticks. ICE = a level refilled 3+ times right after fills. Source: Strike public L3 feed (<code>/ws/l3</code>).</p>
    </div>
  );
}
