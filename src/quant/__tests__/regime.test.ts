import { describe, it, expect } from "vitest";
import { assessRegime, type RegimeInputs } from "../regime";

const calm: RegimeInputs = { symbol: "ADA-USD", fearGreed: 50, openInterest: 100, oiBaseline: [100, 100, 100], high24h: 0.221, low24h: 0.219, last: 0.22, fundingRateHourly: 0.0000125, rangeFloorPct: 3 };

describe("regime guard", () => {
  it("calm market → RUN with a low score", () => {
    const r = assessRegime(calm);
    expect(r.level).toBe("CALM");
    expect(r.recommendation.action).toBe("RUN");
    expect(r.score).toBeLessThan(20);
    expect(r.reasons).toEqual(["No stress signals"]);
  });

  it("extreme fear alone forces at least ELEVATED → WIDEN", () => {
    const r = assessRegime({ ...calm, fearGreed: 12 });
    expect(r.level).toBe("ELEVATED");
    expect(r.recommendation.action).toBe("WIDEN");
    expect(r.recommendation.widenFactor).toBeGreaterThanOrEqual(1.25);
    expect(r.reasons[0]).toMatch(/extreme fear/);
  });

  it("24h range at 3× the floor forces EXTREME → PAUSE regardless of the rest", () => {
    const r = assessRegime({ ...calm, high24h: 0.24, low24h: 0.2184, last: 0.22 }); // 9.8% on a 3% floor
    expect(r.level).toBe("EXTREME");
    expect(r.recommendation.action).toBe("PAUSE");
    expect(r.raw.range24hPct).toBeCloseTo(9.818, 2);
  });

  it("OI shock and funding spike add up to EXTREME", () => {
    const r = assessRegime({ ...calm, fearGreed: 85, openInterest: 170, oiBaseline: [100, 100], fundingRateHourly: 0.00012, high24h: 0.23, low24h: 0.216 });
    expect(r.level).toBe("EXTREME");
    expect(r.components.oiShock).toBeGreaterThan(99);
    expect(r.components.funding).toBe(100);
    expect(r.reasons.some((x) => x.startsWith("Open interest +70"))).toBe(true);
    expect(r.raw.fundingAprPct).toBeCloseTo(105.12, 1);
  });

  it("tolerates missing inputs", () => {
    const r = assessRegime({ symbol: "X", fearGreed: null, openInterest: null, oiBaseline: [], high24h: null, low24h: null, last: null, fundingRateHourly: null });
    expect(r.level).toBe("CALM");
    expect(r.score).toBe(0);
    expect(r.raw).toEqual({ fearGreed: null, oiDeltaPct: null, range24hPct: null, fundingAprPct: null });
  });

  it("widenFactor scales from 1.25 to 1.75 across the ELEVATED band", () => {
    const lo = assessRegime({ ...calm, fearGreed: 24 }); // forced elevated at low score
    const hi = assessRegime({ ...calm, fearGreed: 2, openInterest: 140, oiBaseline: [100], high24h: 0.228, low24h: 0.214 });
    expect(lo.recommendation.widenFactor).toBe(1.25);
    expect(hi.level).not.toBe("CALM");
    if (hi.recommendation.widenFactor) expect(hi.recommendation.widenFactor).toBeGreaterThan(lo.recommendation.widenFactor!);
  });
});
