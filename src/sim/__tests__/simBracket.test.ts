import { describe, it, expect } from "vitest";
import { SimExchange } from "../simExchange";
import { planGrid, initGridState, applyGridFill, buildDeployStrategies } from "../../quant/gridEngine";
import type { FillEvent, MarketRules } from "../../quant/types";

const rules: MarketRules = { symbol: "ADA-USD", tick: 0.0001, stepSize: 1, minSize: 1, minNotional: 5, basePrec: 0, quotePrec: 4 };
const fees = { makerRate: 0, takerRate: 0.0005, builderFeeBps: 10 };

describe("SimExchange brackets + grid stop-loss end-to-end", () => {
  it("arms the stop after the entry fills, triggers it on a crash, and the grid retires the rung", async () => {
    const ex = new SimExchange(fees, {}, 10_000);
    ex.setMark("ADA-USD", 0.42);
    const plan = planGrid({ symbol: "ADA-USD", lowerPrice: 0.38, upperPrice: 0.46, markPrice: 0.42, levels: 9, marginUsd: 600, leverage: 3, mode: "ARITHMETIC", stopLossPct: 4 }, rules, fees);
    let state = initGridState(plan, 0, rules);
    const pending: FillEvent[] = [];
    ex.onFill((f) => pending.push(f));
    const drain = async () => {
      while (pending.length) {
        const r = applyGridFill(state, pending.shift()!, Date.now(), rules);
        state = r.state;
        if (r.orders.length) await ex.placeBatch(r.orders);
        for (const s of r.strategies) await ex.placeStrategy(s);
        for (const c of r.cancel) await ex.cancel("ADA-USD", c);
      }
    };
    const { strategies } = buildDeployStrategies(plan, rules);
    for (const s of strategies) await ex.placeStrategy(s);
    await drain();
    expect(ex.snapshot().openOrders).toHaveLength(8); // stops are not on the book until armed

    ex.setMark("ADA-USD", 0.409); // fills the 0.41 buy → its stop (0.3936) arms, exit sells at 0.42
    await drain();
    expect(state.inventory).toBe(state.rungs[3].plannedSize);
    expect(state.rungs[3].resting.map((o) => o.role)).toEqual(["s"]);

    ex.setMark("ADA-USD", 0.39); // crash through 0.40 (fills rung 2 too) and the 0.3936 stop
    await drain();
    expect(state.stops).toBeGreaterThanOrEqual(1);
    expect(state.rungs[3].retired).toBe(true);
    expect(state.realizedUsd).toBeLessThan(0);
    // the orphaned 0.42 exit for rung 3 was cancelled on the sim
    const open = ex.snapshot().openOrders.map((o) => o.cid);
    expect(open.some((c) => /-4-x-/.test(c) && state.rungs[4].resting.some((o) => o.exitFor === 3 && o.clientOrderId === c))).toBe(false);
  });

  it("cancelling an unfilled bracket primary also cancels its unarmed stop", async () => {
    const ex = new SimExchange(fees, {}, 1000);
    ex.setMark("BTC-USD", 80_000);
    const events: FillEvent[] = [];
    ex.onFill((f) => events.push(f));
    await ex.placeStrategy({ strategy_id: "s1", client_order_id: "p1", symbol: "BTC-USD", side: "buy", type: "limit", size: "0.01", price: "79000", post_only: true, sl_order: { client_order_id: "sl1", type: "stop", size: "0.01", stop_price: "78000", working_type: "mark_price" } });
    await ex.cancel("BTC-USD", "p1");
    expect(events.filter((e) => e.status === "CANCELED").map((e) => e.clientOrderId).sort()).toEqual(["p1", "sl1"]);
    expect(ex.snapshot().openOrders).toHaveLength(0);
  });
});
