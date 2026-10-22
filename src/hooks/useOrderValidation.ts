import { useMemo } from "react";
import type { Market } from "../types/market";
import type { Position } from "../types/position";
import {
  getMaxPositionSizeForLeverage,
  getMaxLeverageForNotional,
} from "../math/marginTiers";
import { isOnStepGrid } from "../math/formatUtils";

export interface OrderValidationParams {
  size: number; // in base asset
  side: "Long" | "Short";
  orderType: "market" | "limit";
  limitPrice: number;
  leverage: number;
  reduceOnly: boolean;
  market: Market | null;
  markPrice: number;
  availableBalance: number;
  positions: Position[];
  symbol: string;
  // Price the engine assumes for margin: limit → limit price;
  // market buy → bestAsk × 1.0005; market sell → max(bestBid, mark)
  assumedPrice?: number;
  openLossPerUnit?: number;
  allowPreTrade?: boolean; // account symbol setting allow_pre_trade
}

export interface OrderValidationResult {
  isValid: boolean;
  error: string | null;
}

/**
 * Validate an order against market constraints, balance, and tier limits.
 * Mirrors pkg/models/order.go ValidateOrderRules and the engine admission
 * path (services/engines/handlers/order_handler.go):
 *
 * 1. Market "trading" (or pre_trading with allow_pre_trade); market-wide reduce_only
 * 2. Min size: order_market_min_size for EVERY order type (skipped only for
 *    close_position; reduce-only sizes are checked after the engine clamps them)
 * 3. Max size: order_{limit|market}_max_size (a configured 0 rejects every order)
 * 4. Size grid: (size − min) multiple of step (limit: limit min/step; market: market min/step)
 * 5. Limit price: ≥ order_min_price, ≤ order_max_price when > 0, on the tick grid
 *    anchored at order_min_price, and buy ≤ mark×(1+bound) / sell ≥ mark×(1−bound)
 * 6. Min notional (not for reduce-only): market → size × mark, limit → size × limit price
 * 7. Tier cap: |position after order| × MARK ≤ max_notional of the leverage's tier
 * 8. Available balance: opening size × assumed price / leverage + OpenLoss
 *    (approximates TotalOrderCost(after) − TotalOrderCost(before) + OpenLoss)
 *
 * Error shows in the submit button text.
 */
export function useOrderValidation(
  params: OrderValidationParams
): OrderValidationResult {
  return useMemo(() => {
    const {
      size,
      side,
      orderType,
      limitPrice,
      leverage,
      reduceOnly,
      market,
      markPrice,
      availableBalance,
      positions,
      symbol,
      assumedPrice,
      openLossPerUnit = 0,
      allowPreTrade = false,
    } = params;

    // No size entered yet - not an error, just incomplete
    if (size <= 0) return { isValid: false, error: null };

    // 1. Market available
    if (!market) return { isValid: false, error: "Market not available" };
    if (market.status !== "trading" && !(market.status === "pre_trading" && allowPreTrade)) {
      return { isValid: false, error: `Market is ${market.status}` };
    }
    if (market.reduce_only && !reduceOnly) {
      return { isValid: false, error: "Market is reduce-only" };
    }

    const isLimit = orderType === "limit";
    if (markPrice <= 0 || (isLimit && limitPrice <= 0)) return { isValid: false, error: null };

    // 2. Min size - always the MARKET min size
    const minSize = parseFloat(market.order_market_min_size);
    if (size < minSize) {
      return { isValid: false, error: `Min size: ${minSize} ${market.base_asset}` };
    }

    // 3. Max size
    const maxSize = parseFloat(isLimit ? market.order_limit_max_size : market.order_market_max_size);
    if (size > maxSize) {
      return { isValid: false, error: `Max size: ${maxSize} ${market.base_asset}` };
    }

    // 4. Size grid anchored at the min size
    const stepSize = parseFloat(isLimit ? market.order_limit_step_size : market.order_market_step_size);
    const gridMin = parseFloat(isLimit ? market.order_limit_min_size : market.order_market_min_size);
    if (!isOnStepGrid(size, stepSize, gridMin)) {
      return { isValid: false, error: `Size must be ${gridMin} + a multiple of ${stepSize}` };
    }

    // 5. Limit price rules
    if (isLimit) {
      const minPrice = parseFloat(market.order_min_price || "0");
      const maxPrice = parseFloat(market.order_max_price || "0");
      const tick = parseFloat(market.order_tick_price || "0");
      if (limitPrice < minPrice) return { isValid: false, error: `Min price: ${minPrice}` };
      if (maxPrice > 0 && limitPrice > maxPrice) return { isValid: false, error: `Max price: ${maxPrice}` };
      if (!isOnStepGrid(limitPrice, tick, minPrice)) {
        return { isValid: false, error: `Price must be on the ${market.order_tick_price} tick grid` };
      }
      const priceBound = parseFloat(market.order_limit_price_bound || "0");
      if (priceBound > 0) {
        if (side === "Long" && limitPrice > markPrice * (1 + priceBound)) {
          return { isValid: false, error: "Buy price exceeds price cap" };
        }
        if (side === "Short" && limitPrice < markPrice * (1 - priceBound)) {
          return { isValid: false, error: "Sell price below price floor" };
        }
      }
    }

    // 6. Min notional (position-increasing orders only)
    if (!reduceOnly) {
      const notional = size * (isLimit ? limitPrice : markPrice);
      const minNotional = parseFloat(market.order_min_notional);
      if (notional < minNotional) {
        return { isValid: false, error: `Min order value: $${minNotional}` };
      }
    }

    // Existing position in this symbol (one-way mode)
    const existingPos = positions.find((p) => p.symbol === symbol);
    const sameDirectionSize =
      existingPos &&
      ((side === "Long" && existingPos.positionSide === "LONG") ||
        (side === "Short" && existingPos.positionSide === "SHORT"))
        ? existingPos.size
        : 0;
    const oppositeSize = existingPos && sameDirectionSize === 0 ? existingPos.size : 0;
    const strictlyReducing = oppositeSize > 0 && size <= oppositeSize;

    // 7. Tier cap / leverage at the resulting size (MARK price; skipped when strictly reducing)
    if (!strictlyReducing) {
      const resultingSize = Math.abs(sameDirectionSize + size - oppositeSize);
      const resultingNotional = resultingSize * markPrice;
      const tierMaxNotional = getMaxPositionSizeForLeverage(market, leverage);
      if (tierMaxNotional !== null && resultingNotional > tierMaxNotional) {
        const maxLev = getMaxLeverageForNotional(market, resultingNotional);
        return {
          isValid: false,
          error: `Position too large for ${leverage}x (max ${maxLev}x at this size)`,
        };
      }
    }

    // 8. Available balance (skipped for reduce-only / strictly reducing)
    if (!reduceOnly && !strictlyReducing) {
      const price = assumedPrice && assumedPrice > 0 ? assumedPrice : isLimit ? limitPrice : markPrice;
      const openingSize = Math.max(0, size - oppositeSize);
      const requiredMargin = (openingSize * price) / leverage + openingSize * openLossPerUnit;
      if (requiredMargin > availableBalance) {
        return { isValid: false, error: "Insufficient balance" };
      }
    }

    return { isValid: true, error: null };
  }, [params]);
}
