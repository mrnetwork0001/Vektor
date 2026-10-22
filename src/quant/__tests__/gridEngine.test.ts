import { describe, it, expect } from "vitest";
import { planGrid, initGridState, applyGridFill, buildDeployOrders, restingBuyIds, restingIds, reconcileGrid, parseRungClientId } from "../gridEngine";
import type { FillEvent, MarketRules, FeeContext } from "../types";

const rules: MarketRules = { symbol: "ADA-USD", tick: 0.0001, stepSize: 1, minSize: 1, minNotional: 10, basePrec: 0, quotePrec: 4 };
const fees: FeeContext = { makerRate: 0.0002, takerRate: 0.0005, builderFeeBps: 10 };

const cfg = { symbol: "ADA-USD", lowerPrice: 0.38, upperPrice: 0.46, markPrice: 0.42, levels: 9, marginUsd: 600, leverage: 3, mode: "ARITHMETIC" as const };

function fillFor(cid: string, side: "BUY" | "SELL", qty: number, price: number): FillEvent {
  return { symbol: "ADA-USD", clientOrderId: cid, orderId: 1, side, fillQty: qty, fillPrice: price, cumFilled: qty, orderQty: qty, isMaker: true, commission: qty * price * 0.0002, builderFee: Math.floor(qty * price * 0.001 * 100) / 100, timestamp: 0, status: "FILLED" };
}

describe("planGrid", () => {
  it("leaves the level nearest the mark empty and splits buys/sells around it", () => {
    const plan = planGrid(cfg, rules, fees);
    expect(plan.rungs).toHaveLength(9);
    const empty = plan.rungs.filter((r) => r.entrySide === "NONE");
    expect(empty).toHaveLength(1);
    expect(empty[0].price).toBeCloseTo(0.42, 4);
    expect(plan.rungs.filter((r) => r.entrySide === "BUY").every((r) => r.price < 0.42)).toBe(true);
    expect(plan.rungs.filter((r) => r.entrySide === "SELL").every((r) => r.price > 0.42)).toBe(true);
  });

  it("snaps sizes to step and prices to tick", () => {
    const plan = planGrid(cfg, rules, fees);
    for (const r of plan.rungs) {
      expect(Number.isInteger(r.plannedSize)).toBe(true);
      expect(Math.round(r.price / rules.tick) * rules.tick).toBeCloseTo(r.price, 8);
    }
  });

  it("nets fees out of the cycle profit", () => {
    const plan = planGrid(cfg, rules, fees);
    // spacing 0.01 on mid 0.42 → 2.38%; minus 2×0.02% maker and 2×0.1% builder
    expect(plan.spacingPct).toBeCloseTo(2.381, 2);
    expect(plan.netCyclePct).toBeCloseTo(2.381 - 0.04 - 0.2, 2);
    expect(plan.warnings).toHaveLength(0);
  });

  it("warns when the spacing cannot cover fees", () => {
    const plan = planGrid({ ...cfg, levels: 60 }, rules, { ...fees, builderFeeBps: 100 });
    expect(plan.warnings.some((w) => w.includes("cover"))).toBe(true);
  });

  it("geometric mode has equal ratio steps", () => {
    const plan = planGrid({ ...cfg, mode: "GEOMETRIC" }, rules, fees);
    const ratios = plan.rungs.slice(1).map((r, i) => r.price / plan.rungs[i].price);
    const spread = Math.max(...ratios) - Math.min(...ratios);
    expect(spread).toBeLessThan(0.002);
  });
});

