// ── Vektor Grid Engine ──
//
// Client-side NEUTRAL grid placed through POST /v2/orders/batch so every rung
// carries X-Builder-Fee-Bps (Strike's native /v2/grid/bot ignores builder fees
// and is arithmetic-only). Buys rest below the mark, sells above, and the
// level nearest the mark stays empty so the two sides never collide.
//
// Order roles are encoded in the client order ID:
//   entry (e)  BUY  fills at rung i → exit SELL at rung i+1 for the filled qty
//   entry (e)  SELL fills at rung i → exit BUY  at rung i−1
//   exit  (x)  fills → round trip done, PnL booked, the entry is re-armed
//   stop  (s)  bracket stop-loss leg of an entry (only with stopLossPct);
//              fills → loss booked, rung retired, its resting exit cancelled
// Counter orders always use the FILLED quantity, never the planned one.
//
// Funding-aware skew (skew.mode = "FUNDING"):
//   raw        = clamp(fundingRateHourly / SKEW_REF_RATE, −1, 1)   SKEW_REF_RATE = 0.00003/h
//   sellMult   = 1 + maxSkew × raw        buyMult = 1 − maxSkew × raw
//   k          = activeRungs / (nBuy × buyMult + nSell × sellMult)   (keeps Σ notional = margin × leverage)
//   size(rung) = base × mult(side) × k / price
// Positive funding → longs pay shorts → sell rungs get bigger, so the inventory
// the grid accumulates is SHORT and receives funding on top of the spread.

import type { CreateOrderRequest, CreateStrategyOrderRequest } from "../types/order";
import { fix, snapDown, snapUp, type FeeContext, type FillEvent, type MarketRules } from "./types";

export type GridMode = "ARITHMETIC" | "GEOMETRIC";

export interface GridSkew {
  mode: "NONE" | "FUNDING";
  fundingRateHourly?: number;
  maxSkew?: number; // default 0.5 → side multipliers in [0.5, 1.5]
}

export interface GridConfig {
  symbol: string;
  lowerPrice: number;
  upperPrice: number;
  markPrice: number;
  levels: number; // 4..60 price levels
  marginUsd: number;
  leverage: number;
  mode: GridMode;
  vaultId?: string; // trade a Strike vault the user leads: every order carries vault_id (see docs/VAULTS.md)
  skew?: GridSkew;
  stopLossPct?: number; // per-rung bracket SL, % away from the entry (0 / undefined = none)
}

export const SKEW_REF_RATE = 0.00003; // hourly rate at which the skew saturates
export const DEFAULT_MAX_SKEW = 0.5;

export type RungRole = "e" | "x" | "s";

export interface RestingOrder {
  acked?: boolean; // engine OPEN acknowledgement seen on the user stream
  clientOrderId: string;
  side: "BUY" | "SELL";
  role: RungRole;
  size: number;
  exitFor?: number; // x: index of the entry rung this exit closes
  stopFor?: string; // s: client id of the entry this SL protects
}

export interface GridRung {
  index: number;
  price: number;
  entrySide: "BUY" | "SELL" | "NONE"; // NONE = empty level nearest the mark
  plannedSize: number;
  notionalUsd: number;
  resting: RestingOrder[];
  cycles: number;
  realizedUsd: number;
  retired?: boolean; // stop-loss fired - never re-armed
}

export interface GridPlan {
  gridId: string;
  config: GridConfig;
  rungs: GridRung[];
  spacingPct: number; // step between adjacent rungs, % of price (avg for geometric)
  netCyclePct: number; // spacing − 2 maker fees − 2 builder fees, % of notional
  netCycleRoePct: number; // netCyclePct × leverage
  feeFloorPct: number; // maker + taker, Strike's "spacing must cover fees" floor
  totalNotionalUsd: number;
  skewApplied: number; // −1..1; > 0 favours SELL rungs (short inventory receives funding)
  expectedFundingUsdPerDay: number; // at full inventory on the receiving side
  warnings: string[];
}

export interface GridLogEntry { t: number; kind: "DEPLOY" | "FILL" | "EXIT" | "CYCLE" | "CANCEL" | "SKIP" | "STOP" | "ERROR"; msg: string }

