/**
 * Order management endpoints (API wallet auth; trading-enabled sessions).
 *
 * All write endpoints are asynchronous: a 2xx response means the command was
 * sequenced, not that it executed. Fills, rejects and cancels arrive as
 * ORDER_TRADE_UPDATE on the user stream. Errors: { "error": "..." }.
 *
 * Builder fee: send X-Builder-Fee-Bps (0..100, not part of the signature) on
 * POST /v2/order, /v2/order/strategy, /v2/orders/batch, /v2/orders/replace and
 * /v2/order/replace-batch. It must be ≤ the user's approved fee_share_bps and
 * ≤ your builder's registered fee_share_bps, else 400. Omitted = 0 bps (fills
 * are still attributed to your builder code). POST /v2/order/replace does NOT
 * read the header - the replacement order carries no builder fee.
 */

import { API_BASE_URL } from "./config";
import { authenticatedFetch, throwApiError } from "./auth";
import type {
  CreateOrderRequest,
  CreateOrderResponse,
  CreateStrategyOrderRequest,
  CreateStrategyOrderResponse,
  CancelOrderRequest,
  CancelOrderResponse,
  CancelAllOrdersResponse,
  ReplaceOrderResponse,
} from "../types/order";

function builderFeeHeaders(builderFeeBps?: number): Record<string, string> | undefined {
  return builderFeeBps && builderFeeBps > 0
    ? { "X-Builder-Fee-Bps": String(Math.floor(builderFeeBps)) }
    : undefined;
}

/**
 * Place an order (HTTP 201, status always "pending").
 *
 * @example Market buy 0.5 BTC with a 10 bps builder fee:
 *   await placeOrder({ symbol: "BTC-USD", side: "buy", type: "market", size: "0.5" }, 10);
 *
 * @example Limit sell 1.0 ETH at $3,500:
 *   await placeOrder({
 *     symbol: "ETH-USD", side: "sell", type: "limit",
 *     size: "1.0", price: "3500.00", time_in_force: "GTC",
 *   });
 */
export async function placeOrder(
  params: CreateOrderRequest,
  builderFeeBps?: number
): Promise<CreateOrderResponse> {
  const res = await authenticatedFetch(
    `${API_BASE_URL}/v2/order`,
    "POST",
    params,
    builderFeeHeaders(builderFeeBps)
  );
  if (!res.ok) return throwApiError(res, "Place order failed");
  return res.json();
}

/**
 * Place a strategy order: primary order + single TP leg and/or single SL leg.
 * Legs take the opposite side and are always reduce-only.
 * With both legs: buy primary needs tp.stop_price ≥ sl.stop_price (sell: ≤).
 *
 * @example Market buy 0.5 BTC with TP at $45,000 and SL at $41,000:
 *   await placeStrategyOrder({
 *     strategy_id: crypto.randomUUID(),
 *     symbol: "BTC-USD", side: "buy", type: "market", size: "0.5",
 *     tp_order: { type: "take_profit", size: "0.5", stop_price: "45000", working_type: "mark_price" },
 *     sl_order: { type: "stop", size: "0.5", stop_price: "41000", working_type: "mark_price" },
 *   });
 */
export async function placeStrategyOrder(
  params: CreateStrategyOrderRequest,
  builderFeeBps?: number
): Promise<CreateStrategyOrderResponse> {
  const res = await authenticatedFetch(
    `${API_BASE_URL}/v2/order/strategy`,
    "POST",
    params,
    builderFeeHeaders(builderFeeBps)
  );
  if (!res.ok) return throwApiError(res, "Strategy order failed");
  return res.json();
}

/**
 * Cancel a single order by order_id or client_order_id (DELETE with JSON body).
 */
export async function cancelOrder(params: CancelOrderRequest): Promise<CancelOrderResponse> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/order/cancel`, "DELETE", params);
  if (!res.ok) return throwApiError(res, "Cancel order failed");
  return res.json();
}

/**
 * Cancel all orders (optionally for one symbol). A JSON body is required -
 * at minimum "{}" (an empty body is rejected).
 */
export async function cancelAllOrders(symbol?: string): Promise<CancelAllOrdersResponse> {
  const body: { symbol?: string } = {};
  if (symbol) body.symbol = symbol;

  const res = await authenticatedFetch(`${API_BASE_URL}/v2/order/cancel-all`, "DELETE", body);
  if (!res.ok) return throwApiError(res, "Cancel all failed");
  return res.json();
}

/**
 * Replace an order (cancel + create in one engine command).
 * Note: this endpoint ignores X-Builder-Fee-Bps.
 */
export async function replaceOrder(
  cancel: CancelOrderRequest,
  newOrder: CreateOrderRequest
): Promise<ReplaceOrderResponse> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/order/replace`, "POST", {
    cancel,
    new_order: newOrder,
  });
  if (!res.ok) return throwApiError(res, "Replace order failed");
  return res.json();
}

/**
 * Update leverage for a symbol (1..125, and ≤ the market's tier-1 max_leverage).
 * API wallet auth identifies the account - no account_id needed.
 */
export async function updateLeverage(
  symbol: string,
  leverage: number
): Promise<{ leverage: number; maxNotionalValue: string; symbol: string; request_id: string }> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/leverage`, "POST", { symbol, leverage });
  if (!res.ok) return throwApiError(res, "Update leverage failed");
  return res.json();
}

/**
 * Update margin mode for a symbol. Note the camelCase body key "marginMode".
 */
export async function updateMarginMode(
  symbol: string,
  marginMode: "cross" | "isolated"
): Promise<{ marginMode: string; symbol: string }> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/marginMode`, "POST", {
    symbol,
    marginMode,
  });
  if (!res.ok) return throwApiError(res, "Update margin mode failed");
  return res.json();
}
