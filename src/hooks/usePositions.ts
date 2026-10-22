import { useMemo } from "react";
import type { Position } from "../types/position";
import type { Market } from "../types/market";
import type { MarkPriceUpdate } from "../types/ws";
import type { SymbolsResponse } from "../types/account";
import {
  enrichPositionWithDerived,
  applyCrossLiquidationPrices,
} from "../math/positionCalculations";

/**
 * Enrich positions with all derived fields using live mark prices.
 * Recalculates on every mark price change.
 *
 * Leverage: REST /v2/positions and WS ACCOUNT_UPDATE both carry the position's
 * leverage; if missing, fall back to the effective symbol leverage from
 * GET /v2/symbols, then the market default.
 */
export function useEnrichedPositions(
  positions: Position[],
  prices: Record<string, MarkPriceUpdate>,
  markets: Record<string, Market>,
  walletBalance: number,
  symbols?: SymbolsResponse | null
): Position[] {
  return useMemo(() => {
    const basicEnriched = positions.map((position) => {
      const symbol = position.symbol;
      const markPriceData = prices[symbol];
      const market = markets[symbol];
      const markPrice = markPriceData
        ? parseFloat(markPriceData.p)
        : parseFloat(market?.mark_price ?? "0");

      const leverage =
        position.leverage ||
        symbols?.symbol_settings?.[symbol]?.leverage ||
        market?.default_leverage ||
        1;

      return enrichPositionWithDerived({ ...position, leverage }, markPrice, market);
    });

    // Cross liquidation prices + cross margin ratio need the whole cross profile
    return applyCrossLiquidationPrices(basicEnriched, walletBalance, markets);
  }, [positions, prices, markets, walletBalance, symbols]);
}
