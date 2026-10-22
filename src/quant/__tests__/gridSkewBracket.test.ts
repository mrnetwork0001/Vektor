import { describe, it, expect } from "vitest";
import { planGrid, initGridState, applyGridFill, buildDeployStrategies, buildDeployOrders, parseRungClientId, reconcileGrid, restingBuyIds, restingIds, stopPriceFor, SKEW_REF_RATE } from "../gridEngine";
import type { FillEvent, MarketRules, FeeContext } from "../types";

const rules: MarketRules = { symbol: "ADA-USD", tick: 0.0001, stepSize: 1, minSize: 1, minNotional: 5, basePrec: 0, quotePrec: 4 };
const fees: FeeContext = { makerRate: 0, takerRate: 0.0005, builderFeeBps: 10 };
const cfg = { symbol: "ADA-USD", lowerPrice: 0.38, upperPrice: 0.46, markPrice: 0.42, levels: 9, marginUsd: 600, leverage: 3, mode: "ARITHMETIC" as const };

const fill = (cid: string, side: "BUY" | "SELL", qty: number, price: number, over: Partial<FillEvent> = {}): FillEvent =>
  ({ symbol: "ADA-USD", clientOrderId: cid, orderId: 1, side, fillQty: qty, fillPrice: price, cumFilled: qty, orderQty: qty, isMaker: true, commission: 0, builderFee: 0, timestamp: 0, status: "FILLED", ...over });

const sumNotional = (p: ReturnType<typeof planGrid>, side: "BUY" | "SELL") => p.rungs.filter((r) => r.entrySide === side).reduce((a, r) => a + r.notionalUsd, 0);

describe("funding-aware skew", () => {
  it("is a no-op by default and with mode NONE", () => {
    const a = planGrid(cfg, rules, fees);
    const b = planGrid({ ...cfg, skew: { mode: "NONE", fundingRateHourly: 0.0001 } }, rules, fees);
    expect(a.skewApplied).toBe(0);
    expect(b.rungs.map((r) => r.plannedSize)).toEqual(a.rungs.map((r) => r.plannedSize));
    expect(a.expectedFundingUsdPerDay).toBe(0);
  });

  it("positive funding favours SELL rungs, keeps total notional, saturates at the reference rate", () => {
    const base = planGrid(cfg, rules, fees);
    const skewed = planGrid({ ...cfg, skew: { mode: "FUNDING", fundingRateHourly: SKEW_REF_RATE / 2 } }, rules, fees);
    expect(skewed.skewApplied).toBeCloseTo(0.5, 6);
    const buyRatio = sumNotional(skewed, "BUY") / sumNotional(base, "BUY");
    const sellRatio = sumNotional(skewed, "SELL") / sumNotional(base, "SELL");
    expect(sellRatio).toBeGreaterThan(1.2);
    expect(buyRatio).toBeLessThan(0.8);
    expect(skewed.totalNotionalUsd).toBeCloseTo(base.totalNotionalUsd, -1); // within ~$5 of rounding
    const sat = planGrid({ ...cfg, skew: { mode: "FUNDING", fundingRateHourly: 10 * SKEW_REF_RATE } }, rules, fees);
    expect(sat.skewApplied).toBe(1);
    expect(sat.rungs.find((r) => r.entrySide === "SELL")!.notionalUsd / base.rungs.find((r) => r.entrySide === "SELL")!.notionalUsd).toBeCloseTo(1.5, 1);
  });

  it("negative funding favours BUY rungs and estimates funding on the long side", () => {
    const p = planGrid({ ...cfg, skew: { mode: "FUNDING", fundingRateHourly: -SKEW_REF_RATE, maxSkew: 0.3 } }, rules, fees);
    expect(p.skewApplied).toBe(-1);
    expect(sumNotional(p, "BUY")).toBeGreaterThan(sumNotional(p, "SELL"));
    expect(p.expectedFundingUsdPerDay).toBeCloseTo(sumNotional(p, "BUY") * SKEW_REF_RATE * 24, 1);
  });
});