export interface GridState {
  plan: GridPlan;
  rungs: GridRung[];
  inventory: number; // signed base units held by the grid (+ long)
  realizedUsd: number;
  feesUsd: number;
  builderFeesUsd: number;
  volumeUsd: number;
  fills: number;
  cycles: number;
  stops?: number; // stop-loss legs that fired
  log: GridLogEntry[];
  lastTradeId?: number; // highest /v2/history/fill trade_id applied (backfill cursor)
  deployedAt?: number;
  shifts?: number; // auto-shift (trailing) re-centres so far - see gridShift.ts
  shiftedAt?: number;
}

export const GRID_CID_PREFIX = "vektor-grid";

function skewFactors(skew: GridSkew | undefined): { raw: number; buyMult: number; sellMult: number } {
  if (!skew || skew.mode !== "FUNDING" || !skew.fundingRateHourly) return { raw: 0, buyMult: 1, sellMult: 1 };
  const maxSkew = skew.maxSkew ?? DEFAULT_MAX_SKEW;
  const raw = Math.max(-1, Math.min(1, skew.fundingRateHourly / SKEW_REF_RATE));
  return { raw, buyMult: 1 - maxSkew * raw, sellMult: 1 + maxSkew * raw };
}

/** Generate the rung ladder. Prices snap to tick (buy down, sell up), sizes to step. */
export function planGrid(config: GridConfig, rules: MarketRules, fees: FeeContext): GridPlan {
  const { lowerPrice, upperPrice, markPrice, levels, marginUsd, leverage, mode } = config;
  const warnings: string[] = [];
  if (!(lowerPrice > 0) || !(upperPrice > lowerPrice)) throw new Error("upper price must be above lower price");
  if (levels < 4 || levels > 60) throw new Error("levels must be between 4 and 60");
  if (config.stopLossPct !== undefined && config.stopLossPct < 0) throw new Error("stopLossPct must be ≥ 0");
  const inRange = markPrice > lowerPrice && markPrice < upperPrice;
  if (!inRange) warnings.push("Mark price is outside the range - only one side will be placed");

  const step = (upperPrice - lowerPrice) / (levels - 1);
  const ratio = Math.pow(upperPrice / lowerPrice, 1 / (levels - 1));
  const rawPrices = Array.from({ length: levels }, (_, i) =>
    mode === "ARITHMETIC" ? lowerPrice + i * step : lowerPrice * Math.pow(ratio, i)
  );

  let emptyIdx = -1;
  if (inRange) {
    let best = Infinity;
    rawPrices.forEach((p, i) => { const d = Math.abs(p - markPrice); if (d < best) { best = d; emptyIdx = i; } });
  }

  const sides = rawPrices.map((raw, i): GridRung["entrySide"] => (i === emptyIdx ? "NONE" : raw < markPrice ? "BUY" : "SELL"));
  const nBuy = sides.filter((s) => s === "BUY").length;
  const nSell = sides.filter((s) => s === "SELL").length;
  const { raw: skewApplied, buyMult, sellMult } = skewFactors(config.skew);
  // Unskewed: notional per rung = total / (levels − 1), one level empty. With skew,
  // k renormalises the side multipliers so Σ notional stays margin × leverage.
  const notionalPerRung = (marginUsd * leverage) / (levels - 1);
  const k = skewApplied === 0 ? 1 : (nBuy + nSell) / (nBuy * buyMult + nSell * sellMult);

  const rungs: GridRung[] = rawPrices.map((raw, i) => {
    const entrySide = sides[i];
    const price = fix(entrySide === "SELL" ? snapUp(raw, rules.tick) : snapDown(raw, rules.tick), rules.quotePrec);
    const mult = entrySide === "BUY" ? buyMult : entrySide === "SELL" ? sellMult : 1;
    const plannedSize = fix(snapDown((notionalPerRung * mult * k) / price, rules.stepSize), rules.basePrec);
    return { index: i, price, entrySide, plannedSize, notionalUsd: fix(price * plannedSize, 2), resting: [], cycles: 0, realizedUsd: 0 };
  });

  const active = rungs.filter((r) => r.entrySide !== "NONE");
  const tooSmall = active.filter((r) => r.plannedSize < rules.minSize || r.notionalUsd < rules.minNotional);
  if (tooSmall.length) warnings.push(`${tooSmall.length} rung(s) below min size / $${rules.minNotional} notional - raise margin or reduce levels`);

  const mid = (upperPrice + lowerPrice) / 2;
  const spacingPct = mode === "ARITHMETIC" ? (step / mid) * 100 : (ratio - 1) * 100;
  const feeFloorPct = (fees.makerRate + fees.takerRate) * 100;
  const netCyclePct = spacingPct - 2 * fees.makerRate * 100 - 2 * (fees.builderFeeBps / 100);
  if (netCyclePct <= 0) warnings.push("Spacing does not cover maker + builder fees - widen the range or reduce levels");
  if (config.stopLossPct && config.stopLossPct <= spacingPct) warnings.push("Stop-loss is inside one rung spacing - normal grid motion will trigger it");

  // Funding at full inventory on the receiving side: Σ notional(receiving rungs) × |rate| × 24.
  const rate = config.skew?.mode === "FUNDING" ? (config.skew.fundingRateHourly ?? 0) : 0;
  const receivingSide: GridRung["entrySide"] = rate >= 0 ? "SELL" : "BUY";
  const receivingNotional = rungs.filter((r) => r.entrySide === receivingSide).reduce((a, r) => a + r.notionalUsd, 0);
  const expectedFundingUsdPerDay = fix(receivingNotional * Math.abs(rate) * 24, 2);

  return {
    gridId: Date.now().toString(36), config, rungs,
    spacingPct: fix(spacingPct, 4), netCyclePct: fix(netCyclePct, 4), netCycleRoePct: fix(netCyclePct * leverage, 3),
    feeFloorPct: fix(feeFloorPct, 4), totalNotionalUsd: fix(active.reduce((a, r) => a + r.notionalUsd, 0), 2),
    skewApplied: fix(skewApplied, 4), expectedFundingUsdPerDay, warnings,
  };
}

