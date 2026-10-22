import type { FeeTiersResponse, PortfolioFeeInfo } from "../types/account";
import { roundHalfEven } from "./formatUtils";

// Mirrors the engine fee path (services/engines/handlers/order_handler.go):
//   commission = round(fillPrice × fillSize × rate, quote_prec)   (half-even)
//   rate       = maker_fee_rate_override for maker fills when set (final, may be a rebate)
//              = bracketRate × (1 − referralDiscount) × (1 − stakingDiscount)
//                (discounts only apply to positive rates)
//   builderFee = floor(fillPrice × fillSize × builderBps / 10000, 2 decimals)  — charged on every fill

export interface FeeRates {
  takerRate: number;
  makerRate: number;
}

/**
 * Fallback only, used until rates are fetched. Rates differ per deployment
 * (e.g. mainnet tier 0 maker is −0.00005, a rebate): seed from GET /v2/fee-tiers
 * tier 0 (tierZeroFeeRates), then the account's own tier from GET /v2/portfolio.
 */
export const DEFAULT_FEE_RATES: FeeRates = { takerRate: 0.0005, makerRate: 0 };

/** Tier-0 rates from GET /v2/fee-tiers (public). */
export function tierZeroFeeRates(res: FeeTiersResponse): FeeRates | null {
  const t0 = res.feeTiers?.find((t) => t.Tier === 0) ?? res.feeTiers?.[0];
  return t0 ? { takerRate: t0.TakerRate, makerRate: t0.MakerRate } : null;
}

/**
 * Effective taker/maker rates for an account from GET /v2/portfolio
 * (fee_tier, fee_tiers, maker_fee_rate_override, fee_discount_rate, staking_fee_discount_rate).
 * fee_discount_rate is the referral discount rounded to a whole percent, so
 * the result is an estimate.
 */
export function effectiveFeeRates(info: PortfolioFeeInfo): FeeRates {
  const tier = info.fee_tiers?.find((t) => t.Tier === info.fee_tier) ?? info.fee_tiers?.[0];
  if (!tier) return DEFAULT_FEE_RATES;

  const referral = (info.fee_discount_rate ?? 0) / 100;
  const staking = parseFloat(info.staking_fee_discount_rate || "0") || 0;
  const discount = (rate: number) => (rate > 0 ? rate * (1 - referral) * (1 - staking) : rate);

  const override = info.maker_fee_rate_override;
  return {
    takerRate: discount(tier.TakerRate),
    makerRate: override != null && override !== "" ? parseFloat(override) : discount(tier.MakerRate),
  };
}

/** Trading commission for a fill (negative = maker rebate). */
export function estimateCommission(notional: number, rate: number, quotePrec: number): number {
  return roundHalfEven(notional * rate, quotePrec);
}

/** Builder fee for a fill: floor(notional × bps / 10000, 2 decimals). */
export function estimateBuilderFee(notional: number, builderFeeBps: number): number {
  if (builderFeeBps <= 0 || notional <= 0) return 0;
  return Math.floor(((notional * builderFeeBps) / 10000) * 100) / 100;
}
