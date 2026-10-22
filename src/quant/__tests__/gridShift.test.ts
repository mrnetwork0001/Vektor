import { describe, it, expect } from "vitest";
import { shouldShift, buildShiftedPlan } from "../gridShift";
import { planGrid, initGridState, applyGridFill, restingIds, parseRungClientId } from "../gridEngine";
import { SimExchange } from "../../sim/simExchange";
import type { FillEvent, MarketRules } from "../types";

const rules: MarketRules = { symbol: "ADA-USD", tick: 0.0001, stepSize: 1, minSize: 1, minNotional: 5, basePrec: 0, quotePrec: 4 };
const fees = { makerRate: 0, takerRate: 0.0005, builderFeeBps: 10 };
const cfg = { symbol: "ADA-USD", lowerPrice: 0.376, upperPrice: 0.424, markPrice: 0.40, levels: 9, marginUsd: 600, leverage: 3, mode: "GEOMETRIC" as const };

describe("shouldShift", () => {
  const state = initGridState(planGrid(cfg, rules, fees), 0);
  it("stays put inside the range and inside the hysteresis band", () => {
    expect(shouldShift(state, 0.40, {}, 0, 1000).shift).toBe(false);
    expect(shouldShift(state, 0.4255, {}, 0, 1000)).toMatchObject({ shift: false, reason: "IN_RANGE" }); // +0.35% over upper < 0.5%
  });
  it("shifts on a breakout beyond the hysteresis", () => {
    expect(shouldShift(state, 0.43, {}, 0, 1000)).toMatchObject({ shift: true, reason: "BREAKOUT_UP" });
    expect(shouldShift(state, 0.37, {}, 0, 1000)).toMatchObject({ shift: true, reason: "BREAKOUT_DOWN" });
  });
  it("shifts after dwelling in the outermost band for N ticks, and resets the streak when back inside", () => {
    let streak = 0;
    for (let i = 0; i < 4; i++) streak = shouldShift(state, 0.4235, { edgeTicks: 5 }, streak, 1000).edgeStreak; // above rung[levels-2]
    expect(streak).toBe(4);
    expect(shouldShift(state, 0.4235, { edgeTicks: 5 }, streak, 1000)).toMatchObject({ shift: true, reason: "EDGE_DWELL_HIGH", edgeStreak: 5 });
    expect(shouldShift(state, 0.40, { edgeTicks: 5 }, 4, 1000).edgeStreak).toBe(0);
  });
  it("respects the cooldown after a shift", () => {
    const shifted = { ...state, shiftedAt: 10_000 };
    expect(shouldShift(shifted, 0.43, { minIntervalMs: 60_000 }, 0, 20_000)).toMatchObject({ shift: false, reason: "COOLDOWN" });
    expect(shouldShift(shifted, 0.43, { minIntervalMs: 60_000 }, 0, 80_000).shift).toBe(true);
  });
});

