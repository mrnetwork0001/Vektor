import { describe, it, expect } from "vitest";
import { classify, parseProofQuery, summarize } from "../analytics";
import { selectorQuery } from "../../api/publicHistory";
import type { FillRow } from "../../api/history";

const row = (o: Partial<FillRow>): FillRow => ({ id: 1, trade_id: 1, order_id: 1, symbol: "ADA-USD", side: "buy", role: "maker", price: "0.40", size: "100", realized_pnl: "0", fee: "0", fee_type: "none", timestamp: 1000, client_order_id: "x", ...o });

describe("proof analytics", () => {
  it("classifies by client id prefix", () => {
    expect(classify("vektor-grid-abc-3-e-0")).toBe("grid");
    expect(classify("vektor-hedge-ADA-USD-0-1")).toBe("hedge");
    expect(classify("vektor-shield-trim-ADA-USD-1")).toBe("shield");
    expect(classify("manual")).toBe("other");
    expect(classify(undefined)).toBe("other");
  });

  it("summarises vektor fills only, counts exits as round trips, reconstructs builder fees", () => {
    const fills = [
      row({ id: 3, timestamp: 3000, client_order_id: "vektor-grid-abc-4-x-9", side: "sell", price: "0.41", size: "100", realized_pnl: "1.0", fee_type: "commission", fee: "0.02" }),
      row({ id: 2, timestamp: 2000, client_order_id: "vektor-grid-abc-3-e-0", price: "0.40", size: "100" }),
      row({ id: 1, timestamp: 1000, client_order_id: "manual-1", price: "1", size: "1000" }),
    ];
    const s = summarize(fills, [{ id: 1, symbol: "ADA-USD", position_size: "1", position_side: "Short", funding_rate: "0.00001", amount: "0.25", timestamp: 1 }], 10);
    expect(s.totalFills).toBe(3);
    expect(s.vektorFills).toBe(2);
    expect(s.roundTrips).toBe(1);
    expect(s.realizedPnlUsd).toBe(1);
    expect(s.volumeUsd).toBeCloseTo(81, 2);
    expect(s.builderFeesUsd).toBeCloseTo(0.08, 2); // floor(40×0.001,2)+floor(41×0.001,2)
    expect(s.commissionUsd).toBeCloseTo(0.02, 4);
    expect(s.bySymbol[0]).toMatchObject({ symbol: "ADA-USD", fills: 2, roundTrips: 1, gridIds: ["abc"] });
    expect(s.timeline).toHaveLength(2);
    expect(s.timeline[1].cumPnlUsd).toBe(1);
    expect(s.firstTs).toBe(2000);
    expect(s.fundingUsd).toBe(0.25);
  });

  it("parses the query string and builds selectors", () => {
    const q = parseProofQuery("?account=abc&bps=25");
    expect(q).toMatchObject({ account: "abc", bps: 25, base: "https://api.strikefinance.org" });
    expect(parseProofQuery("?address=0x1&chain=ethereum&net=testnet").base).toContain("testnet");
    expect(parseProofQuery("?bps=500").bps).toBe(100);
    expect(selectorQuery({ account_id: "u" })).toBe("account_id=u");
    expect(selectorQuery({ blockchain_address: "0x1", blockchain: "ethereum" })).toBe("blockchain_address=0x1&blockchain=ethereum");
  });
});
