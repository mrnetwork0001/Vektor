import type { Position, CrossLiquidationContext } from "../types/position";
import type { Market } from "../types/market";
import { getMMR, getMaintenanceAmount } from "./marginTiers";
import { roundHalfEven } from "./formatUtils";

// Mirrors pkg/models/position.go (derived fields) and pkg/models/margin.go
// (margin profiles, bankruptcy/liquidation price). Floats are used for
// display; the backend uses exact decimals.

const quotePrec = (market?: Market | null) => market?.quote_prec ?? 8;

// ═══════════════════════════════════════════════════════════════════
// LIQUIDATION PRICE
// ═══════════════════════════════════════════════════════════════════

/**
 * Liquidation price for an ISOLATED position (profile W = iso_balance, TU = TM = 0).
 *
 * Formula:
 *   LP = (EP - (IsoBalance + MA) / Size) / (1 - Direction * MMR)
 *
 * @param entryPrice  - Entry price
 * @param size        - SIGNED size (+0.5 for Long, -0.5 for Short)
 * @param isoBalance  - Isolated margin balance
 * @param mmr         - Maintenance Margin Rate of the position's current tier
 * @param ma          - Maintenance Amount of that tier
 * @returns LP, or 0 when the result is <= 0 (no liquidation price). Not rounded.
 *
 * @example Long 0.5 BTC at $43,000, isoBalance=$1,075, mmr=0.004, ma=0:
 *   numerator = 43000 - (1075 + 0) / 0.5 = 40850
 *   denominator = 1 - 1 * 0.004 = 0.996
 *   LP = 40850 / 0.996 = $41,014.06
 *
 * @example Short 0.5 BTC at $43,000, isoBalance=$1,075, mmr=0.004, ma=0:
 *   numerator = 43000 - (1075 + 0) / (-0.5) = 45150
 *   denominator = 1 + 0.004 = 1.004
 *   LP = 45150 / 1.004 = $44,960.16
 */
export function calculateIsolatedLiquidationPrice(
  entryPrice: number,
  size: number,
  isoBalance: number,
  mmr: number,
  ma: number = 0
): number {
  if (size === 0) return 0;
  const direction = size > 0 ? 1 : -1;
  const lp = (entryPrice - (isoBalance + ma) / size) / (1 - direction * mmr);
  return Number.isFinite(lp) && lp > 0 ? lp : 0;
}

/**
 * Liquidation price for a CROSS position.
 *
 * Formula:
 *   LP = (EP - (W + TU - TM + MA) / Size) / (1 - Direction * MMR)
 *
 * Where:
 *   W  = WalletBalance - Σ(all isolated) IsoBalance
 *   TU = Σ uPnL of OTHER cross positions   (0 when this is the only cross position)
 *   TM = Σ MM of OTHER cross positions     (0 when this is the only cross position)
 *
 * @example Cross Long 0.5 BTC at $43,000. Wallet=$10,500. Other cross ETH uPnL=+$100, mm=$30.
 *   One isolated position isoBalance=$500. mmr=0.004, ma=$0.
 *   W = $10,000
 *   numerator = 43000 - (10000 + 100 - 30 + 0) / 0.5 = 22860
 *   LP = 22860 / 0.996 = $22,951.81
 */
export function calculateCrossLiquidationPrice(
  entryPrice: number,
  size: number,
  mmr: number,
  context: CrossLiquidationContext,
  ma: number = 0
): number {
  if (size === 0) return 0;
  const { walletBalance, totalIsolatedMargin, otherCrossUPnL, otherCrossMaintenanceMargin } = context;

  const W = walletBalance - totalIsolatedMargin;
  const direction = size > 0 ? 1 : -1;
  const lp =
    (entryPrice - (W + otherCrossUPnL - otherCrossMaintenanceMargin + ma) / size) /
    (1 - direction * mmr);
  return Number.isFinite(lp) && lp > 0 ? lp : 0;
}

/**
 * Bankruptcy price (margin balance reaches zero): BP = EP - (W + TU) / Size.
 * Same W/TU as the liquidation price; 0 when <= 0.
 */
export function calculateBankruptcyPrice(
  entryPrice: number,
  size: number,
  w: number,
  otherUPnL: number = 0
): number {
  if (size === 0) return 0;
  const bp = entryPrice - (w + otherUPnL) / size;
  return Number.isFinite(bp) && bp > 0 ? bp : 0;
}

