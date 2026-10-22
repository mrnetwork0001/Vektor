import { describe, it, expect } from "vitest";
import { createRadar, ingest, toL3Event, wallReliability, restingWalls, activeSignals, type L3Event } from "../l3Radar";

const TICK = 0.0001;
let seq = 0;
const ev = (o: Partial<L3Event> & { action: L3Event["action"]; orderId: string; price: number; t: number }): L3Event => ({
  seq: ++seq, side: "BID", deltaSize: 0, remainingSize: 0, ...o,
});
const open = (id: string, price: number, size: number, t: number, side: "BID" | "ASK" = "BID") => ev({ action: "open", orderId: id, price, t, side, deltaSize: size, remainingSize: size });
const cancel = (id: string, price: number, size: number, t: number, side: "BID" | "ASK" = "BID") => ev({ action: "cancel", orderId: id, price, t, side, deltaSize: -size, remainingSize: 0 });
const fill = (id: string, price: number, qty: number, remaining: number, t: number, side: "BID" | "ASK" = "BID") =>
  ev({ action: remaining > 0 ? "partial_fill" : "full_fill", orderId: id, price, t, side, deltaSize: -qty, remainingSize: remaining, tradeId: seq });

/** Ten ordinary 1,000-ADA orders establish the average. */
function warm(s = createRadar(TICK), mark = 0.2150) {
  for (let i = 0; i < 10; i++) ingest(s, open(`n${i}`, 0.2140 - i * TICK, 1000, 1000 + i), mark);
  return s;
}

describe("L3 radar", () => {
  it("flags a large wall pulled untouched as price approaches", () => {
    const s = warm();
    ingest(s, open("W", 0.2145, 50_000, 2000), 0.2150); // 50k ADA, mark 5 ticks away
    expect(restingWalls(s)).toHaveLength(1);
    ingest(s, open("x", 0.2130, 1000, 3000), 0.2147); // price moves to 2 ticks above the wall
    ingest(s, cancel("W", 0.2145, 50_000, 4000), 0.2147);
    const sig = activeSignals(s, 4000);
    expect(sig).toHaveLength(1);
    expect(sig[0]).toMatchObject({ kind: "SPOOF", side: "BID", price: 0.2145, notional: 50_000 * 0.2145 });
    expect(sig[0].evidence).toMatch(/pulled/);
    expect(wallReliability(s, 0.2145)).toBe(0); // 100% pulled near touch
  });

  it("does not flag a wall cancelled far from price or after a long life or after being hit", () => {
    const s = warm();
    ingest(s, open("far", 0.2100, 50_000, 2000), 0.2150); // 50 ticks away
    ingest(s, cancel("far", 0.2100, 50_000, 3000), 0.2150);
    ingest(s, open("old", 0.2145, 50_000, 2000), 0.2150);
    ingest(s, cancel("old", 0.2145, 50_000, 2000 + 60_000), 0.2146); // 60s life
    ingest(s, open("hit", 0.2145, 50_000, 70_000), 0.2146);
    ingest(s, fill("hit", 0.2145, 10_000, 40_000, 71_000), 0.2145);
    ingest(s, cancel("hit", 0.2145, 40_000, 72_000), 0.2145);
    expect(activeSignals(s, 72_000).filter((x) => x.kind === "SPOOF")).toHaveLength(0);
    // At 0.2145: "old" pulled 50k near touch (slow pull, still a pull), "hit" filled 10k then pulled 40k → 10k / (10k + 90k)
    expect(wallReliability(s, 0.2145)).toBeCloseTo(10_000 / 100_000, 5);
    expect(wallReliability(s, 0.9999)).toBeNull();
  });

  it("flags a level that keeps refilling right after fills as an iceberg", () => {
    const s = warm();
    let t = 5000;
    // First open is the seed; each later open lands 500 ms after a fill → refills #1, #2, #3
    for (let i = 0; i < 4; i++) {
      ingest(s, open(`i${i}`, 0.2149, 2000, t, "ASK"), 0.2148);
      ingest(s, fill(`i${i}`, 0.2149, 2000, 0, t + 500, "ASK"), 0.2149);
      t += 1000;
    }
    const sig = activeSignals(s, t);
    expect(sig.some((x) => x.kind === "ICEBERG" && x.price === 0.2149 && x.side === "ASK")).toBe(true);
    // Not re-signalled within the window
    ingest(s, open("i9", 0.2149, 2000, t, "ASK"), 0.2148);
    ingest(s, fill("i9", 0.2149, 2000, 0, t + 500, "ASK"), 0.2149);
    ingest(s, open("i10", 0.2149, 2000, t + 1000, "ASK"), 0.2148);
    expect(activeSignals(s, t + 1000).filter((x) => x.kind === "ICEBERG")).toHaveLength(1);
  });

  it("maps raw l3_update JSON and ignores clear", () => {
    const e = toL3Event({ type: "l3_update", symbol: "ADA-USD", action: "partial_fill", order_id: "abc", side: "sell", price: "0.21509", delta_size: "-125", remaining_size: "875", sequence: 7, trade_id: 99, timestamp: 1700 });
    expect(e).toMatchObject({ action: "partial_fill", side: "ASK", price: 0.21509, deltaSize: -125, remainingSize: 875, seq: 7, tradeId: 99, t: 1700 });
    expect(toL3Event({ type: "l3_update", action: "clear", sequence: 8 })).toBeNull();
  });

  it("prunes signals and timeline outside the window", () => {
    const s = warm(createRadar(TICK, { windowMs: 10_000 }));
    ingest(s, open("W", 0.2145, 50_000, 2000), 0.2150);
    ingest(s, cancel("W", 0.2145, 50_000, 3000), 0.2146);
    expect(activeSignals(s, 3000)).toHaveLength(1);
    ingest(s, open("later", 0.2140, 1000, 30_000), 0.2150);
    expect(activeSignals(s, 30_000)).toHaveLength(0);
    expect(s.timeline.every((x) => x.t >= 20_000)).toBe(true);
  });
});
