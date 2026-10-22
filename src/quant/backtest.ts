// ── Grid backtester ──
//
// Replays candles through the SAME SimExchange + gridEngine that demo mode
// uses, so the backtest and the live grid share one code path. Each candle
// is walked open → low/high (in the direction of the close) → close so every
// rung the wick touched gets filled.

import { SimExchange } from "../sim/simExchange";
import { applyGridFill, initGridState, planGrid, type GridConfig, type GridState } from "./gridEngine";
import type { FeeContext, FillEvent, MarketRules } from "./types";
import { fix } from "./types";

export interface Candle { t: number; o: number; h: number; l: number; c: number }

export interface BacktestResult {
  candles: number;
  from: number;
  to: number;
  cycles: number;
  fills: number;
  realizedUsd: number; // closed round trips
  inventoryPnlUsd: number; // mark-to-market of what the grid still holds at the end
  feesUsd: number;
  builderFeesUsd: number;
  netUsd: number; // realized + inventory − fees − builder fees
  netPctOnMargin: number;
  annualizedPct: number;
  maxDrawdownUsd: number;
  timeInRangePct: number;
  volumeUsd: number;
  equity: number[]; // per candle, net equity
  final: GridState;
}

/** Parse rows from GET /price/v2/klines: [openTime, open, high, low, close, ...]. */
export function parseKlines(rows: (string | number)[][]): Candle[] {
  return rows.map((r) => ({ t: Number(r[0]), o: parseFloat(String(r[1])), h: parseFloat(String(r[2])), l: parseFloat(String(r[3])), c: parseFloat(String(r[4])) }))
    .filter((c) => c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0);
}

export function runGridBacktest(cfg: Omit<GridConfig, "markPrice">, candles: Candle[], rules: MarketRules, fees: FeeContext): BacktestResult {
  if (candles.length < 2) throw new Error("not enough candles");
  const start = candles[0].o;
  const plan = planGrid({ ...cfg, markPrice: start }, rules, fees);
  const ex = new SimExchange(fees, {}, 1e9);
  ex.setLeverage(cfg.leverage);
  ex.setMark(cfg.symbol, start);

  let state = initGridState(plan, candles[0].t);
  const queue: FillEvent[] = [];
  ex.onFill((f) => queue.push(f));
  const drain = () => {
    while (queue.length) {
      const f = queue.shift()!;
      const r = applyGridFill(state, f, f.timestamp);
      state = r.state;
      if (r.orders.length) void ex.placeBatch(r.orders); // SimExchange resolves synchronously
    }
  };
  void ex.placeBatch(state.rungs.flatMap((r) => r.resting.map((o) => ({
    client_order_id: o.clientOrderId, symbol: cfg.symbol, side: o.side === "BUY" ? "buy" as const : "sell" as const,
    type: "limit" as const, size: String(o.size), price: String(r.price), time_in_force: "GTC" as const, post_only: true,
  }))));
  drain();

  const equity: number[] = [];
  let peak = -Infinity, maxDd = 0, inRange = 0;
  for (const k of candles) {
    const path = k.c >= k.o ? [k.o, k.l, k.h, k.c] : [k.o, k.h, k.l, k.c];
    for (const p of path) { ex.setMark(cfg.symbol, p); drain(); }
    if (k.c >= cfg.lowerPrice && k.c <= cfg.upperPrice) inRange++;
    const pos = ex.snapshot().positions[0];
    const mtm = pos ? (pos.uPnL ?? 0) : 0;
    const eq = state.realizedUsd + mtm - state.feesUsd - state.builderFeesUsd;
    equity.push(fix(eq, 4));
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }

  const last = candles[candles.length - 1];
  const pos = ex.snapshot().positions[0];
  const inventoryPnlUsd = pos ? (pos.uPnL ?? 0) : 0;
  const netUsd = state.realizedUsd + inventoryPnlUsd - state.feesUsd - state.builderFeesUsd;
  const days = Math.max(1 / 24, (last.t - candles[0].t) / 86_400_000);
  const netPct = (netUsd / cfg.marginUsd) * 100;
  return {
    candles: candles.length, from: candles[0].t, to: last.t,
    cycles: state.cycles, fills: state.fills,
    realizedUsd: fix(state.realizedUsd, 2), inventoryPnlUsd: fix(inventoryPnlUsd, 2),
    feesUsd: fix(state.feesUsd, 2), builderFeesUsd: fix(state.builderFeesUsd, 2),
    netUsd: fix(netUsd, 2), netPctOnMargin: fix(netPct, 2), annualizedPct: fix((netPct / days) * 365, 1),
    maxDrawdownUsd: fix(maxDd, 2), timeInRangePct: fix((inRange / candles.length) * 100, 1),
    volumeUsd: fix(state.volumeUsd, 0), equity, final: state,
  };
}