// ═══════════════════════════════════════════════════════════════════
// POSITION DERIVED FIELDS
// ═══════════════════════════════════════════════════════════════════

/**
 * Derived fields for a position at the current mark price (backend
 * Position.UpdateDerived, rounded half-even to quote_prec):
 *
 *   uPnL     = (mark - entry) × signedSize
 *   notional = mark × |size|               (tier lookup uses the unrounded notional)
 *   IM       = notional / leverage         (position leverage)
 *   MM       = notional × MMR - MA
 *
 * UI-only fields (the backend does not serve them for open positions):
 *   currentMargin  isolated: iso_balance; cross: IM
 *   pnlPercentage  uPnL / (entry × |size| / leverage) × 100 — same margin base
 *                  as the backend's roi_pct on closing fills
 *   marginRatio    isolated: MM / (iso_balance + uPnL) × 100 (cross is set by
 *                  applyCrossLiquidationPrices from the shared cross profile)
 *
 * @example Long 0.5 BTC, entry=$43,000, mark=$43,500, isolated, isoBalance=$1,075, 20x:
 *   uPnL = (43500 - 43000) * 0.5 = +$250.00
 *   notional = 43500 * 0.5 = $21,750
 *   MM = 21750 * 0.004 - 0 = $87.00
 *   pnlPercentage = 250 / (43000 * 0.5 / 20) * 100 = +23.26%
 */
export function calculatePositionDerived(
  position: Position,
  markPrice: number,
  market?: Market
): Partial<Position> {
  if (!markPrice || markPrice <= 0 || position.size <= 0) {
    return {};
  }

  const prec = quotePrec(market);
  const { entryPrice, size, positionSide, marginMode, isoBalance, leverage } = position;
  const signedSize = positionSide === "LONG" ? size : -size;

  // The engine rounds the incoming mark to quote_prec before any risk math
  const mark = roundHalfEven(markPrice, prec);
  const rawNotional = mark * size; // tier lookup uses the unrounded notional
  const mmr = getMMR(market, rawNotional);
  const ma = getMaintenanceAmount(market, rawNotional);

  const uPnL = roundHalfEven((mark - entryPrice) * signedSize, prec);
  const notional = roundHalfEven(rawNotional, prec);
  const initialMargin = leverage > 0 ? roundHalfEven(rawNotional / leverage, prec) : 0;
  const maintenanceMargin = roundHalfEven(rawNotional * mmr - ma, prec);

  const isIsolated = marginMode === "isolated";
  const currentMargin = isIsolated ? isoBalance : initialMargin;

  const entryMargin = leverage > 0 ? (entryPrice * size) / leverage : 0;
  const pnlPercentage = entryMargin > 0 ? (uPnL / entryMargin) * 100 : 0;

  let marginRatio: number | undefined;
  let liquidationPrice: number | undefined;
  if (isIsolated) {
    const marginBalance = isoBalance + uPnL;
    marginRatio = marginBalance > 0 ? (maintenanceMargin / marginBalance) * 100 : Infinity;
    liquidationPrice = calculateIsolatedLiquidationPrice(entryPrice, signedSize, isoBalance, mmr, ma);
  }

  return {
    markPrice: mark,
    uPnL,
    notional,
    currentMargin,
    requiredMargin: isIsolated ? initialMargin : undefined,
    maintenanceMargin,
    pnlPercentage,
    marginRatio,
    liquidationPrice,
  };
}

/**
 * Enrich a position with all derived fields.
 */
export function enrichPositionWithDerived(
  position: Position,
  markPrice: number,
  market?: Market
): Position {
  return {
    ...position,
    ...calculatePositionDerived(position, markPrice, market),
  };
}

// ═══════════════════════════════════════════════════════════════════
// CROSS PROFILE (MULTI-POSITION)
// ═══════════════════════════════════════════════════════════════════

/**
 * Cross liquidation price and cross margin ratio for every cross position.
 * Must be called AFTER enrichPositionWithDerived for each position.
 *
 * Cross profile: W = wallet - Σ iso_balance, UPnL = Σ cross uPnL, MM = Σ cross MM.
 * Margin ratio = MM / (W + UPnL) (liquidation at >= 100%, reduce-only at >= 90%).
 *
 * @example
 *   const enriched = positions.map(p => enrichPositionWithDerived(p, markPrices[p.symbol], markets[p.symbol]));
 *   const final = applyCrossLiquidationPrices(enriched, walletBalance, markets);
 */
