/**
 * Vektor-specific Strike endpoints not covered by the reference app:
 * batch orders (builder fee honoured), premium index for every market,
 * and the native grid bot (for side-by-side comparison; no builder fee).
 */

import { API_BASE_URL, PRICE_API_URL } from "./config";
import { authenticatedFetch, throwApiError } from "./auth";
import type { CreateOrderRequest, CreateOrderResponse } from "../types/order";

export interface BatchOrdersResponse {
  successful: CreateOrderResponse[] | null;
  failed: { index: number; error: string }[] | null;
}

/** POST /v2/orders/batch — independent creates, X-Builder-Fee-Bps applies to every item. */
export async function placeBatchOrders(orders: CreateOrderRequest[], builderFeeBps?: number): Promise<BatchOrdersResponse> {
  const headers = builderFeeBps && builderFeeBps > 0 ? { "X-Builder-Fee-Bps": String(Math.floor(builderFeeBps)) } : undefined;
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/orders/batch`, "POST", { orders }, headers);
  if (!res.ok) return throwApiError(res, "Batch order failed");
  return res.json();
}

export interface ReplaceAllResponse {
  sequence_id: number;
  message_id: string;
  account_id: string;
  symbol: string;
  cancel_all: boolean;
  new_orders: CreateOrderResponse[] | null;
}

/**
 * POST /v2/orders/replace — ONE engine command: cancels every active order on
 * the symbol (TP/SL and native grid-bot orders too), then places `orders` in
 * order. Items must NOT carry `symbol`. If any create fails a static market
 * rule (tick, step, min notional, price bound) nothing is applied — no
 * cancels either — and that create is published as rejected on the user
 * stream. X-Builder-Fee-Bps is honoured.
 */
export async function replaceAllOrders(symbol: string, orders: Omit<CreateOrderRequest, "symbol">[], builderFeeBps?: number): Promise<ReplaceAllResponse> {
  const headers = builderFeeBps && builderFeeBps > 0 ? { "X-Builder-Fee-Bps": String(Math.floor(builderFeeBps)) } : undefined;
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/orders/replace`, "POST", { symbol, orders }, headers);
  if (!res.ok) return throwApiError(res, "Replace-all failed");
  return res.json();
}

export interface PremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  fundingRate: string; // hourly
  nextFundingTime: number;
  averagePremiumIndex: string;
}

/** GET /price/v2/premiumIndex (public) — all markets when no symbol is given. */
export async function getPremiumIndexAll(): Promise<PremiumIndex[]> {
  const res = await fetch(`${PRICE_API_URL}/v2/premiumIndex`);
  if (!res.ok) throw new Error(`premiumIndex failed: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}

/** GET /price/v2/openInterest — one-sided OI in base units. */
export async function getOpenInterest(symbol: string): Promise<number> {
  const res = await fetch(`${PRICE_API_URL}/v2/openInterest?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) return 0;
  const data = await res.json();
  return parseFloat(data.openInterest ?? "0") || 0;
}

/**
 * Mainnet klines (public). Testnet "last" candles are flat because nothing
 * trades there, so backtests always use mainnet history for the same symbol.
 */
export const MAINNET_PRICE_URL = "https://api.strikefinance.org/price";

export async function getMainnetKlines(symbol: string, interval: string, days: number): Promise<(string | number)[][]> {
  const end = Date.now();
  const start = end - days * 86_400_000;
  const params = new URLSearchParams({ symbol, interval, priceType: "last", startTime: String(start), endTime: String(end), limit: "1500" });
  const res = await fetch(`${MAINNET_PRICE_URL}/v2/klines?${params}`);
  if (!res.ok) throw new Error(`klines failed: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export interface NativeGridRequest {
  symbol: string;
  mode: "LONG" | "SHORT" | "NEUTRAL";
  lower_price: string;
  upper_price: string;
  grid_count: number;
  collateral: string;
}

/** POST /v2/grid/bot — Strike's server-side grid (arithmetic only, ignores builder fee). */
export async function createNativeGridBot(req: NativeGridRequest): Promise<{ bot_id: string; status: string }> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/grid/bot`, "POST", req);
  if (!res.ok) return throwApiError(res, "Grid bot create failed");
  return res.json();
}

export async function stopNativeGridBot(botId: string): Promise<{ bot_id: string; status: string }> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/grid/bot/${botId}`, "DELETE", { cancel_orders: true });
  if (!res.ok) return throwApiError(res, "Grid bot stop failed");
  return res.json();
}
