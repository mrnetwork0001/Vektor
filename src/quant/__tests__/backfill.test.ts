import { describe, it, expect } from "vitest";
import { backfillGrid, fillRowToEvent, fundingCollected, telemetryFromFills } from "../backfill";
import { planGrid, initGridState, restingIds, applyGridFill } from "../gridEngine";
import type { FillRow } from "../../api/history";
import type { MarketRules } from "../types";

const rules: MarketRules = { symbol: "ADA-USD", tick: 0.0001, stepSize: 1, minSize: 1, minNotional: 5, basePrec: 0, quotePrec: 4 };
const fees = { makerRate: 0, takerRate: 0.0005, builderFeeBps: 10 };
const cfg = { symbol: "ADA-USD", lowerPrice: 0.38, upperPrice: 0.46, markPrice: 0.42, levels: 9, marginUsd: 600, leverage: 3, mode: "ARITHMETIC" as const };

const row = (o: Partial<FillRow>): FillRow => ({ id: 1, trade_id: 1, order_id: 1, symbol: "ADA-USD", side: "buy", role: "maker", price: "0.41", size: "100", realized_pnl: "0", fee: "0", fee_type: "none", timestamp: 1000, client_order_id: "x", ...o });

describe("dedupe", () => {
  it("applies a fill only once per trade id (stream duplicate + backfill replay)", () => {
    const plan = planGrid(cfg, rules, fees);
    let state = initGridState(plan);
    const id = state.rungs[3].resting[0].clientOrderId;
    const ev = { ...fillRowToEvent(row({ trade_id: 42, client_order_id: id, price: "0.41", size: "100" }), 10) };
    state = applyGridFill(state, ev).state;
    const again = applyGridFill(state, ev);
    expect(again.state).toBe(state);
    expect(again.orders).toHaveLength(0);
    const b = backfillGrid(state, [row({ trade_id: 42, client_order_id: id, price: "0.41", size: "100" })], 10);
    expect(b.replayed).toBe(0);
    expect(state.inventory).toBe(100);
  });
});

describe("backfill", () => {
  it("replays only this grid's fills newer than the cursor, in trade order, and advances the cursor", () => {
    const plan = planGrid(cfg, rules, fees);
    const state = initGridState(plan);
    const buyId = state.rungs[3].resting[0].clientOrderId; // 0.41
    const fills = [
      row({ trade_id: 7, client_order_id: buyId, price: "0.41", size: "100", timestamp: 3000 }),
      row({ trade_id: 5, client_order_id: "vektor-grid-other-3-e-0", price: "0.41", size: "100" }), // other grid
      row({ trade_id: 2, client_order_id: buyId, price: "0.41", size: "50", timestamp: 1000 }), // older than cursor below
    ];
    const r = backfillGrid({ ...state, lastTradeId: 3 }, fills, 10);
    expect(r.replayed).toBe(1);
    expect(r.state.lastTradeId).toBe(7);
    expect(r.state.inventory).toBe(100);
    expect(r.orders).toHaveLength(1);
    expect(r.orders[0]).toMatchObject({ side: "sell", size: "100" });
    expect(r.state.builderFeesUsd).toBeCloseTo(0.04, 2); // floor(41 × 0.001, 2)
    expect(restingIds(r.state)).not.toContain(buyId);
  });

  it("maps fill rows and sums telemetry over vektor-tagged fills only", () => {
    const ev = fillRowToEvent(row({ role: "taker", fee_type: "commission", fee: "0.0205" }), 10);
    expect(ev).toMatchObject({ side: "BUY", fillQty: 100, isMaker: false, commission: 0.0205, status: "FILLED" });
    const t = telemetryFromFills([row({ client_order_id: "vektor-hedge-1", price: "1", size: "1000" }), row({ client_order_id: "manual-1", price: "1", size: "999" })], 10);
    expect(t).toMatchObject({ fills: 1, volumeUsd: 1000, builderFeesUsd: 1 });
  });

  it("sums funding received since launch for one symbol", () => {
    const f = fundingCollected([
      { id: 1, symbol: "ADA-USD", position_size: "1", position_side: "Short", funding_rate: "0.00003", amount: "0.5", timestamp: 2000 },
      { id: 2, symbol: "ADA-USD", position_size: "1", position_side: "Short", funding_rate: "-0.00001", amount: "-0.1", timestamp: 3000 },
      { id: 3, symbol: "BTC-USD", position_size: "1", position_side: "Short", funding_rate: "0.00001", amount: "9", timestamp: 3000 },
      { id: 4, symbol: "ADA-USD", position_size: "1", position_side: "Short", funding_rate: "0.00001", amount: "9", timestamp: 500 },
    ], "ADA-USD", 1000);
    expect(f).toEqual({ usd: 0.4, payments: 2, rates: [0.00003, -0.00001] });
  });
});
