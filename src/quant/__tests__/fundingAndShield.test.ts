import { describe, it, expect } from "vitest";
import { rankFundingOpportunities, buildHedgePlan, buildHedgeSliceOrder, fundingFlipped, HOURS_PER_YEAR } from "../fundingHarvester";
import { assessPosition, evaluateShield, initShieldState, resolveTrim, buildFlattenOrders, DEFAULT_SHIELD_RULES } from "../liquidationShield";
import { analyzeDepth, slippageForSize } from "../whaleRadar";
import type { MarketRules } from "../types";
import type { Position } from "../../types/position";
import type { Market } from "../../types/market";

const rules: MarketRules = { symbol: "ADA-USD", tick: 0.0001, stepSize: 1, minSize: 1, minNotional: 10, basePrec: 0, quotePrec: 4 };

const market = {
  symbol: "ADA-USD", base_prec: 0, quote_prec: 4,
  margin_tiers: [
    { max_notional: "50000", max_leverage: 50, maintenance_margin_rate: "0.01", maintenance_amount: "0" },
    { max_notional: "250000", max_leverage: 25, maintenance_margin_rate: "0.02", maintenance_amount: "500" },
  ],
} as unknown as Market;

describe("funding harvester", () => {
  it("annualizes the HOURLY rate and picks the receiving side", () => {
    const ranked = rankFundingOpportunities([
      { symbol: "ADA-USD", markPrice: 0.42, indexPrice: 0.419, fundingRateHourly: 0.00003, nextFundingTime: 0 },
      { symbol: "BTC-USD", markPrice: 80000, indexPrice: 80100, fundingRateHourly: -0.00001, nextFundingTime: 0 },
    ], 0);
    expect(ranked[0].symbol).toBe("ADA-USD");
    expect(ranked[0].annualizedAprPct).toBeCloseTo(0.00003 * HOURS_PER_YEAR * 100, 3);
    expect(ranked[0].perpSide).toBe("SHORT");
    expect(ranked[1].perpSide).toBe("LONG");
    expect(ranked[0].basisPct).toBeCloseTo(((0.42 - 0.419) / 0.419) * 100, 3);
  });

  it("sizes the short to the spot holding and uses margin tiers for liquidation", () => {
    const plan = buildHedgePlan({ symbol: "ADA-USD", spotQty: 10_000.7, markPrice: 0.42, leverage: 2, slices: 4, market, rules, perpSide: "SHORT", fundingRateHourly: 0.00003 });
    expect(plan.totalSize).toBe(10_000);
    expect(plan.notionalUsd).toBeCloseTo(4200, 2);
    expect(plan.marginUsd).toBeCloseTo(2100, 2);
    // Short: LP = (EP − (iso + MA)/size) / (1 + MMR) = (0.42 + 0.21) / 1.01
    expect(plan.liquidationPrice).toBeCloseTo(0.63 / 1.01, 3);
    expect(plan.hourlyFundingUsd).toBeCloseTo(4200 * 0.00003, 5);
    expect(plan.sliceSize).toBe(2500);
    expect(plan.warnings).toHaveLength(0);
  });

  it("builds IOC slices that cross the spread and sweep the remainder on the last slice", () => {
    const plan = buildHedgePlan({ symbol: "ADA-USD", spotQty: 10_001, markPrice: 0.42, leverage: 2, slices: 4, market, rules, perpSide: "SHORT", fundingRateHourly: 0.00003 });
    const first = buildHedgeSliceOrder(plan, 0, 0.42, rules);
    expect(first).toMatchObject({ side: "sell", time_in_force: "IOC", size: "2500" });
    expect(parseFloat(first.price!)).toBeLessThan(0.42);
    // price is on the tick grid (0.0001) even though quotePrec is 8 on mainnet
    const coarse = { ...rules, tick: 0.001, quotePrec: 8 };
    const p = parseFloat(buildHedgeSliceOrder(plan, 0, 5.8152, coarse).price!);
    expect(Math.abs(p / 0.001 - Math.round(p / 0.001))).toBeLessThan(1e-6);
    const buyPlan = buildHedgePlan({ symbol: "ADA-USD", spotQty: 100, markPrice: 5.8152, leverage: 2, slices: 1, market, rules: coarse, perpSide: "LONG", fundingRateHourly: -0.00003 });
    const b = parseFloat(buildHedgeSliceOrder(buyPlan, 0, 5.8152, coarse).price!);
    expect(b).toBeGreaterThan(5.8152);
    expect(Math.abs(b / 0.001 - Math.round(b / 0.001))).toBeLessThan(1e-6);
    const last = buildHedgeSliceOrder(plan, 3, 0.42, rules);
    expect(last.size).toBe("2501");
  });

  it("detects a funding flip after N consecutive adverse hours", () => {
    expect(fundingFlipped([0.0001, 0.0001, -0.00001], "SHORT")).toBe(false);
    expect(fundingFlipped([0.0001, -0.00001, -0.00002], "SHORT")).toBe(true);
  });
});