describe("per-rung bracket stop-loss", () => {
  const bcfg = { ...cfg, stopLossPct: 5 };

  it("snaps stop prices away from the entry per side", () => {
    expect(stopPriceFor(0.4, "BUY", 5, rules)).toBe(0.38);
    expect(stopPriceFor(0.4, "SELL", 5, rules)).toBe(0.42);
  });

  it("builds one strategy per entry rung with a reduce-only mark-price stop leg", () => {
    const plan = planGrid(bcfg, rules, fees);
    const { strategies, rungs } = buildDeployStrategies(plan, rules);
    expect(strategies).toHaveLength(8);
    const s = strategies[0];
    expect(s.sl_order).toMatchObject({ type: "stop", working_type: "mark_price", size: s.size });
    expect(parseRungClientId(s.sl_order!.client_order_id!)!.role).toBe("s");
    expect(new Set(strategies.map((x) => x.strategy_id)).size).toBe(8);
    const buy = strategies.find((x) => x.side === "buy")!;
    expect(parseFloat(buy.sl_order!.stop_price)).toBeCloseTo(parseFloat(buy.price!) * 0.95, 3);
    expect(rungs[0].resting.map((o) => o.role)).toEqual(["e", "s"]);
    expect(restingBuyIds({ ...initGridState(plan, 0, rules) }).every((id) => parseRungClientId(id)!.role === "e")).toBe(true);
    // plain deploy still works and ignores brackets
    expect(buildDeployOrders(plan).orders).toHaveLength(8);
  });

  it("warns when the stop sits inside one rung spacing", () => {
    expect(planGrid({ ...cfg, stopLossPct: 1 }, rules, fees).warnings.some((w) => /Stop-loss/.test(w))).toBe(true);
    expect(planGrid(bcfg, rules, fees).warnings).toHaveLength(0);
  });

  it("entry fill → limit exit; exit fill → stop leg cancelled, entry re-armed as a bracket", () => {
    const plan = planGrid(bcfg, rules, fees);
    let state = initGridState(plan, 0, rules);
    const rung = state.rungs[3]; // BUY 0.41
    const entry = rung.resting.find((o) => o.role === "e")!;
    const stop = rung.resting.find((o) => o.role === "s")!;
    const r1 = applyGridFill(state, fill(entry.clientOrderId, "BUY", 100, rung.price), 1000, rules);
    state = r1.state;
    expect(r1.orders).toHaveLength(1);
    expect(r1.strategies).toHaveLength(0);
    expect(r1.orders[0]).toMatchObject({ side: "sell", size: "100" });
    expect(state.rungs[4].resting[0]).toMatchObject({ role: "x", exitFor: 3 });
    expect(state.rungs[3].resting.map((o) => o.role)).toEqual(["s"]); // stop armed, entry gone

    const r2 = applyGridFill(state, fill(r1.orders[0].client_order_id!, "SELL", 100, state.rungs[4].price), 2000, rules);
    state = r2.state;
    expect(state.cycles).toBe(1);
    expect(r2.cancel).toEqual([stop.clientOrderId]);
    expect(r2.orders).toHaveLength(0);
    expect(r2.strategies).toHaveLength(1);
    expect(r2.strategies[0]).toMatchObject({ side: "buy", size: "100", price: String(rung.price) });
    expect(state.rungs[3].resting.map((o) => o.role)).toEqual(["e", "s"]);
  });

  it("stop-loss fill books the loss, retires the rung, cancels the orphaned exit, and blocks re-arm", () => {
    const plan = planGrid(bcfg, rules, fees);
    let state = initGridState(plan, 0, rules);
    const rung = state.rungs[3];
    const entry = rung.resting.find((o) => o.role === "e")!;
    const stop = rung.resting.find((o) => o.role === "s")!;
    const r1 = applyGridFill(state, fill(entry.clientOrderId, "BUY", 100, rung.price), 1000, rules);
    state = r1.state;
    const exitCid = r1.orders[0].client_order_id!;
    const stopPx = 0.3895;
    const r2 = applyGridFill(state, fill(stop.clientOrderId, "SELL", 100, stopPx, { isMaker: false }), 2000, rules);
    state = r2.state;
    expect(state.stops).toBe(1);
    expect(state.inventory).toBe(0);
    expect(state.realizedUsd).toBeCloseTo((stopPx - rung.price) * 100, 4);
    expect(state.rungs[3].retired).toBe(true);
    expect(r2.cancel).toEqual([exitCid]);
    expect(restingIds(state)).not.toContain(exitCid);
    expect(state.log[state.log.length - 1].kind).toBe("STOP");
    // A later exit fill that would re-arm rung 3 is skipped
    const r3 = applyGridFill(state, fill(exitCid, "SELL", 100, state.rungs[4].price), 3000, rules);
    expect(r3.strategies).toHaveLength(0);
    expect(r3.state.log[r3.state.log.length - 1].msg).toMatch(/stopped out/);
  });

  it("cancel of an unfilled entry drops its unarmed stop; reconcile keeps unarmed stops whose entry is on the book", () => {
    const plan = planGrid(bcfg, rules, fees);
    const state = initGridState(plan, 0, rules);
    const rung = state.rungs[3];
    const entry = rung.resting.find((o) => o.role === "e")!;
    const r = applyGridFill(state, fill(entry.clientOrderId, "BUY", 0, 0, { fillQty: 0, status: "CANCELED" }), 1000, rules);
    expect(r.state.rungs[3].resting).toHaveLength(0);
    const open = new Set(state.rungs.filter((x) => x.index !== 3).flatMap((x) => x.resting.filter((o) => o.role === "e").map((o) => o.clientOrderId)));
    const rec = reconcileGrid(state, open);
    expect(rec.kept).toBe(14); // 7 entries + their 7 unarmed stops
    expect(rec.dropped).toBe(2);
  });
});