export const rungClientId = (gridId: string, index: number, role: RungRole, seq: number) =>
  `${GRID_CID_PREFIX}-${gridId}-${index}-${role}-${seq}`;

export function parseRungClientId(cid: string): { gridId: string; index: number; role: RungRole; seq: number } | null {
  const m = /^vektor-grid-([a-z0-9]+)-(\d+)-([exs])-(\d+)$/.exec(cid);
  return m ? { gridId: m[1], index: Number(m[2]), role: m[3] as RungRole, seq: Number(m[4]) } : null;
}

function limitOrder(symbol: string, cid: string, side: "BUY" | "SELL", size: number, price: number, vaultId?: string): CreateOrderRequest {
  return { client_order_id: cid, symbol, side: side === "BUY" ? "buy" : "sell", type: "limit", size: String(size), price: String(price), time_in_force: "GTC", post_only: true, ...(vaultId ? { vault_id: vaultId } : {}) };
}

/** Stop price for an entry's bracket SL: buys stop below (snap down), sells stop above (snap up). */
export function stopPriceFor(entryPrice: number, side: "BUY" | "SELL", stopLossPct: number, rules: MarketRules): number {
  const raw = entryPrice * (side === "BUY" ? 1 - stopLossPct / 100 : 1 + stopLossPct / 100);
  return fix(side === "BUY" ? snapDown(raw, rules.tick) : snapUp(raw, rules.tick), rules.quotePrec);
}

/**
 * Entry + reduce-only stop leg for POST /v2/order/strategy (builder fee applies
 * to every leg). The SL client id is registered on the rung with role "s" so
 * its fill (or cancellation after the exit fills) can be matched later.
 */
function strategyFor(plan: GridPlan, rung: GridRung, side: "BUY" | "SELL", size: number, seq: number, rules: MarketRules): { req: CreateStrategyOrderRequest; entryCid: string; stopCid: string } {
  const entryCid = rungClientId(plan.gridId, rung.index, "e", seq);
  const stopCid = rungClientId(plan.gridId, rung.index, "s", seq);
  const stop = stopPriceFor(rung.price, side, plan.config.stopLossPct!, rules);
  return {
    entryCid, stopCid,
    req: {
      strategy_id: `${GRID_CID_PREFIX}-${plan.gridId}-${rung.index}-strat-${seq}`,
      client_order_id: entryCid, symbol: plan.config.symbol,
      side: side === "BUY" ? "buy" : "sell", type: "limit", size: String(size), price: String(rung.price), time_in_force: "GTC", post_only: true,
      ...(plan.config.vaultId ? { vault_id: plan.config.vaultId } : {}),
      sl_order: { client_order_id: stopCid, type: "stop", size: String(size), stop_price: String(stop), working_type: "mark_price" },
    },
  };
}

