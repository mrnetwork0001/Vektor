// ── Aegis Liquidation Shield ──
//
// Watches enriched positions (liquidation price from src/math, margin tiers
// from GET /v2/markets) and escalates:
//   Rule A  buffer < warnPct     → cancel resting BUY grid rungs (frees margin)
//   Rule B  buffer < criticalPct → reduce-only market trim of trimFraction
// A per-symbol cooldown and a pending-trim flag stop the shield from firing a
// trim on every mark tick while the position is still under the threshold.

import type { Position } from "../types/position";
import type { CreateOrderRequest } from "../types/order";
import { fix, snapDown, type MarketRules } from "./types";

export interface ShieldRules {
  enabled: boolean;
  warnPct: number; // default 8
  criticalPct: number; // default 5
  trimFraction: number; // default 0.25
  cooldownMs: number; // default 15s
  ruleA: boolean;
  ruleB: boolean;
}

export const DEFAULT_SHIELD_RULES: ShieldRules = {
  enabled: true, warnPct: 8, criticalPct: 5, trimFraction: 0.25, cooldownMs: 15_000, ruleA: true, ruleB: true,
};

export type Health = "SAFE" | "WARNING" | "CRITICAL" | "NO_LIQ";

export interface PositionHealth {
  symbol: string;
  side: "LONG" | "SHORT";
  size: number;
  markPrice: number;
  liquidationPrice: number;
  distanceToLiqPct: number;
  marginRatioPct: number;
  health: Health;
}

export type ShieldAction =
  | { kind: "CANCEL_BUYS"; symbol: string }
  | { kind: "TRIM"; symbol: string; order: CreateOrderRequest; qty: number }
  | { kind: "FLATTEN"; symbol: string; order: CreateOrderRequest };

export interface ShieldLogEntry { t: number; symbol: string; msg: string; level: "info" | "warn" | "crit" }

export interface ShieldState {
  rules: ShieldRules;
  lastActionAt: Record<string, number>; // symbol → ms of the last TRIM (cooldown)
  pendingTrim: Record<string, string | undefined>; // symbol → client_order_id awaiting fill
  cancelledBuysFor: Record<string, boolean>; // symbol → Rule A already fired this episode
  log: ShieldLogEntry[];
}

export const initShieldState = (rules: ShieldRules = DEFAULT_SHIELD_RULES): ShieldState => ({
  rules, lastActionAt: {}, pendingTrim: {}, cancelledBuysFor: {}, log: [],
});

export function assessPosition(pos: Position, rules: ShieldRules): PositionHealth {
  const mark = pos.markPrice ?? 0;
  const liq = pos.liquidationPrice ?? 0;
  const base = { symbol: pos.symbol, side: pos.positionSide, size: pos.size, markPrice: mark, liquidationPrice: liq, marginRatioPct: fix(pos.marginRatio ?? 0, 2) };
  if (!liq || !mark || pos.size <= 0) return { ...base, distanceToLiqPct: 100, health: "NO_LIQ" };
  const dist = pos.positionSide === "LONG" ? ((mark - liq) / mark) * 100 : ((liq - mark) / mark) * 100;
  const d = fix(Math.max(0, dist), 2);
  const health: Health = d <= rules.criticalPct ? "CRITICAL" : d <= rules.warnPct ? "WARNING" : "SAFE";
  return { ...base, distanceToLiqPct: d, health };
}

/**
 * Evaluate every position. Returns the actions to execute now plus the new
 * shield state. `hasRestingBuys(symbol)` lets Rule A skip when there is nothing to cancel.
 */
export function evaluateShield(
  state: ShieldState,
  positions: Position[],
  rulesBySymbol: Record<string, MarketRules>,
  hasRestingBuys: (symbol: string) => boolean,
  now = Date.now()
): { state: ShieldState; actions: ShieldAction[]; healths: PositionHealth[] } {
  const healths = positions.map((p) => assessPosition(p, state.rules));
  if (!state.rules.enabled) return { state, actions: [], healths };
  const actions: ShieldAction[] = [];
  const lastActionAt = { ...state.lastActionAt };
  const pendingTrim = { ...state.pendingTrim };
  const cancelledBuysFor = { ...state.cancelledBuysFor };
  const log = [...state.log];

  for (const h of healths) {
    const sym = h.symbol;
    if (h.health === "SAFE" || h.health === "NO_LIQ") {
      if (cancelledBuysFor[sym] && h.health === "SAFE") {
        delete cancelledBuysFor[sym]; // episode over — Rule A may fire again next time
        log.push({ t: now, symbol: sym, msg: `Back to safe (${h.distanceToLiqPct}% buffer)`, level: "info" });
      }
      continue;
    }
    const lastTrim = lastActionAt[sym];
    const inCooldown = lastTrim !== undefined && now - lastTrim < state.rules.cooldownMs;

    if (state.rules.ruleA && !cancelledBuysFor[sym] && hasRestingBuys(sym)) {
      actions.push({ kind: "CANCEL_BUYS", symbol: sym });
      cancelledBuysFor[sym] = true; // cooldown only throttles trims — cancelling must not delay a trim
      log.push({ t: now, symbol: sym, msg: `Rule A: buffer ${h.distanceToLiqPct}% < ${state.rules.warnPct}% — cancelling resting buy rungs`, level: "warn" });
    }

    if (h.health === "CRITICAL" && state.rules.ruleB && !pendingTrim[sym] && !inCooldown) {
      const rules = rulesBySymbol[sym];
      const qty = fix(snapDown(h.size * state.rules.trimFraction, rules?.stepSize ?? 0), rules?.basePrec ?? 8);
      if (qty > 0) {
        const cid = `vektor-shield-trim-${sym}-${now % 1000000}`;
        actions.push({
          kind: "TRIM", symbol: sym, qty,
          order: { client_order_id: cid, symbol: sym, side: h.side === "LONG" ? "sell" : "buy", type: "market", size: String(qty), reduce_only: true },
        });
        pendingTrim[sym] = cid;
        lastActionAt[sym] = now;
        log.push({ t: now, symbol: sym, msg: `Rule B: buffer ${h.distanceToLiqPct}% < ${state.rules.criticalPct}% — reduce-only trim ${qty} (${Math.round(state.rules.trimFraction * 100)}%)`, level: "crit" });
      }
    }
  }
  return { state: { ...state, lastActionAt, pendingTrim, cancelledBuysFor, log: log.slice(-200) }, actions, healths };
}

/** Clear the pending-trim flag once the trim order reaches a final status. */
export function resolveTrim(state: ShieldState, clientOrderId: string, finalStatus: string, now = Date.now()): ShieldState {
  const sym = Object.keys(state.pendingTrim).find((s) => state.pendingTrim[s] === clientOrderId);
  if (!sym) return state;
  const pendingTrim = { ...state.pendingTrim, [sym]: undefined };
  const log = [...state.log, { t: now, symbol: sym, msg: `Trim ${finalStatus.toLowerCase()}`, level: "info" as const }];
  return { ...state, pendingTrim, log: log.slice(-200) };
}

/** Panic button: close every position with a reduce-only market order. */
export function buildFlattenOrders(positions: Position[]): CreateOrderRequest[] {
  return positions.filter((p) => p.size > 0).map((p) => ({
    client_order_id: `vektor-flatten-${p.symbol}-${Date.now() % 1000000}`,
    symbol: p.symbol,
    side: p.positionSide === "LONG" ? "sell" : "buy",
    type: "market",
    size: String(p.size),
    reduce_only: true,
    close_position: true,
  }));
}
