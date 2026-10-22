/**
 * History reads (API wallet auth). Lists come back as null when empty — always coalesce.
 *   GET /v2/history/fill     fills, newest first; since_trade_id = forward cursor
 *   GET /v2/history/funding  hourly funding payments (amount > 0 received)
 *   GET /v2/order            one order by client_order_id (404 = never existed / silently dropped)
 */

import { API_BASE_URL } from "./config";
import { authenticatedFetch, throwApiError } from "./auth";

export interface FillRow {
  id: number;
  trade_id: number;
  order_id: number;
  symbol: string;
  side: "buy" | "sell";
  role: "maker" | "taker" | "mixed";
  price: string;
  size: string;
  realized_pnl: string;
  fee: string;
  fee_type: string;
  timestamp: number;
  client_order_id?: string;
}

export interface FundingRow {
  id: number;
  symbol: string;
  position_size: string;
  position_side: "Long" | "Short";
  funding_rate: string;
  amount: string; // > 0 received, < 0 paid
  timestamp: number;
}

const qs = (p: Record<string, string | number | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
};

export async function getFillHistory(p: { symbol?: string; startTime?: number; since_trade_id?: number; limit?: number } = {}): Promise<FillRow[]> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/history/fill${qs({ limit: 1000, ...p })}`, "GET");
  if (!res.ok) return throwApiError(res, "Fill history failed");
  const data = await res.json();
  return data.fills ?? [];
}

export async function getFundingHistory(p: { symbol?: string; startTime?: number; limit?: number } = {}): Promise<FundingRow[]> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/history/funding${qs({ limit: 1000, ...p })}`, "GET");
  if (!res.ok) return throwApiError(res, "Funding history failed");
  const data = await res.json();
  return data.funding ?? [];
}

/** null when the order does not exist (silently dropped), otherwise its engine status. */
export async function getOrderStatus(symbol: string, clientOrderId: string): Promise<{ status: string; closeReason: string } | null> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/order${qs({ symbol, client_order_id: clientOrderId })}`, "GET");
  if (res.status === 404) return null;
  if (!res.ok) return throwApiError(res, "Get order failed");
  const o = await res.json();
  return { status: String(o.Status ?? "").toUpperCase(), closeReason: o.CloseReason ?? "" };
}
