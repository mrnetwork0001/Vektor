import type { Position } from "../types/position";
import type { Market } from "../types/market";
import type { OrderRow } from "../types/order";
import { roundHalfEven } from "./formatUtils";

// Mirrors pkg/models/balance.go, pkg/models/margin.go (TotalOrderCost) and the
// API balance snapshot (services/api/controller/api.go loadAccountBalanceSnapshot).

// ═══════════════════════════════════════════════════════════════════
// OPEN ORDER COSTS (Total Order Cost, per symbol)
// ═══════════════════════════════════════════════════════════════════

/**
 * Margin locked by open orders, summed over symbols.
 *
 * Per symbol, over pending/open LIMIT and MARKET orders only (untriggered
 * conditional orders are excluded until they trigger):
 *   bid = Σ price × remaining (buys), ask = Σ price × remaining (sells)
 *   f   = max(bid, ask − 2×notional)  if the position is long or flat
 *   f   = max(ask, bid − 2×notional)  if the position is short
 *   TotalOrderCost = round(f / symbolLeverage, quote_prec) [+ opening fee reserve]
 *
 * Not included here: the opening-fee reserve that the engine adds for ordinary
 * (non-reduce-only) orders on ISOLATED symbols
 * (remaining × execPrice × (2×max(maker, taker) + builderBps/10000)).
 *
 * @param leverageBySymbol - effective symbol leverage (GET /v2/symbols)
 */
export function calculateOpenOrderCosts(
  orders: OrderRow[],
  positions: Position[],
  leverageBySymbol: Record<string, number>,
  markets: Record<string, Market>
): number {
  if (!orders.length) return 0;

  const symbolAgg: Record<string, { bidNotional: number; askNotional: number }> = {};

  for (const order of orders) {
    const type = order.Type.toUpperCase();
    const status = order.Status.toUpperCase();
    // REST: "pending"/"open"; WS: "NEW"/"OPEN" (NEW also covers untriggered, excluded by type)
    if (type !== "LIMIT" && type !== "MARKET") continue;
    if (status !== "PENDING" && status !== "OPEN" && status !== "NEW") continue;

    const remaining = Math.max(0, parseFloat(order.Size || "0") - parseFloat(order.Filled || "0"));
    const price = parseFloat(order.Price || "0");
    if (remaining <= 0 || price <= 0) continue;

    const notional = remaining * price;
    const agg = (symbolAgg[order.Symbol] ??= { bidNotional: 0, askNotional: 0 });
    if (order.Side.toUpperCase() === "BUY") agg.bidNotional += notional;
    else agg.askNotional += notional;
  }

  let total = 0;
  for (const [sym, { bidNotional, askNotional }] of Object.entries(symbolAgg)) {
    const position = positions.find((p) => p.symbol === sym);
    const direction = position ? (position.positionSide === "LONG" ? 1 : -1) : 0;
    const notionalTwice = 2 * (position?.notional ?? 0);

    let f: number;
    if (direction >= 0 && position) {
      f = askNotional <= notionalTwice ? bidNotional : Math.max(bidNotional, askNotional - notionalTwice);
    } else if (direction < 0) {
      f = bidNotional <= notionalTwice ? askNotional : Math.max(askNotional, bidNotional - notionalTwice);
    } else {
      f = Math.max(bidNotional, askNotional);
    }

    const leverage = leverageBySymbol[sym] || markets[sym]?.default_leverage || 1;
    total += roundHalfEven(f / leverage, markets[sym]?.quote_prec ?? 8);
  }

  return total;
}

// ═══════════════════════════════════════════════════════════════════
// BALANCE METRICS
// ═══════════════════════════════════════════════════════════════════

/**
 * Account balance metrics (CALCULATION_SPECS.md, pkg/models/balance.go):
 *
 *   BaseBalance    = wallet − Σ TotalOrderCost − Σ(isolated) iso_balance
 *   Available      = BaseBalance − Σ(cross) IM + Σ(cross) uPnL          (not clamped)
 *   Withdrawable   = max(0, BaseBalance − max(Σ(cross) IM − Σ(cross) uPnL, Σ(cross) MM))
 *                    then min(…, wallet − lockedRewards) when lockedRewards > 0
 *   MarginBalance  = wallet − Σ(isolated) iso_balance + Σ(cross) uPnL   (cross margin balance)
 *
 * REST GET /v2/account additionally subtracts copy-trading holds from
 * available_balance (and the withdraw quote from the withdraw cap).
 *
 * @example
 *   wallet = $10,500; isolated iso = $1,075; cross IM = $1,000, uPnL = +$200, MM = $45
 *   openOrderCosts = $500
 *   base = 10,500 − 500 − 1,075 = $8,925
 *   available = 8,925 − 1,000 + 200 = $8,125
 *   withdrawable = max(0, 8,925 − max(800, 45)) = $8,125
 *   marginBalance = 10,500 − 1,075 + 200 = $9,625
 */
export function calculateBalances(
  walletBalance: number,
  positions: Position[],
  openOrderCosts: number = 0,
  lockedRewards: number = 0
) {
  let totalIsolatedMargin = 0;
  let crossInitialMargin = 0;
  let crossUPnL = 0;
  let crossMaintenanceMargin = 0;
  let totalUnrealizedPnL = 0;
  let totalInitialMargin = 0;
  let totalMaintenanceMargin = 0;

  for (const p of positions) {
    const im = p.marginMode === "isolated" ? p.requiredMargin ?? 0 : p.currentMargin ?? 0;
    totalUnrealizedPnL += p.uPnL ?? 0;
    totalInitialMargin += im;
    totalMaintenanceMargin += p.maintenanceMargin ?? 0;
    if (p.marginMode === "isolated") {
      totalIsolatedMargin += p.isoBalance ?? 0;
    } else {
      crossInitialMargin += im;
      crossUPnL += p.uPnL ?? 0;
      crossMaintenanceMargin += p.maintenanceMargin ?? 0;
    }
  }

  const baseBalance = walletBalance - openOrderCosts - totalIsolatedMargin;
  const availableBalance = baseBalance - crossInitialMargin + crossUPnL;

  let withdrawableBalance = Math.max(
    0,
    baseBalance - Math.max(crossInitialMargin - crossUPnL, crossMaintenanceMargin)
  );
  if (lockedRewards > 0) {
    withdrawableBalance = Math.max(0, Math.min(withdrawableBalance, walletBalance - lockedRewards));
  }

  const marginBalance = walletBalance - totalIsolatedMargin + crossUPnL;

  return {
    marginBalance, // = /v2/account margin_balance
    availableBalance, // = /v2/account available_balance (before copy holds)
    withdrawableBalance,
    totalUnrealizedPnL, // = /v2/account unrealized_pnl
    totalInitialMargin, // = /v2/account position_initial_margin
    totalMaintenanceMargin, // = /v2/account maintenance_margin
  };
}
