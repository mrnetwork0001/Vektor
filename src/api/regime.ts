/**
 * Public market-regime inputs (price service, no auth):
 *   GET /v2/fearGreed      → { status, data: { value 0..100, classification, timestamp, components } }
 *   GET /v2/openInterest   → [{ symbol, openInterest (one-sided base units), time }]  (no symbol = all)
 *   GET /v2/ticker/24hr    → [{ symbol, openPrice, highPrice, lowPrice, lastPrice, priceChangePercent, volume, quoteVolume }]
 * Every fetcher returns null / [] on failure so the hook never throws.
 */

import { PRICE_API_URL } from "./config";

export interface FearGreed {
  value: number; // 0..100
  classification: string; // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  timestamp: number;
  components: { momentum: number; breadth: number; volatility: number };
  marketsCounted: number;
}

export interface OpenInterestRow { symbol: string; openInterest: number; time: number }

export interface Ticker24h {
  symbol: string;
  open: number;
  high: number;
  low: number;
  last: number;
  changePct: number;
  volume: number;
  quoteVolume: number;
}

const num = (v: unknown) => { const n = parseFloat(String(v ?? "")); return Number.isFinite(n) ? n : 0; };

export async function getFearGreed(): Promise<FearGreed | null> {
  try {
    const res = await fetch(`${PRICE_API_URL}/v2/fearGreed`);
    if (!res.ok) return null; // 503 before the first reading
    const j = await res.json();
    const d = j?.data;
    if (!d || typeof d.value !== "number") return null;
    return {
      value: d.value, classification: String(d.classification ?? ""), timestamp: Number(d.timestamp ?? 0),
      components: { momentum: num(d.components?.momentum), breadth: num(d.components?.breadth), volatility: num(d.components?.volatility) },
      marketsCounted: Number(d.marketsCounted ?? 0),
    };
  } catch { return null; }
}

export async function getOpenInterestAll(): Promise<OpenInterestRow[]> {
  try {
    const res = await fetch(`${PRICE_API_URL}/v2/openInterest`);
    if (!res.ok) return [];
    const j = await res.json();
    return (Array.isArray(j) ? j : [j]).map((r: any) => ({ symbol: String(r.symbol), openInterest: num(r.openInterest), time: Number(r.time ?? 0) }));
  } catch { return []; }
}

export async function getTickers24h(): Promise<Ticker24h[]> {
  try {
    const res = await fetch(`${PRICE_API_URL}/v2/ticker/24hr`);
    if (!res.ok) return [];
    const j = await res.json();
    return (Array.isArray(j) ? j : [j]).map((r: any) => ({
      symbol: String(r.symbol), open: num(r.openPrice), high: num(r.highPrice), low: num(r.lowPrice), last: num(r.lastPrice),
      changePct: num(r.priceChangePercent), volume: num(r.volume), quoteVolume: num(r.quoteVolume),
    }));
  } catch { return []; }
}
