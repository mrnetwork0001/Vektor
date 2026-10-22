// ── Backfill from history ──
//
// After a reload (or in the headless worker on start) the fills that happened
// while we were away are replayed from GET /v2/history/fill so grid PnL,
// cycles and builder telemetry are real numbers, not "since the tab opened".
// Builder fees are not itemised on fill rows, so they are reconstructed with
// Strike's own formula: floor(notional × bps / 10000, 2 decimals).

import type { FillRow, FundingRow } from "../api/history";
import { applyGridFill, parseRungClientId, type GridState } from "./gridEngine";
import type { CreateOrderRequest } from "../types/order";
import type { FillEvent, MarketRules } from "./types";
import { fix } from "./types";

export const builderFeeFor = (notional: number, bps: number) => Math.floor(((notional * bps) / 10000) * 100) / 100;

export function fillRowToEvent(r: FillRow, builderFeeBps: number): FillEvent {
  const size = parseFloat(r.size), price = parseFloat(r.price);
  return {
    symbol: r.symbol, clientOrderId: r.client_order_id ?? "", orderId: r.order_id,
    side: r.side === "buy" ? "BUY" : "SELL", fillQty: size, fillPrice: price,
    cumFilled: size, orderQty: size, // history rows don't carry the order size; reconcile fixes resting state afterwards
    isMaker: r.role === "maker", commission: r.fee_type === "commission" ? parseFloat(r.fee) : 0,
    builderFee: builderFeeFor(size * price, builderFeeBps), timestamp: r.timestamp, status: "FILLED",
  };
}

/**
 * Replay fills newer than `state.lastTradeId` that belong to this grid.
 * Returns the new state and the counter orders the grid would have placed -
 * the caller decides whether to place them (worker: yes; UI after reload:
 * only if the counter is not already resting per reconcile).
 */
export function backfillGrid(state: GridState, fills: FillRow[], builderFeeBps: number, rules?: MarketRules): { state: GridState; orders: CreateOrderRequest[]; replayed: number } {
  const mine = fills
    .filter((f) => f.client_order_id && parseRungClientId(f.client_order_id)?.gridId === state.plan.gridId)
    .filter((f) => f.trade_id > (state.lastTradeId ?? 0))
    .sort((a, b) => a.trade_id - b.trade_id);
  let s = state;
  const orders: CreateOrderRequest[] = [];
  for (const f of mine) {
    const r = applyGridFill(s, fillRowToEvent(f, builderFeeBps), f.timestamp, rules);
    s = { ...r.state, lastTradeId: f.trade_id };
    orders.push(...r.orders);
  }
  if (mine.length) s = { ...s, log: [...s.log, { t: Date.now(), kind: "DEPLOY" as const, msg: `Backfilled ${mine.length} fill(s) from history` }].slice(-300) };
  return { state: s, orders, replayed: mine.length };
}

export interface TelemetryTotals { volumeUsd: number; builderFeesUsd: number; commissionUsd: number; fills: number }

/** Totals over every Vektor-tagged fill (grid, hedge, shield). */
export function telemetryFromFills(fills: FillRow[], builderFeeBps: number, prefix = "vektor-"): TelemetryTotals {
  const t: TelemetryTotals = { volumeUsd: 0, builderFeesUsd: 0, commissionUsd: 0, fills: 0 };
  for (const f of fills) {
    if (!f.client_order_id?.startsWith(prefix)) continue;
    const n = parseFloat(f.size) * parseFloat(f.price);
    t.fills += 1; t.volumeUsd += n; t.builderFeesUsd += builderFeeFor(n, builderFeeBps);
    if (f.fee_type === "commission") t.commissionUsd += parseFloat(f.fee);
  }
  return { volumeUsd: fix(t.volumeUsd, 2), builderFeesUsd: fix(t.builderFeesUsd, 2), commissionUsd: fix(t.commissionUsd, 4), fills: t.fills };
}

/** Net funding received on a symbol since `sinceMs` (positive = received). */
export function fundingCollected(rows: FundingRow[], symbol: string, sinceMs: number): { usd: number; payments: number; rates: number[] } {
  const mine = rows.filter((r) => r.symbol === symbol && r.timestamp >= sinceMs).sort((a, b) => a.timestamp - b.timestamp);
  return { usd: fix(mine.reduce((a, r) => a + parseFloat(r.amount), 0), 4), payments: mine.length, rates: mine.map((r) => parseFloat(r.funding_rate)) };
}
