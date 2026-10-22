import { describe, it, expect } from "vitest";
import { runGridBacktest, parseKlines, type Candle } from "../backtest";
import { atr, suggestRange } from "../rangeSuggest";
import type { MarketRules, FeeContext } from "../types";

const rules: MarketRules = { symbol: "ADA-USD", tick: 0.0001, stepSize: 1, minSize: 1, minNotional: 5, basePrec: 0, quotePrec: 4 };
const fees: FeeContext = { makerRate: 0, takerRate: 0.0005, builderFeeBps: 10 };

/** A sideways market oscillating ±5% around 0.40 over 48 hourly candles. */
function sideways(n = 48, base = 0.4, amp = 0.05): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = base * (1 + amp * Math.sin((i / n) * Math.PI * 6));
    const c = base * (1 + amp * Math.sin(((i + 1) / n) * Math.PI * 6));
    out.push({ t: 1_700_000_000_000 + i * 3_600_000, o, c, h: Math.max(o, c) * 1.004, l: Math.min(o, c) * 0.996 });
  }
  return out;
}

describe("grid backtest", () => {
  it("harvests round trips in a ranging market and nets out fees", () => {
    const r = runGridBacktest({ symbol: "ADA-USD", lowerPrice: 0.37, upperPrice: 0.43, levels: 13, marginUsd: 500, leverage: 5, mode: "ARITHMETIC" }, sideways(), rules, fees);
    expect(r.cycles).toBeGreaterThan(5);
    expect(r.realizedUsd).toBeGreaterThan(0);
    expect(r.builderFeesUsd).toBeGreaterThan(0);
    expect(r.netUsd).toBeCloseTo(r.realizedUsd + r.inventoryPnlUsd - r.feesUsd - r.builderFeesUsd, 1);
    expect(r.equity).toHaveLength(48);
    expect(r.timeInRangePct).toBe(100);
    expect(r.maxDrawdownUsd).toBeGreaterThanOrEqual(0);
  });

  it("a trending market leaves inventory and little realized profit", () => {
    const trend: Candle[] = Array.from({ length: 30 }, (_, i) => { const o = 0.4 * (1 - i * 0.004), c = 0.4 * (1 - (i + 1) * 0.004); return { t: i * 3_600_000, o, c, h: o * 1.001, l: c * 0.999 }; });
    const r = runGridBacktest({ symbol: "ADA-USD", lowerPrice: 0.36, upperPrice: 0.44, levels: 9, marginUsd: 500, leverage: 3, mode: "GEOMETRIC" }, trend, rules, fees);
    expect(r.cycles).toBe(0);
    expect(r.final.inventory).toBeGreaterThan(0);
    expect(r.inventoryPnlUsd).toBeLessThan(0);
    expect(r.timeInRangePct).toBeLessThan(100);
  });

  it("parses kline rows and skips junk", () => {
    const c = parseKlines([[1, "0.4", "0.41", "0.39", "0.405", "100"], [2, "0", "0", "0", "0", "0"]]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ t: 1, h: 0.41 });
  });
});

describe("range suggestion", () => {
  it("computes ATR and sizes the grid above the fee floor", () => {
    const cs = sideways();
    const a = atr(cs);
    expect(a).toBeGreaterThan(0);
    const s = suggestRange(cs, fees)!;
    expect(s.lower).toBeLessThan(cs[cs.length - 1].c);
    expect(s.upper).toBeGreaterThan(cs[cs.length - 1].c);
    expect(s.levels).toBeGreaterThanOrEqual(4);
    expect(s.levels).toBeLessThanOrEqual(40);
    expect(s.spacingPct).toBeGreaterThanOrEqual(s.feeFloorPct * 3 - 1e-9);
  });
  it("returns null without enough history", () => {
    expect(suggestRange(sideways(5), fees)).toBeNull();
  });
});