/** Initial deployment as plain post-only GTC limits (no brackets). */
export function buildDeployOrders(plan: GridPlan): { orders: CreateOrderRequest[]; rungs: GridRung[] } {
  const rungs = plan.rungs.map((r) => ({ ...r, resting: [] as RestingOrder[] }));
  const orders: CreateOrderRequest[] = [];
  for (const r of rungs) {
    if (r.entrySide === "NONE" || r.plannedSize <= 0) continue;
    const cid = rungClientId(plan.gridId, r.index, "e", 0);
    r.resting.push({ clientOrderId: cid, side: r.entrySide, role: "e", size: r.plannedSize });
    orders.push(limitOrder(plan.config.symbol, cid, r.entrySide, r.plannedSize, r.price, plan.config.vaultId));
  }
  return { orders, rungs };
}

/** Initial deployment as brackets (requires config.stopLossPct > 0): one strategy per entry rung. */
export function buildDeployStrategies(plan: GridPlan, rules: MarketRules): { strategies: CreateStrategyOrderRequest[]; rungs: GridRung[] } {
  if (!plan.config.stopLossPct) throw new Error("buildDeployStrategies needs config.stopLossPct > 0");
  const rungs = plan.rungs.map((r) => ({ ...r, resting: [] as RestingOrder[] }));
  const strategies: CreateStrategyOrderRequest[] = [];
  for (const r of rungs) {
    if (r.entrySide === "NONE" || r.plannedSize <= 0) continue;
    const s = strategyFor(plan, r, r.entrySide, r.plannedSize, 0, rules);
    r.resting.push({ clientOrderId: s.entryCid, side: r.entrySide, role: "e", size: r.plannedSize });
    r.resting.push({ clientOrderId: s.stopCid, side: r.entrySide === "BUY" ? "SELL" : "BUY", role: "s", size: r.plannedSize, stopFor: s.entryCid });
    strategies.push(s.req);
  }
  return { strategies, rungs };
}

/** Grid state after deployment. Pass `rules` when the plan has a stop-loss so rungs register their SL legs. */
export function initGridState(plan: GridPlan, now = Date.now(), rules?: MarketRules): GridState {
  const bracket = !!plan.config.stopLossPct && !!rules;
  const { rungs, count } = bracket
    ? (() => { const d = buildDeployStrategies(plan, rules!); return { rungs: d.rungs, count: d.strategies.length }; })()
    : (() => { const d = buildDeployOrders(plan); return { rungs: d.rungs, count: d.orders.length }; })();
  return {
    plan, rungs, inventory: 0, realizedUsd: 0, feesUsd: 0, builderFeesUsd: 0, volumeUsd: 0, fills: 0, cycles: 0, stops: 0, deployedAt: now,
    log: [{ t: now, kind: "DEPLOY", msg: `Deployed ${count} rungs on ${plan.config.symbol} (${plan.rungs[0]?.price}–${plan.rungs[plan.rungs.length - 1]?.price})${bracket ? ` with ${plan.config.stopLossPct}% stop-loss brackets` : ""}` }],
  };
}

export interface GridFillResult {
  state: GridState;
  orders: CreateOrderRequest[]; // plain limits to place (exits, and re-armed entries without brackets)
  strategies: CreateStrategyOrderRequest[]; // re-armed entries WITH brackets (needs `rules` passed to applyGridFill)
  cancel: string[]; // client ids to cancel (orphaned exits / stop legs)
}

