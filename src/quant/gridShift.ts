// ── Auto-shift (trailing) grid ──
//
// A static grid stops earning the moment price leaves its range. Auto-shift
// re-centres the ladder on the current mark in ONE engine command
// (POST /v2/orders/replace: cancel every order on the symbol, then place the
// new ladder - builder fee honoured, never half-old/half-new).
//
// Decision rules (shouldShift):
//   1. Breakout  - mark > upper × (1 + h) or mark < lower × (1 − h), h = hysteresisPct (default 0.5%).
//                  The hysteresis stops a mark hovering at the boundary from thrashing.
//   2. Edge dwell - mark has sat in the outermost rung band (below rung[1] or above
//                  rung[levels−2]) for `edgeTicks` consecutive evaluations (default 20).
//                  Only one side of the grid is working there; re-centre early.
//   3. Cooldown  - never shift twice within `minIntervalMs` (default 60 s).
//   4. Never shift while a fill is mid-flight is the CALLER's job (debounce on fills).
//
// Shift geometry (buildShiftedPlan): the range keeps its original shape as a
// fraction of the mark it was deployed around (lower/mark0, upper/mark0), so a
// −6%/+6% grid stays −6%/+6% around the new mark. Levels, margin, leverage,
// mode and any extra config keys are carried unchanged.
//
// Inventory rule: inventory the old grid still holds (its exits were just
// cancelled with everything else) is NOT orphaned. It is spread over the new
// ladder's rungs on the exit side - a long is distributed across the SELL
// rungs above the mark nearest-first, a short across the BUY rungs below - as
// role "x" orders, so each fill books a round trip and re-arms the entry one
// rung away exactly like a normal exit. If the inventory is larger than those
// rungs' planned sizes, the outermost exit rung absorbs the remainder. Round-
// trip PnL on those exits is rung-based (vs the rung one step toward the
// mark), as everywhere else in the engine; the true cost basis of carried
// inventory is only known from /v2/positions.

import type { CreateOrderRequest } from "../types/order";
import { planGrid, rungClientId, type GridPlan, type GridRung, type GridState, type RestingOrder } from "./gridEngine";
import { fix, snapDown, type FeeContext, type MarketRules } from "./types";

export interface ShiftOpts {
  hysteresisPct?: number; // default 0.5
  edgeTicks?: number; // default 20
  minIntervalMs?: number; // default 60_000
}

export interface ShiftDecision {
  shift: boolean;
  reason: "BREAKOUT_UP" | "BREAKOUT_DOWN" | "EDGE_DWELL_HIGH" | "EDGE_DWELL_LOW" | "IN_RANGE" | "COOLDOWN" | "NO_MARK";
  edgeStreak: number; // pass back in as `prevEdgeStreak` on the next call
}

export function shouldShift(state: GridState, mark: number, opts: ShiftOpts = {}, prevEdgeStreak = 0, now = Date.now()): ShiftDecision {
  const h = (opts.hysteresisPct ?? 0.5) / 100;
  const edgeTicks = opts.edgeTicks ?? 20;
  const minInterval = opts.minIntervalMs ?? 60_000;
  if (!(mark > 0)) return { shift: false, reason: "NO_MARK", edgeStreak: 0 };
  const { lowerPrice, upperPrice } = state.plan.config;
  const rungs = state.rungs;
  const lowBand = rungs.length > 1 ? rungs[1].price : lowerPrice;
  const highBand = rungs.length > 1 ? rungs[rungs.length - 2].price : upperPrice;
  const inEdge = mark < lowBand || mark > highBand;
  const edgeStreak = inEdge ? prevEdgeStreak + 1 : 0;
  const cooling = state.shiftedAt !== undefined && now - state.shiftedAt < minInterval;

  let reason: ShiftDecision["reason"] = "IN_RANGE";
  if (mark > upperPrice * (1 + h)) reason = "BREAKOUT_UP";
  else if (mark < lowerPrice * (1 - h)) reason = "BREAKOUT_DOWN";
  else if (edgeStreak >= edgeTicks) reason = mark > highBand ? "EDGE_DWELL_HIGH" : "EDGE_DWELL_LOW";
  if (reason === "IN_RANGE") return { shift: false, reason, edgeStreak };
  if (cooling) return { shift: false, reason: "COOLDOWN", edgeStreak };
  return { shift: true, reason, edgeStreak };
}

