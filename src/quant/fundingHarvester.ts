// ── Funding Rate Harvester ──
//
// Strike pays funding HOURLY at HH:00 UTC; `r` on markPriceUpdate and
// GET /price/v2/premiumIndex is the hourly rate. Positive rate: longs pay
// shorts. A spot holder shorts the perp 1:1 to collect it with zero delta.
//
// funding payment per hour = −size × mark × rate   (signed size, + long)

import type { Market } from "../types/market";
import type { CreateOrderRequest } from "../types/order";
import { getMMR, getMaintenanceAmount } from "../math/marginTiers";
import { calculateIsolatedLiquidationPrice } from "../math/positionCalculations";
import { fix, snapDown, type MarketRules } from "./types";

export const HOURS_PER_YEAR = 24 * 365;

export interface FundingSnapshot {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  fundingRateHourly: number;
  nextFundingTime: number;
  openInterest?: number;
}

export interface FundingOpportunity {
  symbol: string;
  markPrice: number;
  fundingRateHourlyPct: number;
  annualizedAprPct: number; // |r| × 24 × 365 × 100
  basisPct: number; // (mark − index) / index × 100
  perpSide: "SHORT" | "LONG"; // side that RECEIVES funding
  dailyYieldPer10kUsd: number;
  nextFundingTime: number;
  hoursToNextFunding: number;
}

export function rankFundingOpportunities(snapshots: FundingSnapshot[], now = Date.now()): FundingOpportunity[] {
  return snapshots
    .filter((s) => s.markPrice > 0)
    .map((s) => {
      const r = s.fundingRateHourly;
      return {
        symbol: s.symbol,
        markPrice: s.markPrice,
        fundingRateHourlyPct: fix(r * 100, 5),
        annualizedAprPct: fix(Math.abs(r) * HOURS_PER_YEAR * 100, 2),
        basisPct: s.indexPrice > 0 ? fix(((s.markPrice - s.indexPrice) / s.indexPrice) * 100, 4) : 0,
        perpSide: (r >= 0 ? "SHORT" : "LONG") as "SHORT" | "LONG",
        dailyYieldPer10kUsd: fix(10_000 * Math.abs(r) * 24, 2),
        nextFundingTime: s.nextFundingTime,
        hoursToNextFunding: fix(Math.max(0, s.nextFundingTime - now) / 3_600_000, 2),
      };
    })
    .sort((a, b) => b.annualizedAprPct - a.annualizedAprPct);
}

export interface HedgePlanInput {
  symbol: string;
  spotQty: number; // units of the asset held in the user's own wallet
  markPrice: number;
  leverage: number; // 1..3 recommended
  slices: number; // sliced entry to limit impact
  market: Market | null;
  rules: MarketRules;
  perpSide: "SHORT" | "LONG";
  fundingRateHourly: number;
}

export interface HedgePlan {
  symbol: string;
  side: "SHORT" | "LONG";
  totalSize: number;
  notionalUsd: number;
  marginUsd: number;
  liquidationPrice: number; // isolated, from margin tiers
  liquidationDistancePct: number;
  hourlyFundingUsd: number;
  dailyFundingUsd: number;
  annualFundingUsd: number;
  slices: number;
  sliceSize: number;
  warnings: string[];
}

/** Size the offsetting perp leg and estimate its liquidation price from the market's margin tiers. */
export function buildHedgePlan(p: HedgePlanInput): HedgePlan {
  const warnings: string[] = [];
  const totalSize = fix(snapDown(p.spotQty, p.rules.stepSize), p.rules.basePrec);
  const notional = totalSize * p.markPrice;
  const marginUsd = notional / p.leverage;
  const signed = p.perpSide === "SHORT" ? -totalSize : totalSize;
  const mmr = getMMR(p.market, notional);
  const ma = getMaintenanceAmount(p.market, notional);
  const liq = totalSize > 0 ? calculateIsolatedLiquidationPrice(p.markPrice, signed, marginUsd, mmr, ma) : 0;
  const liqDist = liq > 0 ? (Math.abs(liq - p.markPrice) / p.markPrice) * 100 : 100;
  const hourly = notional * Math.abs(p.fundingRateHourly);
  const sliceSize = fix(snapDown(totalSize / Math.max(1, p.slices), p.rules.stepSize), p.rules.basePrec);

  if (totalSize <= 0) warnings.push("Spot quantity rounds to zero at the market step size");
  if (notional < p.rules.minNotional) warnings.push(`Notional $${notional.toFixed(2)} is below the $${p.rules.minNotional} minimum`);
  if (sliceSize * p.markPrice < p.rules.minNotional) warnings.push("Each slice is below min notional - use fewer slices");
  if (p.leverage > 3) warnings.push("Leverage above 3x leaves little room for a rally before the short is liquidated");
  if (p.perpSide === "LONG") warnings.push("Negative funding: a LONG perp collects it, but that is not a hedge for spot - directional exposure");

  return {
    symbol: p.symbol, side: p.perpSide, totalSize,
    notionalUsd: fix(notional, 2), marginUsd: fix(marginUsd, 2),
    liquidationPrice: fix(liq, p.rules.quotePrec), liquidationDistancePct: fix(liqDist, 2),
    hourlyFundingUsd: fix(hourly, 4), dailyFundingUsd: fix(hourly * 24, 2), annualFundingUsd: fix(hourly * HOURS_PER_YEAR, 2),
    slices: p.slices, sliceSize, warnings,
  };
}

/**
 * Sliced hedge entry as limit orders that cross the spread (IOC), one slice at
 * a time. Unlike Strike's /v2/algo/twap this carries X-Builder-Fee-Bps.
 */
export function buildHedgeSliceOrder(plan: HedgePlan, sliceIndex: number, markPrice: number, rules: MarketRules, slippageBps = 20): CreateOrderRequest {
  const remaining = fix(plan.totalSize - plan.sliceSize * sliceIndex, rules.basePrec);
  const size = sliceIndex === plan.slices - 1 ? remaining : plan.sliceSize;
  const isSell = plan.side === "SHORT";
  const limit = markPrice * (isSell ? 1 - slippageBps / 10000 : 1 + slippageBps / 10000);
  return {
    client_order_id: `vektor-hedge-${plan.symbol}-${sliceIndex}-${Date.now() % 100000}`,
    symbol: plan.symbol,
    side: isSell ? "sell" : "buy",
    type: "limit",
    size: String(size),
    price: String(fix(limit, rules.quotePrec)),
    time_in_force: "IOC",
  };
}

/** Rule C: funding has flipped against the hedge for N consecutive hours. */
export function fundingFlipped(history: number[], hedgeSide: "SHORT" | "LONG", consecutive = 2): boolean {
  if (history.length < consecutive) return false;
  const recent = history.slice(-consecutive);
  return hedgeSide === "SHORT" ? recent.every((r) => r < 0) : recent.every((r) => r > 0);
}