export function applyCrossLiquidationPrices(
  positions: Position[],
  walletBalance: number,
  markets: Record<string, Market>
): Position[] {
  let totalIsolatedMargin = 0;
  let totalCrossUPnL = 0;
  let totalCrossMaintenanceMargin = 0;

  for (const p of positions) {
    if (p.marginMode === "isolated") {
      totalIsolatedMargin += p.isoBalance ?? 0;
    } else {
      totalCrossUPnL += p.uPnL ?? 0;
      totalCrossMaintenanceMargin += p.maintenanceMargin ?? 0;
    }
  }

  const crossMarginBalance = walletBalance - totalIsolatedMargin + totalCrossUPnL;
  const crossMarginRatio =
    crossMarginBalance > 0 ? (totalCrossMaintenanceMargin / crossMarginBalance) * 100 : Infinity;

  return positions.map((p) => {
    if (p.marginMode !== "cross" || !p.notional) return p;

    const market = markets[p.symbol];
    const rawNotional = p.markPrice ? p.markPrice * p.size : p.notional; // unrounded for the tier
    const mmr = getMMR(market, rawNotional);
    const ma = getMaintenanceAmount(market, rawNotional);
    const signedSize = p.positionSide === "LONG" ? p.size : -p.size;

    const context: CrossLiquidationContext = {
      walletBalance,
      totalIsolatedMargin,
      otherCrossUPnL: totalCrossUPnL - (p.uPnL ?? 0),
      otherCrossMaintenanceMargin: totalCrossMaintenanceMargin - (p.maintenanceMargin ?? 0),
    };

    const liquidationPrice = calculateCrossLiquidationPrice(p.entryPrice, signedSize, mmr, context, ma);
    return { ...p, liquidationPrice, marginRatio: crossMarginRatio };
  });
}

// ═══════════════════════════════════════════════════════════════════
// PRE-TRADE LIQUIDATION ESTIMATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Estimate the liquidation price of a NEW position opened by an order, for the
 * immediate-liquidation check in the order form. (It ignores an existing
 * position in the same symbol, which the fill would merge into.)
 *
 * ISOLATED: the engine reserves, per opening fill,
 *   iso = size × fillPrice / leverage + OpenLoss, then enforces iso >= max(IM, MM) at mark.
 * CROSS: uses the cross profile of all other existing positions.
 *
 * Returns null if inputs are insufficient, 0 if there is no liquidation price.
 */
export function estimateOrderLiquidationPrice(params: {
  size: number;
  entryPrice: number;
  leverage: number;
  side: "Long" | "Short";
  markPrice: number;
  market: Market | null | undefined;
  marginMode: "Cross" | "Isolated";
  walletBalance: number;
  positions: Position[];
  symbol: string;
}): number | null {
  const {
    size, entryPrice, leverage, side, markPrice, market,
    marginMode, walletBalance, positions, symbol,
  } = params;

  if (!size || !entryPrice || !leverage || !market) return null;

  const signedSize = side === "Long" ? size : -size;
  const refPrice = markPrice > 0 ? markPrice : entryPrice;
  const notionalAtMark = size * refPrice;
  const mmr = getMMR(market, notionalAtMark);
  const ma = getMaintenanceAmount(market, notionalAtMark);

  if (marginMode === "Isolated") {
    const openLoss =
      markPrice > 0 ? size * Math.max(0, side === "Long" ? entryPrice - markPrice : markPrice - entryPrice) : 0;
    const reserve = (size * entryPrice) / leverage + openLoss;
    const im = notionalAtMark / leverage;
    const mm = notionalAtMark * mmr - ma;
    const isoBalance = Math.max(reserve, im, mm, 0);
    return calculateIsolatedLiquidationPrice(entryPrice, signedSize, isoBalance, mmr, ma);
  }

  let totalIsolatedMargin = 0;
  let otherCrossUPnL = 0;
  let otherCrossMaintenanceMargin = 0;
  for (const p of positions) {
    if (p.marginMode === "isolated") {
      totalIsolatedMargin += p.isoBalance ?? 0;
    } else if (p.symbol !== symbol) {
      otherCrossUPnL += p.uPnL ?? 0;
      otherCrossMaintenanceMargin += p.maintenanceMargin ?? 0;
    }
  }

  return calculateCrossLiquidationPrice(
    entryPrice,
    signedSize,
    mmr,
    { walletBalance, totalIsolatedMargin, otherCrossUPnL, otherCrossMaintenanceMargin },
    ma
  );
}