describe("grid fill lifecycle", () => {
  it("deploys one order per active rung with builder-friendly post-only limits", () => {
    const plan = planGrid(cfg, rules, fees);
    const { orders } = buildDeployOrders(plan);
    expect(orders).toHaveLength(8);
    expect(orders.every((o) => o.post_only && o.type === "limit" && o.time_in_force === "GTC")).toBe(true);
    expect(parseRungClientId(orders[0].client_order_id!)).toMatchObject({ gridId: plan.gridId, role: "e" });
  });

  it("buy entry fill → sell exit one rung up for the filled qty; exit fill books PnL and re-arms the buy", () => {
    const plan = planGrid(cfg, rules, fees);
    let state = initGridState(plan);
    const buyRung = state.rungs.find((r) => r.entrySide === "BUY" && r.index === 3)!; // 0.41
    const buyCid = buyRung.resting[0].clientOrderId;

    // The exchange filled 100 (the counter must use this, not the planned size)
    const r1 = applyGridFill(state, fillFor(buyCid, "BUY", 100, buyRung.price));
    state = r1.state;
    expect(r1.orders).toHaveLength(1);
    expect(r1.orders[0]).toMatchObject({ side: "sell", size: "100", price: String(state.rungs[4].price) });
    expect(state.inventory).toBe(100);
    expect(parseRungClientId(r1.orders[0].client_order_id!)!.role).toBe("x");

    // Exit fills
    const r2 = applyGridFill(state, fillFor(r1.orders[0].client_order_id!, "SELL", 100, state.rungs[4].price));
    state = r2.state;
    expect(state.inventory).toBe(0);
    expect(state.cycles).toBe(1);
    expect(state.realizedUsd).toBeCloseTo((state.rungs[4].price - buyRung.price) * 100, 4);
    // Re-armed entry at rung 3
    expect(r2.orders).toHaveLength(1);
    expect(r2.orders[0]).toMatchObject({ side: "buy", price: String(buyRung.price) });
    expect(parseRungClientId(r2.orders[0].client_order_id!)!.role).toBe("e");
  });

  it("does not stack a counter order on a rung that already rests the same side", () => {
    const plan = planGrid({ ...cfg, markPrice: 0.37 }, rules, fees); // mark below range → all SELL, no empty level
    let state = initGridState(plan);
    const sell0 = state.rungs[1].resting[0];
    const r = applyGridFill(state, fillFor(sell0.clientOrderId, "SELL", sell0.size, state.rungs[1].price));
    // counter BUY at rung 0 - rung 0 holds a resting SELL, so a BUY is fine
    expect(r.orders).toHaveLength(1);
    state = r.state;
    // Now fill that BUY exit → re-arm SELL at rung 1; rung 1 is empty, OK. Then a second SELL entry at rung 1 would be a stack.
    const r2 = applyGridFill(state, fillFor(r.orders[0].client_order_id!, "BUY", sell0.size, state.rungs[0].price));
    expect(r2.orders[0].side).toBe("sell");
  });

  it("keeps a partially filled entry resting and does not re-arm on top of it", () => {
    const plan = planGrid(cfg, rules, fees);
    let state = initGridState(plan);
    const buyRung = state.rungs[3];
    const buyCid = buyRung.resting[0].clientOrderId;
    const r1 = applyGridFill(state, { ...fillFor(buyCid, "BUY", 100, buyRung.price), orderQty: buyRung.plannedSize, cumFilled: 100, status: "OPEN" });
    state = r1.state;
    expect(state.rungs[3].resting).toHaveLength(1); // entry still resting for the remainder
    const r2 = applyGridFill(state, fillFor(r1.orders[0].client_order_id!, "SELL", 100, state.rungs[4].price));
    expect(r2.state.cycles).toBe(1);
    expect(r2.orders).toHaveLength(0); // no stacked BUY at rung 3
    expect(r2.state.log[r2.state.log.length - 1].kind).toBe("SKIP");
  });

  it("cancel events free the rung", () => {
    const plan = planGrid(cfg, rules, fees);
    const state = initGridState(plan);
    const ids = restingBuyIds(state);
    expect(ids.length).toBeGreaterThan(0);
    const r = applyGridFill(state, { ...fillFor(ids[0], "BUY", 0, 0), fillQty: 0, status: "CANCELED" });
    expect(restingBuyIds(r.state)).toHaveLength(ids.length - 1);
  });

  it("reconciles against the open-order book after a reload", () => {
    const plan = planGrid(cfg, rules, fees);
    const state = initGridState(plan);
    const ids = restingIds(state);
    const open = new Set(ids.slice(0, 3)); // only 3 survived (others filled or were cancelled while we were away)
    const r = reconcileGrid(state, open);
    expect(r.kept).toBe(3);
    expect(r.dropped).toBe(ids.length - 3);
    expect(restingIds(r.state)).toEqual(ids.slice(0, 3));
    expect(r.state.log[r.state.log.length - 1].msg).toMatch(/Reconciled/);
  });

  it("ignores fills from other grids", () => {
    const plan = planGrid(cfg, rules, fees);
    const state = initGridState(plan);
    const r = applyGridFill(state, fillFor("vektor-grid-zzz-1-e-0", "BUY", 5, 0.4));
    expect(r.state).toBe(state);
  });
});