/** Apply a fill / cancel event. Pass `rules` when the plan has a stop-loss so re-armed entries get brackets. */
export function applyGridFill(state: GridState, fill: FillEvent, now = Date.now(), rules?: MarketRules): GridFillResult {
  const none: GridFillResult = { state, orders: [], strategies: [], cancel: [] };
  const parsed = parseRungClientId(fill.clientOrderId);
  if (!parsed || parsed.gridId !== state.plan.gridId) return none;
  const rungs = state.rungs.map((r) => ({ ...r, resting: [...r.resting] }));
  const rung = rungs[parsed.index];
  if (!rung) return none;
  const symbol = state.plan.config.symbol;
  const log = [...state.log];
  const orders: CreateOrderRequest[] = [];
  const strategies: CreateStrategyOrderRequest[] = [];
  const cancel: string[] = [];
  const removeResting = (r: GridRung, cid: string) => { r.resting = r.resting.filter((o) => o.clientOrderId !== cid); };
  const bracket = !!state.plan.config.stopLossPct && !!rules;

  if (fill.status === "CANCELED" || fill.status === "REJECTED" || fill.status === "EXPIRED") {
    removeResting(rung, fill.clientOrderId);
    if (parsed.role === "e") {
      // an entry that never filled takes its unarmed stop leg with it
      const stop = rung.resting.find((o) => o.role === "s" && o.stopFor === fill.clientOrderId);
      if (stop) removeResting(rung, stop.clientOrderId);
    }
    log.push({ t: now, kind: "CANCEL", msg: `Rung ${rung.index} ${parsed.role === "s" ? "stop" : fill.side} ${fill.status.toLowerCase()}${fill.closeReason ? ` (${fill.closeReason})` : ""}` });
    return { state: { ...state, rungs, log: log.slice(-300) }, orders, strategies, cancel };
  }
  if (!(fill.fillQty > 0)) {
    // Engine acknowledgement of a resting order (OPEN, no fill yet): log it once so the user sees the rung is live.
    if (fill.status === "OPEN" && !rung.resting.find((o) => o.clientOrderId === fill.clientOrderId)?.acked) {
      const rungs2 = state.rungs.map((r) => ({ ...r, resting: r.resting.map((o) => (o.clientOrderId === fill.clientOrderId ? { ...o, acked: true } : o)) }));
      const entry: GridLogEntry = { t: now, kind: "DEPLOY", msg: `Rung ${rung.index} ${fill.side} resting @ ${rung.price} (engine ack)` };
      return { ...none, state: { ...state, rungs: rungs2, log: [...state.log, entry].slice(-300) } };
    }
    return none;
  }

  let { inventory, realizedUsd, cycles } = state;
  let stops = state.stops ?? 0;
  inventory += fill.side === "BUY" ? fill.fillQty : -fill.fillQty;
  const fullyFilled = fill.status === "FILLED" || fill.cumFilled >= fill.orderQty - 1e-12;
  if (fullyFilled) removeResting(rung, fill.clientOrderId);
  const accounting = {
    inventory: fix(inventory, 8),
    feesUsd: fix(state.feesUsd + fill.commission, 4), builderFeesUsd: fix(state.builderFeesUsd + fill.builderFee, 4),
    volumeUsd: fix(state.volumeUsd + fill.fillQty * fill.fillPrice, 2), fills: state.fills + 1,
  };

  // ── Stop-loss leg fired: book the loss, retire the rung, cancel its orphaned exit ──
  if (parsed.role === "s") {
    const entrySide: "BUY" | "SELL" = fill.side === "SELL" ? "BUY" : "SELL";
    const pnl = (entrySide === "BUY" ? fill.fillPrice - rung.price : rung.price - fill.fillPrice) * fill.fillQty;
    realizedUsd += pnl;
    stops += 1;
    rung.realizedUsd = fix(rung.realizedUsd + pnl, 4);
    rung.retired = true;
    for (const r of rungs) for (const o of r.resting) if (o.role === "x" && o.exitFor === rung.index) cancel.push(o.clientOrderId);
    for (const r of rungs) r.resting = r.resting.filter((o) => !cancel.includes(o.clientOrderId));
    log.push({ t: now, kind: "STOP", msg: `Stop-loss ${fill.side} ${fill.fillQty} @ ${fill.fillPrice} on rung ${rung.index}: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)} - rung retired${cancel.length ? `, ${cancel.length} exit(s) cancelled` : ""}` });
    return { state: { ...state, rungs, ...accounting, realizedUsd: fix(realizedUsd, 4), stops, log: log.slice(-300) }, orders, strategies, cancel };
  }

  log.push({ t: now, kind: parsed.role === "e" ? "FILL" : "EXIT", msg: `${parsed.role === "e" ? "Entry" : "Exit"} ${fill.side} ${fill.fillQty} @ ${fill.fillPrice} (rung ${rung.index})` });

  // Where the counter order goes and what role it has.
  let targetIdx: number;
  let counterRole: RungRole;
  const counterSide: "BUY" | "SELL" = fill.side === "BUY" ? "SELL" : "BUY";
  let exitFor: number | undefined;
  if (parsed.role === "e") {
    targetIdx = fill.side === "BUY" ? rung.index + 1 : rung.index - 1;
    counterRole = "x";
    exitFor = rung.index;
  } else {
    // Exit filled: book the round trip against the entry rung one step away, then re-arm the entry there.
    targetIdx = fill.side === "SELL" ? rung.index - 1 : rung.index + 1;
    counterRole = "e";
    const entryRung = rungs[targetIdx];
    if (entryRung) {
      const pnl = Math.abs(fill.fillPrice - entryRung.price) * fill.fillQty;
      realizedUsd += pnl;
      entryRung.cycles += 1;
      entryRung.realizedUsd = fix(entryRung.realizedUsd + pnl, 4);
      cycles += 1;
      log.push({ t: now, kind: "CYCLE", msg: `Round trip rung ${entryRung.index}→${rung.index}: +$${pnl.toFixed(4)}` });
      // The entry's stop leg is now orphaned (position closed) - cancel it.
      if (fullyFilled) {
        cancel.push(...entryRung.resting.filter((o) => o.role === "s").map((o) => o.clientOrderId));
        entryRung.resting = entryRung.resting.filter((o) => o.role !== "s");
      }
    }
  }

  const target = rungs[targetIdx];
  if (!target) {
    log.push({ t: now, kind: "SKIP", msg: `Rung ${rung.index} filled at the edge of the range - no counter rung` });
  } else if (target.retired && counterRole === "e") {
    log.push({ t: now, kind: "SKIP", msg: `Rung ${target.index} was stopped out - not re-arming` });
  } else if (target.resting.some((o) => o.side === counterSide && o.role !== "s")) {
    log.push({ t: now, kind: "SKIP", msg: `Rung ${target.index} already has a resting ${counterSide} - not stacking` });
  } else {
    const seq = now % 1_000_000;
    if (counterRole === "e" && bracket) {
      const s = strategyFor(state.plan, target, counterSide, fill.fillQty, seq, rules!);
      target.resting.push({ clientOrderId: s.entryCid, side: counterSide, role: "e", size: fill.fillQty });
      target.resting.push({ clientOrderId: s.stopCid, side: counterSide === "BUY" ? "SELL" : "BUY", role: "s", size: fill.fillQty, stopFor: s.entryCid });
      strategies.push(s.req);
    } else {
      const cid = rungClientId(state.plan.gridId, target.index, counterRole, seq);
      target.resting.push({ clientOrderId: cid, side: counterSide, role: counterRole, size: fill.fillQty, exitFor });
      orders.push(limitOrder(symbol, cid, counterSide, fill.fillQty, target.price, state.plan.config.vaultId));
    }
  }

  return {
    state: { ...state, rungs, ...accounting, realizedUsd: fix(realizedUsd, 4), cycles, stops, log: log.slice(-300) },
    orders, strategies, cancel,
  };
}

