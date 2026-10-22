/**
 * Account and data fetching endpoints.
 *
 * With API wallet auth, the server identifies the account from the
 * X-API-Wallet-Public-Key header — no account_id param needed.
 * Market rules (tick/lot/notional filters, margin tiers) come from
 * GET /v2/markets on the API host.
 */

import { API_BASE_URL, PRICE_API_URL } from "./config";
import { authenticatedFetch, throwApiError } from "./auth";
import type {
  Account,
  FeeTiersResponse,
  PortfolioFeeInfo,
  SymbolsResponse,
} from "../types/account";
import type { Market, MarketsResponse, OrderBookDepthResponse } from "../types/market";
import type { PositionResponse } from "../types/position";
import type { OpenOrder } from "../types/order";
import type { MarkPriceUpdate } from "../types/ws";

/** GET /v2/account — balances, settings and sub-accounts (flat JSON object). */
export async function getAccount(): Promise<Account> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/account`, "GET");
  if (!res.ok) return throwApiError(res, "Get account failed");
  return res.json();
}

/** GET /v2/symbols — effective margin mode + leverage for every listed market. */
export async function getSymbols(): Promise<SymbolsResponse> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/symbols`, "GET");
  if (!res.ok) return throwApiError(res, "Get symbols failed");
  return res.json();
}

/** GET /v2/markets (public) → { markets: { [symbol]: Market } }. */
export async function getMarkets(): Promise<Record<string, Market>> {
  const res = await fetch(`${API_BASE_URL}/v2/markets`);
  if (!res.ok) throw new Error(`Get markets failed: ${res.status}`);
  const data: MarketsResponse = await res.json();
  return data.markets;
}

/** GET /v2/positions → { positions, count }. Sizes are signed strings. */
export async function getPositions(): Promise<PositionResponse[]> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/positions`, "GET");
  if (!res.ok) return throwApiError(res, "Get positions failed");
  const data: { positions: PositionResponse[]; count: number } = await res.json();
  return data.positions ?? [];
}

/** GET /v2/openOrders → { orders, count } (engine order model, PascalCase keys). */
export async function getOpenOrders(symbol?: string): Promise<OpenOrder[]> {
  const qs = symbol ? `?symbol=${encodeURIComponent(symbol)}` : "";
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/openOrders${qs}`, "GET");
  if (!res.ok) return throwApiError(res, "Get open orders failed");
  const data: { orders: OpenOrder[]; count: number } = await res.json();
  return data.orders ?? [];
}

/**
 * Order book snapshot (public, price service). limit default 20, max 1000.
 * The WS depth stream sends top-20 diffs, so seed it with limit=20.
 */
export async function getDepth(symbol: string, limit: number = 20): Promise<OrderBookDepthResponse> {
  const res = await fetch(
    `${PRICE_API_URL}/v2/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`
  );
  if (!res.ok) throw new Error(`Get depth failed: ${res.status}`);
  return res.json();
}

/**
 * Mark price snapshot (public, price service).
 * With symbol → one markPriceUpdate object; without → array for all symbols.
 */
export async function getMarkPrice(symbol: string): Promise<MarkPriceUpdate> {
  const res = await fetch(`${PRICE_API_URL}/v2/markPrice?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`Get mark price failed: ${res.status}`);
  return res.json();
}

/**
 * Kline rows (public, price service). Each row is an array:
 *   [openTime, open, high, low, close, volume, closeTime, quoteVolume,
 *    trades, takerBuyBase, takerBuyQuote, ignore]   (prices/volumes are strings)
 *
 * @param interval  - 1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1M
 * @param startTime - Unix ms
 * @param endTime   - Unix ms
 * @param limit     - default 500, max 1500
 * @param priceType - "last" (default on the server) | "mark" | "index"
 */
export async function getKlines(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number,
  limit: number = 500,
  priceType: "last" | "mark" | "index" = "mark"
): Promise<(string | number)[][]> {
  const params = new URLSearchParams({
    symbol,
    interval,
    priceType,
    startTime: startTime.toString(),
    endTime: endTime.toString(),
    limit: Math.min(limit, 1500).toString(),
  });
  const res = await fetch(`${PRICE_API_URL}/v2/klines?${params}`);
  if (!res.ok) throw new Error(`Get klines failed: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/** GET /v2/fee-tiers (public) → { feeTiers, makerRebateTiers, stakingFeeDiscountTiers, referralTiers? }. */
export async function getFeeTiers(): Promise<FeeTiersResponse> {
  const res = await fetch(`${API_BASE_URL}/v2/fee-tiers`);
  if (!res.ok) throw new Error(`Get fee tiers failed: ${res.status}`);
  return res.json();
}

/**
 * GET /v2/portfolio — account summary. Typed here only for the fee fields
 * (fee_tier, fee_tiers, maker_fee_rate_override, discounts) used to estimate fees.
 */
export async function getPortfolio(): Promise<PortfolioFeeInfo> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/portfolio`, "GET");
  if (!res.ok) return throwApiError(res, "Get portfolio failed");
  return res.json();
}
