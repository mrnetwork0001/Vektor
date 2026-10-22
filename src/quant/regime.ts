// ── Market regime guard ──
//
// Scores how hostile the market is to a resting grid and recommends RUN,
// WIDEN (scale the range) or PAUSE (stop placing new rungs). Pure; the hook
// feeds it live inputs and a rolling open-interest baseline.
//
// Score components (each 0..100, weighted into one 0..100 score):
//   sentiment  F&G distance from 50: |v−50|/50 × 100          weight 0.30
//   oiShock    |OI − baseline| / baseline, 50% shock = 100     weight 0.25
//   range24h   (high−low)/last vs a per-market ATR-ish floor   weight 0.30
//              100 at 3× the floor (floor default 2% = ~1 day of ADA/SOL vol)
//   funding    |hourly rate| vs 0.0001/h (= 87.6% APR) = 100   weight 0.15
//
// Levels: score < 40 CALM → RUN · 40..70 ELEVATED → WIDEN (1.25..1.75×) ·
// ≥ 70 EXTREME → PAUSE. F&G alone in an extreme band (< 25 or > 75) forces
// at least ELEVATED; range24h ≥ 3× floor alone forces EXTREME.

import { fix } from "./types";

export type RegimeLevel = "CALM" | "ELEVATED" | "EXTREME";
export type RegimeAction = "RUN" | "WIDEN" | "PAUSE";

export interface RegimeInputs {
  symbol: string;
  fearGreed: number | null; // 0..100
  openInterest: number | null; // current one-sided OI, base units
  oiBaseline: number[]; // previous samples (oldest → newest), excluding the current one
  high24h: number | null;
  low24h: number | null;
  last: number | null;
  fundingRateHourly: number | null;
  rangeFloorPct?: number; // "normal" 24h range for this market, default 2%
}

export interface RegimeAssessment {
  symbol: string;
  level: RegimeLevel;
  score: number; // 0..100
  reasons: string[];
  recommendation: { action: RegimeAction; widenFactor?: number };
  components: { sentiment: number; oiShock: number; range24h: number; funding: number };
  raw: { fearGreed: number | null; oiDeltaPct: number | null; range24hPct: number | null; fundingAprPct: number | null };
}

export const THRESHOLDS = {
  fgExtremeLow: 25, fgExtremeHigh: 75,
  oiShockFullPct: 50, // ±50% vs baseline = component 100
  rangeFloorPct: 2, rangeExtremeMultiple: 3,
  fundingFullHourly: 0.0001,
  elevatedScore: 40, extremeScore: 70,
  weights: { sentiment: 0.3, oiShock: 0.25, range24h: 0.3, funding: 0.15 },
} as const;

const clamp = (v: number) => Math.max(0, Math.min(100, v));

export function assessRegime(i: RegimeInputs): RegimeAssessment {
  const T = THRESHOLDS;
  const reasons: string[] = [];

  // Sentiment
  const sentiment = i.fearGreed == null ? 0 : clamp((Math.abs(i.fearGreed - 50) / 50) * 100);
  const fgExtreme = i.fearGreed != null && (i.fearGreed < T.fgExtremeLow || i.fearGreed > T.fgExtremeHigh);
  if (fgExtreme) reasons.push(`Fear & Greed ${i.fearGreed} (${i.fearGreed! < 50 ? "extreme fear" : "extreme greed"})`);

  // Open-interest shock vs rolling baseline
  let oiDeltaPct: number | null = null;
  let oiShock = 0;
  if (i.openInterest != null && i.oiBaseline.length) {
    const base = i.oiBaseline.reduce((a, b) => a + b, 0) / i.oiBaseline.length;
    if (base > 0) {
      oiDeltaPct = fix(((i.openInterest - base) / base) * 100, 2);
      oiShock = clamp((Math.abs(oiDeltaPct) / T.oiShockFullPct) * 100);
      if (Math.abs(oiDeltaPct) >= T.oiShockFullPct / 2) reasons.push(`Open interest ${oiDeltaPct > 0 ? "+" : ""}${oiDeltaPct}% vs baseline`);
    }
  }

  // Realised 24h range
  const floor = i.rangeFloorPct ?? T.rangeFloorPct;
  let range24hPct: number | null = null;
  let range24h = 0;
  if (i.high24h != null && i.low24h != null && i.last && i.last > 0 && i.high24h >= i.low24h) {
    range24hPct = fix(((i.high24h - i.low24h) / i.last) * 100, 3);
    range24h = clamp((range24hPct / (floor * T.rangeExtremeMultiple)) * 100);
    if (range24hPct >= floor * 1.5) reasons.push(`24h range ${range24hPct}% (${fix(range24hPct / floor, 1)}× normal)`);
  }
  const rangeExtreme = range24hPct != null && range24hPct >= floor * T.rangeExtremeMultiple;

  // Funding spike
  const fundingAprPct = i.fundingRateHourly == null ? null : fix(i.fundingRateHourly * 24 * 365 * 100, 2);
  const funding = i.fundingRateHourly == null ? 0 : clamp((Math.abs(i.fundingRateHourly) / T.fundingFullHourly) * 100);
  if (funding >= 50) reasons.push(`Funding ${fundingAprPct}% APR`);

  const score = fix(
    sentiment * T.weights.sentiment + oiShock * T.weights.oiShock + range24h * T.weights.range24h + funding * T.weights.funding,
    1
  );

  let level: RegimeLevel = score >= T.extremeScore ? "EXTREME" : score >= T.elevatedScore ? "ELEVATED" : "CALM";
  if (rangeExtreme) level = "EXTREME";
  else if (fgExtreme && level === "CALM") level = "ELEVATED";

  const recommendation: RegimeAssessment["recommendation"] =
    level === "EXTREME" ? { action: "PAUSE" }
      : level === "ELEVATED" ? { action: "WIDEN", widenFactor: fix(1.25 + 0.5 * Math.min(1, Math.max(0, (score - T.elevatedScore) / (T.extremeScore - T.elevatedScore))), 2) }
        : { action: "RUN" };

  if (!reasons.length) reasons.push(level === "CALM" ? "No stress signals" : "Composite score elevated");

  return {
    symbol: i.symbol, level, score, reasons, recommendation,
    components: { sentiment: fix(sentiment, 1), oiShock: fix(oiShock, 1), range24h: fix(range24h, 1), funding: fix(funding, 1) },
    raw: { fearGreed: i.fearGreed, oiDeltaPct, range24hPct, fundingAprPct },
  };
}

/** Per-market "normal" 24h range used as the floor; everything else falls back to the default. */
export const RANGE_FLOOR_PCT: Record<string, number> = { "BTC-USD": 1.5, "ETH-USD": 2, "SOL-USD": 3, "ADA-USD": 3 };