/** Client IDs of resting BUY entries/exits - what the Shield cancels (Rule A) to free margin. Stop legs are excluded. */
export function restingBuyIds(state: GridState): string[] {
  return state.rungs.flatMap((r) => r.resting.filter((o) => o.side === "BUY" && o.role !== "s").map((o) => o.clientOrderId));
}

export function restingIds(state: GridState): string[] {
  return state.rungs.flatMap((r) => r.resting.map((o) => o.clientOrderId));
}

/**
 * Rebuild after a reload: keep only resting orders that are actually on the
 * book (GET /v2/openOrders), drop the rest. An unarmed stop leg is not on the
 * book yet, so it is kept as long as its entry is. Fills that happened while
 * we were away are not replayed - inventory is re-read from /v2/positions by the UI.
 */
export function reconcileGrid(state: GridState, openClientIds: Set<string>, now = Date.now()): { state: GridState; kept: number; dropped: number } {
  let kept = 0, dropped = 0;
  const rungs = state.rungs.map((r) => {
    const entriesKept = new Set(r.resting.filter((o) => o.role === "e" && openClientIds.has(o.clientOrderId)).map((o) => o.clientOrderId));
    const resting = r.resting.filter((o) => {
      const ok = openClientIds.has(o.clientOrderId) || (o.role === "s" && !!o.stopFor && entriesKept.has(o.stopFor));
      ok ? kept++ : dropped++;
      return ok;
    });
    return { ...r, resting };
  });
  const entry: GridLogEntry = { t: now, kind: "DEPLOY", msg: `Reconciled from open orders: ${kept} resting kept, ${dropped} dropped` };
  return { state: { ...state, rungs, log: [...state.log, entry].slice(-300) }, kept, dropped };
}

