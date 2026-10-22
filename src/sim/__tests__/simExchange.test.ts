import { describe, it, expect } from "vitest";
import { SimExchange } from "../simExchange";
import { planGrid, initGridState, applyGridFill, buildDeployOrders } from "../../quant/gridEngine";
import type { FillEvent, MarketRules } from "../../quant/types";

const rules: MarketRules = { symbol: "ADA-USD", tick: 0.0001, stepSize: 1, minSize: 1, minNotional: 10, basePrec: 0, quotePrec: 4 };
const fees = { makerRate: 0.0002, takerRate: 0.0005, builderFeeBps: 10 };

describe("SimExchange + grid end-to-end", () => {
  it("fills rungs as the mark crosses them, places exits, books cycles", async () => {
    const ex = new SimExchange(fees, {}, 10_000);
    ex.setMark("ADA-USD", 0.42);
    const plan = planGrid({ symbol: "ADA-USD", lowerPrice: 0.38, upperPrice: 0.46, markPrice: 0.42, levels: 9, marginUsd: 600, leverage: 3, mode: "ARITHMETIC" }, rules, fees);
    let state = initGridState(plan);
    const pending: FillEvent[] = [];
    ex.onFill((f) => pending.push(f));
    const drain = async () => {
      while (pending.length) {
        const f = pending.shift()!;
        const r = applyGridFill(state, f);
        state = r.state;
        if (r.orders.length) await ex.placeBatch(r.orders);
      }
    };
    const { orders } = buildDeployOrders(plan);
    const res = await ex.placeBatch(orders);
    expect(res.failed).toHaveLength(0);
    await drain();
    expect(ex.snapshot().openOrders).toHaveLength(8);

    // Drop through two buy rungs (0.41, 0.40)
    ex.setMark("ADA-USD", 0.399);
    await drain();
    expect(state.inventory).toBeGreaterThan(0);
    expect(state.fills).toBe(2);
    const snap = ex.snapshot();
    expect(snap.positions[0]).toMatchObject({ positionSide: "LONG" });
    // Exits now rest at 0.42 and 0.41
    expect(snap.openOrders.filter((o) => o.req.side === "sell").length).toBe(6);

    // Rally back → both exits fill, two round trips, buys re-armed
    ex.setMark("ADA-USD", 0.425);
    await drain();
    expect(state.cycles).toBe(2);
    expect(state.inventory).toBe(0);
    expect(state.realizedUsd).toBeGreaterThan(0);
    expect(ex.snapshot().builderFeesUsd).toBeGreaterThan(0);
    expect(ex.snapshot().openOrders.filter((o) => o.req.side === "buy").length).toBe(4);
  });

  it("rejects crossing post-only orders and clamps reduce-only to the position", async () => {
    const ex = new SimExchange(fees, {}, 1000);
    ex.setMark("BTC-USD", 80_000);
    const r = await ex.placeBatch([{ client_order_id: "a", symbol: "BTC-USD", side: "buy", type: "limit", size: "1", price: "81000", post_only: true }]);
    expect(r.failed[0].error).toBe("order_would_match_immediately");
    await ex.placeBatch([{ client_order_id: "b", symbol: "BTC-USD", side: "buy", type: "market", size: "0.5" }]);
    const fills: FillEvent[] = [];
    ex.onFill((f) => fills.push(f));
    await ex.placeBatch([{ client_order_id: "c", symbol: "BTC-USD", side: "sell", type: "market", size: "5", reduce_only: true }]);
    expect(fills[0].fillQty).toBe(0.5);
    expect(ex.snapshot().positions).toHaveLength(0);
  });
});
