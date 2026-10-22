/**
 * Public (unauthenticated) reads of another account's history using Strike's
 * public selectors: `account_id` (UUID) or `blockchain_address`. Verified on
 * mainnet: /v2/history/fill, /v2/history/funding, /v2/closedPositions return
 * 200 with `null` lists for an unknown UUID; /v2/positions returns 404
 * "account not found"; a malformed UUID is 400 "invalid account_id"; an
 * unknown address is 404 "user not found".
 */

import type { FillRow, FundingRow } from "./history";
import type { PositionResponse } from "../types/position";

export const MAINNET_API = "https://api.strikefinance.org";

export type PublicSelector = { account_id: string } | { blockchain_address: string; blockchain?: string };

export function selectorQuery(sel: PublicSelector): string {
  const u = new URLSearchParams();
  if ("account_id" in sel) u.set("account_id", sel.account_id);
  else { u.set("blockchain_address", sel.blockchain_address); if (sel.blockchain) u.set("blockchain", sel.blockchain); }
  return u.toString();
}

export interface PublicCall { path: string; url: string; status: number }

async function get<T>(base: string, path: string, calls: PublicCall[]): Promise<T> {
  const url = `${base}${path}`;
  const res = await fetch(url);
  calls.push({ path, url, status: res.status });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text }; }
  if (!res.ok) throw new Error(json.error ? `${json.error} (${res.status})` : `${res.status} on ${path}`);
  return json as T;
}

export interface ClosedPositionRow { symbol: string; realized_pnl?: string; size?: string; [k: string]: unknown }

/** Every fill on the account, newest first, paged with `fromId` (max `pages` × 1000). */
export async function getPublicFills(base: string, sel: PublicSelector, calls: PublicCall[], pages = 3): Promise<FillRow[]> {
  const out: FillRow[] = [];
  let fromId: number | undefined;
  for (let i = 0; i < pages; i++) {
    const q = `${selectorQuery(sel)}&limit=1000${fromId ? `&fromId=${fromId}` : ""}`;
    const data = await get<{ fills: FillRow[] | null }>(base, `/v2/history/fill?${q}`, calls);
    const rows = data.fills ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
    fromId = rows[rows.length - 1].id;
  }
  return out;
}

export async function getPublicFunding(base: string, sel: PublicSelector, calls: PublicCall[]): Promise<FundingRow[]> {
  const data = await get<{ funding: FundingRow[] | null }>(base, `/v2/history/funding?${selectorQuery(sel)}&limit=1000`, calls);
  return data.funding ?? [];
}

/** Open positions; 404 "account not found" is reported as an empty list. */
export async function getPublicPositions(base: string, sel: PublicSelector, calls: PublicCall[]): Promise<PositionResponse[]> {
  try {
    const data = await get<{ positions: PositionResponse[] | null }>(base, `/v2/positions?${selectorQuery(sel)}`, calls);
    return data.positions ?? [];
  } catch (e: any) {
    if (String(e.message).includes("404")) return [];
    throw e;
  }
}

export async function getPublicClosedPositions(base: string, sel: PublicSelector, calls: PublicCall[]): Promise<ClosedPositionRow[]> {
  const data = await get<{ positions: ClosedPositionRow[] | null }>(base, `/v2/closedPositions?${selectorQuery(sel)}&limit=200`, calls);
  return data.positions ?? [];
}

export const curlFor = (c: PublicCall) => `curl -s '${c.url}'`;