/** Mark the given orders as no longer resting (after a cancel). */
export function dropResting(state: GridState, ids: string[], now = Date.now()): GridState {
  const set = new Set(ids);
  const rungs = state.rungs.map((r) => ({ ...r, resting: r.resting.filter((o) => !set.has(o.clientOrderId)) }));
  const entry: GridLogEntry = { t: now, kind: "CANCEL", msg: `Cancelled ${ids.length} resting order(s)` };
  return { ...state, rungs, log: [...state.log, entry].slice(-300) };
}


/**
 * Rebuild grid state from Vektor-tagged open orders when local memory is empty
 * (e.g. the page was reloaded before the grid was persisted). The plan is
 * reconstructed from the resting prices: levels = highest rung index + 1, rung
 * prices interpolated linearly between the known ones, margin ≈ Σ notional / leverage.
 * Counter orders then work exactly as for a grid deployed in this session.
 */
export function adoptGridsFromOpenOrders(
  orders: { ClientOrderId: string; Symbol: string; Side: string; Size: string; Price: string }[],
  rulesFor: (symbol: string) => MarketRules,
  fees: FeeContext,
  leverage = 3,
  now = Date.now()
): Record<string, GridState> {
  const byGrid = new Map<string, typeof orders>();
  for (const o of orders) {
    const p = parseRungClientId(o.ClientOrderId);
    if (!p) continue;
    const k = `${o.Symbol}|${p.gridId}`;
    byGrid.set(k, [...(byGrid.get(k) ?? []), o]);
  }
  const out: Record<string, GridState> = {};
  for (const [k, list] of byGrid) {
    const [symbol, gridId] = k.split("|");
    const rules = rulesFor(symbol);
    const parsed = list.map((o) => ({ o, p: parseRungClientId(o.ClientOrderId)!, price: parseFloat(o.Price), size: parseFloat(o.Size) }));
    const idxs = parsed.map((x) => x.p.index);
    const minI = Math.min(...idxs), maxI = Math.max(...idxs);
    const lo = parsed.find((x) => x.p.index === minI)!.price, hi = parsed.find((x) => x.p.index === maxI)!.price;
    const spacing = maxI > minI ? (hi - lo) / (maxI - minI) : lo * 0.01;
    const levels = Math.max(maxI + 2, 4); // leave room for one rung above the highest known
    const lowerPrice = fix(lo - minI * spacing, rules.quotePrec), upperPrice = fix(lowerPrice + (levels - 1) * spacing, rules.quotePrec);
    const markGuess = parsed.reduce((a, x) => a + x.price, 0) / parsed.length;
    const notional = parsed.reduce((a, x) => a + x.price * x.size, 0);
    const config: GridConfig = { symbol, lowerPrice: Math.max(rules.tick, lowerPrice), upperPrice, markPrice: markGuess, levels, marginUsd: fix(Math.max(1, (notional * levels) / Math.max(1, parsed.length) / leverage), 2), leverage, mode: "ARITHMETIC" };
    let plan: GridPlan;
    try { plan = planGrid(config, rules, fees); } catch { continue; }
    plan = { ...plan, gridId };
    const rungs = plan.rungs.map((r) => ({ ...r, resting: [] as RestingOrder[] }));
    for (const x of parsed) {
      const r = rungs[x.p.index]; if (!r) continue;
      r.price = fix(x.price, rules.quotePrec);
      r.resting.push({ clientOrderId: x.o.ClientOrderId, side: x.o.Side.toUpperCase() === "BUY" ? "BUY" : "SELL", role: x.p.role, size: x.size, acked: true });
    }
    out[symbol] = {
      plan, rungs, inventory: 0, realizedUsd: 0, feesUsd: 0, builderFeesUsd: 0, volumeUsd: 0, fills: 0, cycles: 0, deployedAt: now,
      log: [{ t: now, kind: "DEPLOY", msg: `Adopted ${parsed.length} resting rung(s) found on the book (grid ${gridId}); PnL counts from now` }],
    };
  }
  return out;
}