export type OrderWithoutSymbol = Omit<CreateOrderRequest, "symbol">;

export interface ShiftResult {
  plan: GridPlan;
  newState: GridState;
  ordersWithoutSymbol: OrderWithoutSymbol[]; // body items for POST /v2/orders/replace
  exitsForInventory: number; // how many rungs were turned into inventory exits
}

export function buildShiftedPlan(state: GridState, mark: number, rules: MarketRules, fees: FeeContext, now = Date.now()): ShiftResult {
  const cfg = state.plan.config;
  const lowerFrac = cfg.lowerPrice / cfg.markPrice;
  const upperFrac = cfg.upperPrice / cfg.markPrice;
  const plan = planGrid({ ...cfg, lowerPrice: mark * lowerFrac, upperPrice: mark * upperFrac, markPrice: mark }, rules, fees);
  // planGrid derives gridId from Date.now(); a shift in the same millisecond would reuse the
  // old id and its client IDs. Suffix with the shift count so fills route to the new ladder only.
  const shifts = (state.shifts ?? 0) + 1;
  plan.gridId = `${plan.gridId}s${shifts.toString(36)}`;

  // Fresh rungs with entry orders (same as a deploy), then overlay inventory exits.
  const rungs: GridRung[] = plan.rungs.map((r) => ({ ...r, resting: [] as RestingOrder[] }));
  for (const r of rungs) {
    if (r.entrySide === "NONE" || r.plannedSize <= 0) continue;
    r.resting.push({ clientOrderId: rungClientId(plan.gridId, r.index, "e", 0), side: r.entrySide, role: "e", size: r.plannedSize });
  }

  let exitsForInventory = 0;
  let remaining = fix(Math.abs(state.inventory), rules.basePrec);
  if (remaining > 0) {
    const exitSide: "BUY" | "SELL" = state.inventory > 0 ? "SELL" : "BUY";
    // nearest-to-mark first on the exit side
    const candidates = rungs.filter((r) => r.entrySide === exitSide).sort((a, b) => (exitSide === "SELL" ? a.price - b.price : b.price - a.price));
    candidates.forEach((r, i) => {
      if (remaining <= 0) return;
      const last = i === candidates.length - 1;
      const size = fix(last ? remaining : Math.min(remaining, r.plannedSize), rules.basePrec);
      const snapped = fix(snapDown(size, rules.stepSize), rules.basePrec);
      if (snapped <= 0) return;
      r.resting = [{ clientOrderId: rungClientId(plan.gridId, r.index, "x", 0), side: exitSide, role: "x", size: snapped }];
      remaining = fix(remaining - snapped, rules.basePrec);
      exitsForInventory++;
    });
  }

  const ordersWithoutSymbol: OrderWithoutSymbol[] = rungs.flatMap((r) => r.resting.map((o) => ({
    client_order_id: o.clientOrderId, side: o.side === "BUY" ? "buy" as const : "sell" as const, type: "limit" as const,
    size: String(o.size), price: String(r.price), time_in_force: "GTC" as const, post_only: true,
  })));

  const newState: GridState = {
    ...state,
    plan,
    rungs,
    shifts,
    shiftedAt: now,
    log: [...state.log, { t: now, kind: "DEPLOY" as const, msg: `Auto-shift #${shifts}: re-centred on ${mark} → ${plan.config.lowerPrice}–${plan.config.upperPrice}${exitsForInventory ? ` (${exitsForInventory} rung(s) carry ${state.inventory} inventory as exits)` : ""}` }].slice(-300),
  };
  return { plan, newState, ordersWithoutSymbol, exitsForInventory };
}