describe("buildShiftedPlan", () => {
  it("re-centres on the mark keeping the range shape, carries stats, bumps the counter", () => {
    const state = { ...initGridState(planGrid(cfg, rules, fees), 0), realizedUsd: 12.5, cycles: 3, fills: 7, feesUsd: 0.1, builderFeesUsd: 0.4 };
    const r = buildShiftedPlan(state, 0.44, rules, fees, 5000);
    expect(r.plan.config.lowerPrice).toBeCloseTo(0.44 * 0.94, 6);
    expect(r.plan.config.upperPrice).toBeCloseTo(0.44 * 1.06, 6);
    expect(r.plan.config.levels).toBe(9);
    expect(r.newState).toMatchObject({ realizedUsd: 12.5, cycles: 3, fills: 7, feesUsd: 0.1, builderFeesUsd: 0.4, shifts: 1, shiftedAt: 5000 });
    expect(r.plan.gridId).not.toBe(state.plan.gridId);
    expect(r.ordersWithoutSymbol).toHaveLength(8);
    expect(r.ordersWithoutSymbol.every((o) => !("symbol" in o) && o.post_only)).toBe(true);
    expect(r.exitsForInventory).toBe(0);
    expect(r.newState.log[r.newState.log.length - 1].msg).toMatch(/Auto-shift #1/);
  });

  it("turns long inventory into SELL exits nearest the mark, remainder on the last exit rung", () => {
    const state = { ...initGridState(planGrid(cfg, rules, fees), 0), inventory: 3000 };
    const r = buildShiftedPlan(state, 0.38, rules, fees, 5000);
    const exits = r.newState.rungs.flatMap((rg) => rg.resting.filter((o) => o.role === "x").map((o) => ({ ...o, price: rg.price })));
    expect(exits.length).toBeGreaterThan(0);
    expect(exits.every((o) => o.side === "SELL" && o.price > 0.38)).toBe(true);
    expect(exits.reduce((a, o) => a + o.size, 0)).toBe(3000);
    expect(r.exitsForInventory).toBe(exits.length);
    // the exits are the lowest sell rungs (nearest the mark)
    const sellPrices = r.newState.rungs.filter((rg) => rg.entrySide === "SELL").map((rg) => rg.price).sort((a, b) => a - b);
    expect(exits.map((o) => o.price).sort((a, b) => a - b)).toEqual(sellPrices.slice(0, exits.length));
    for (const o of r.ordersWithoutSymbol) expect(parseRungClientId(o.client_order_id!)!.gridId).toBe(r.plan.gridId);
  });

  it("turns short inventory into BUY exits below the mark", () => {
    const state = { ...initGridState(planGrid(cfg, rules, fees), 0), inventory: -500 };
    const r = buildShiftedPlan(state, 0.42, rules, fees);
    const exits = r.newState.rungs.flatMap((rg) => rg.resting.filter((o) => o.role === "x").map((o) => ({ ...o, price: rg.price })));
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ side: "BUY", size: 500 });
    expect(exits[0].price).toBeLessThan(0.42);
  });
});

describe("end-to-end: trend up → shift → fresh ladder around the new mark", () => {
  it("replaces the book in one call and the exit fill after the shift books a round trip", async () => {
    const ex = new SimExchange(fees, {}, 1e6);
    ex.setMark("ADA-USD", 0.40);
    let state = initGridState(planGrid(cfg, rules, fees));
    const q: FillEvent[] = [];
    ex.onFill((f) => q.push(f));
    const drain = async () => { while (q.length) { const f = q.shift()!; const r = applyGridFill(state, f); state = r.state; if (r.orders.length) await ex.placeBatch(r.orders); } };
    await ex.placeBatch(state.rungs.flatMap((r) => r.resting.map((o) => ({ client_order_id: o.clientOrderId, symbol: "ADA-USD", side: o.side === "BUY" ? "buy" as const : "sell" as const, type: "limit" as const, size: String(o.size), price: String(r.price), time_in_force: "GTC" as const, post_only: true }))));
    await drain();
    const oldIds = new Set(restingIds(state));

    // Rally through every sell rung and beyond the range: the grid is now short
    ex.setMark("ADA-USD", 0.43);
    await drain();
    expect(state.inventory).toBeLessThan(0);
    const d = shouldShift(state, 0.43, {}, 0, Date.now());
    expect(d).toMatchObject({ shift: true, reason: "BREAKOUT_UP" });

    const r = buildShiftedPlan(state, 0.43, rules, fees);
    const res = await ex.replaceAll!("ADA-USD", r.ordersWithoutSymbol);
    expect(res.failed).toHaveLength(0);
    state = r.newState;
    await drain(); // CANCELED events for the old grid id are ignored by the new state

    const open = ex.snapshot().openOrders;
    expect(open.length).toBe(r.ordersWithoutSymbol.length);
    expect(open.every((o) => !oldIds.has(o.cid))).toBe(true);
    const prices = open.map((o) => o.price);
    expect(Math.min(...prices)).toBeGreaterThan(0.43 * 0.93);
    expect(Math.max(...prices)).toBeLessThan(0.43 * 1.07);
    expect(open.filter((o) => o.req.side === "buy").every((o) => o.price < 0.43)).toBe(true);
    expect(state.shifts).toBe(1);

    // Short inventory sits as BUY exits below the mark; a dip fills them and books round trips
    const cyclesBefore = state.cycles;
    ex.setMark("ADA-USD", 0.43 * 0.93);
    await drain();
    expect(state.cycles).toBeGreaterThan(cyclesBefore);
    expect(Math.abs(state.inventory)).toBeLessThan(Math.abs(r.newState.inventory) + 1e-9);
  });
});