const pos = (over: Partial<Position> = {}): Position => ({
  symbol: "ADA-USD", size: 10000, entryPrice: 0.42, positionSide: "LONG", marginMode: "isolated", isoBalance: 1400, leverage: 3,
  accumulatedFundingFees: 0, markPrice: 0.42, liquidationPrice: 0.30, marginRatio: 20, ...over,
});

describe("liquidation shield", () => {
  const rulesBySymbol = { "ADA-USD": rules };

  it("computes distance to liquidation per side", () => {
    expect(assessPosition(pos(), DEFAULT_SHIELD_RULES).distanceToLiqPct).toBeCloseTo(28.57, 1);
    expect(assessPosition(pos({ positionSide: "SHORT", liquidationPrice: 0.45 }), DEFAULT_SHIELD_RULES).distanceToLiqPct).toBeCloseTo(7.14, 1);
    expect(assessPosition(pos({ liquidationPrice: 0 }), DEFAULT_SHIELD_RULES).health).toBe("NO_LIQ");
  });

  it("Rule A fires once per episode, Rule B trims once and respects cooldown", () => {
    let state = initShieldState();
    // WARNING zone: 6% buffer
    let r = evaluateShield(state, [pos({ liquidationPrice: 0.42 * 0.94 })], rulesBySymbol, () => true, 1000);
    expect(r.actions.map((a) => a.kind)).toEqual(["CANCEL_BUYS"]);
    state = r.state;
    r = evaluateShield(state, [pos({ liquidationPrice: 0.42 * 0.94 })], rulesBySymbol, () => true, 2000);
    expect(r.actions).toHaveLength(0); // already cancelled this episode

    // CRITICAL zone: 4% buffer → trim 25%
    r = evaluateShield(state, [pos({ liquidationPrice: 0.42 * 0.96 })], rulesBySymbol, () => false, 3000);
    const trim = r.actions.find((a) => a.kind === "TRIM");
    expect(trim).toBeDefined();
    expect(trim!.kind === "TRIM" && trim!.order).toMatchObject({ side: "sell", type: "market", reduce_only: true, size: "2500" });
    state = r.state;

    // Still critical on the next tick → no second trim while one is pending
    r = evaluateShield(state, [pos({ liquidationPrice: 0.42 * 0.96 })], rulesBySymbol, () => false, 4000);
    expect(r.actions).toHaveLength(0);

    // Trim filled, but cooldown (15s) not elapsed
    state = resolveTrim(r.state, (trim as any).order.client_order_id, "FILLED", 5000);
    r = evaluateShield(state, [pos({ liquidationPrice: 0.42 * 0.96 })], rulesBySymbol, () => false, 6000);
    expect(r.actions).toHaveLength(0);
    // After cooldown it may trim again
    r = evaluateShield(state, [pos({ liquidationPrice: 0.42 * 0.96 })], rulesBySymbol, () => false, 30_000);
    expect(r.actions.some((a) => a.kind === "TRIM")).toBe(true);
  });

  it("does nothing when disabled and flattens every position on panic", () => {
    const state = initShieldState({ ...DEFAULT_SHIELD_RULES, enabled: false });
    expect(evaluateShield(state, [pos({ liquidationPrice: 0.419 })], rulesBySymbol, () => true).actions).toHaveLength(0);
    const flat = buildFlattenOrders([pos(), pos({ symbol: "BTC-USD", positionSide: "SHORT", size: 0.5 })]);
    expect(flat).toHaveLength(2);
    expect(flat[1]).toMatchObject({ side: "buy", reduce_only: true, close_position: true });
  });
});

describe("whale radar", () => {
  const depth = {
    lastUpdateId: 1, E: 0, T: 0,
    bids: [["0.4199", "1000"], ["0.4198", "1000"], ["0.4197", "20000"], ["0.4196", "1000"]],
    asks: [["0.4201", "1000"], ["0.4202", "1000"], ["0.4203", "1000"], ["0.4204", "1000"]],
  };
  it("flags walls and imbalance", () => {
    const a = analyzeDepth(depth)!;
    expect(a.walls).toHaveLength(1);
    expect(a.walls[0]).toMatchObject({ side: "BID", price: 0.4197 });
    expect(a.pressure).toBe("BID_HEAVY");
    expect(a.spreadPct).toBeCloseTo((0.0002 / 0.4201) * 100, 3);
  });
  it("estimates VWAP slippage", () => {
    const s = slippageForSize(depth, "BUY", 2500, 0.42)!;
    expect(s.vwap).toBeCloseTo((1000 * 0.4201 + 1000 * 0.4202 + 500 * 0.4203) / 2500, 6);
    expect(s.slippagePct).toBeGreaterThan(0);
    expect(slippageForSize(depth, "BUY", 10_000, 0.42)).toBeNull();
  });
});
