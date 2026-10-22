import { describe, it, expect } from "vitest";
import { parseArgs, num, table, formatPlan, formatBacktest, formatFills, formatStatus, formatRange } from "../lib";
import { planGrid } from "../../src/quant/gridEngine";
import { runGridBacktest, type Candle } from "../../src/quant/backtest";
import { suggestRange } from "../../src/quant/rangeSuggest";
import type { MarketRules } from "../../src/quant/types";

const rules: MarketRules = { symbol: "ADA-USD", tick: 0.0001, stepSize: 1, minSize: 1, minNotional: 5, basePrec: 0, quotePrec: 4 };
const fees = { makerRate: 0, takerRate: 0.0005, builderFeeBps: 10 };

describe("parseArgs", () => {
  it("splits command, positionals and flags in every form", () => {
    expect(parseArgs(["plan", "ADA-USD", "--lower", "0.21", "--upper=0.235", "--json", "--levels", "12"])).toEqual({
      cmd: "plan", positional: ["ADA-USD"], flags: { lower: "0.21", upper: "0.235", json: true, levels: "12" },
    });
    expect(parseArgs([])).toEqual({ cmd: "help", positional: [], flags: {} });
    expect(parseArgs(["status", "--json"]).flags.json).toBe(true);
  });
  it("num() applies defaults and rejects garbage", () => {
    expect(num(undefined, 7)).toBe(7);
    expect(num("3.5")).toBe(3.5);
    expect(() => num("abc")).toThrow();
    expect(() => num(undefined)).toThrow();
  });
});

describe("formatters", () => {
  it("renders aligned tables", () => {
    const t = table(["a", "bbb"], [["x", 1], ["yyyy", 22]]);
    expect(t.split("\n")).toEqual(["a     bbb", "----  ---", "x     1", "yyyy  22"]);
  });
  it("formats a plan with rungs and warnings", () => {
    const plan = planGrid({ symbol: "ADA-USD", lowerPrice: 0.38, upperPrice: 0.46, markPrice: 0.42, levels: 9, marginUsd: 600, leverage: 3, mode: "ARITHMETIC" }, rules, fees);
    const s = formatPlan(plan);
    expect(s).toContain("ADA-USD  arithmetic  9 levels  3x");
    expect(s).toContain("NONE"); // the empty level near the mark
    expect(s).not.toContain("WARNING");
    // 40 levels at 100 bps: spacing ≈ 0.5% < 2 × 1% builder fee → engine warns, formatter surfaces it
    const tight = planGrid({ symbol: "ADA-USD", lowerPrice: 0.38, upperPrice: 0.46, markPrice: 0.42, levels: 40, marginUsd: 600, leverage: 3, mode: "ARITHMETIC" }, rules, { ...fees, builderFeeBps: 100 });
    expect(formatPlan(tight)).toMatch(/WARNING: .*fees/);
  });
  it("formats backtest, range, fills and status", () => {
    const cs: Candle[] = Array.from({ length: 48 }, (_, i) => { const o = 0.4 * (1 + 0.05 * Math.sin(i / 3)), c = 0.4 * (1 + 0.05 * Math.sin((i + 1) / 3)); return { t: i * 3_600_000, o, c, h: Math.max(o, c) * 1.003, l: Math.min(o, c) * 0.997 }; });
    const bt = runGridBacktest({ symbol: "ADA-USD", lowerPrice: 0.37, upperPrice: 0.43, levels: 13, marginUsd: 500, leverage: 5, mode: "ARITHMETIC" }, cs, rules, fees);
    expect(formatBacktest(bt)).toMatch(/round trips\s+\d+/);
    expect(formatRange(suggestRange(cs, fees)!)).toContain("ATR(14)");
    const fills = formatFills([{ timestamp: 0, symbol: "ADA-USD", side: "buy", price: "0.4", size: "100", role: "maker", fee: "0", client_order_id: "vektor-grid-a-1-e-0" }], 10);
    expect(fills).toContain("1 fills  volume $40.00  builder fees ≈ $0.04");
    expect(formatFills([], 10)).toBe("no vektor-tagged fills");
    const st = formatStatus({ uptimeSec: 5, lastEventAgoSec: 1, wallet: 100, telemetry: { fills: 2, volumeUsd: 50, builderFeesUsd: 0.05, ordersPlaced: 3 }, grids: { "ADA-USD": { range: [0.2, 0.3], resting: 4, fills: 2, cycles: 1, realizedUsd: 0.5, inventory: 0, builderFeesUsd: 0.05 } }, healths: [], shield: { log: [{ t: 0, level: "warn", symbol: "ADA-USD", msg: "Rule A" }] } });
    expect(st).toContain("ADA-USD  0.2–0.3  4");
    expect(st).toContain("WARN ADA-USD Rule A");
    expect(st).toContain("no open positions");
  });
});
