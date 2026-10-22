// ── CLOB Whale-Wall & Imbalance Radar ──
//
// Reads the locally maintained top-20 book (GET /price/v2/depth seeded,
// <symbol>@depth diffs applied by usePriceStream) and flags levels holding
// more than `wallMultiple` × the average level notional.

import type { OrderBookDepthResponse } from "../types/market";
import { estimateMarketFillPrice } from "../math/orderBookUtils";
import { fix } from "./types";

export interface WhaleWall {
  side: "BID" | "ASK";
  price: number;
  size: number;
  notionalUsd: number;
  multipleOfAvg: number;
}

export interface DepthAnalysis {
  bidNotionalUsd: number;
  askNotionalUsd: number;
  bidImbalancePct: number; // 50 = balanced, >50 = more bids
  pressure: "BID_HEAVY" | "ASK_HEAVY" | "BALANCED";
  walls: WhaleWall[];
  bestBid: number;
  bestAsk: number;
  spreadPct: number;
}

export function analyzeDepth(depth: OrderBookDepthResponse | null, wallMultiple = 2.5): DepthAnalysis | null {
  if (!depth || !depth.bids?.length || !depth.asks?.length) return null;
  const parse = (lv: string[][], side: "BID" | "ASK") =>
    lv.map(([p, q]) => ({ side, price: parseFloat(p), size: parseFloat(q), notionalUsd: parseFloat(p) * parseFloat(q) }));
  const bids = parse(depth.bids, "BID");
  const asks = parse(depth.asks, "ASK");
  const bidN = bids.reduce((a, l) => a + l.notionalUsd, 0);
  const askN = asks.reduce((a, l) => a + l.notionalUsd, 0);
  const total = bidN + askN || 1;
  const avg = total / (bids.length + asks.length);
  const walls: WhaleWall[] = [...bids, ...asks]
    .filter((l) => l.notionalUsd >= avg * wallMultiple)
    .map((l) => ({ ...l, notionalUsd: fix(l.notionalUsd, 0), multipleOfAvg: fix(l.notionalUsd / avg, 1) }))
    .sort((a, b) => b.notionalUsd - a.notionalUsd)
    .slice(0, 6);
  const bidImbalancePct = fix((bidN / total) * 100, 1);
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  return {
    bidNotionalUsd: fix(bidN, 0), askNotionalUsd: fix(askN, 0), bidImbalancePct,
    pressure: bidImbalancePct > 60 ? "BID_HEAVY" : bidImbalancePct < 40 ? "ASK_HEAVY" : "BALANCED",
    walls, bestBid, bestAsk,
    spreadPct: fix(((bestAsk - bestBid) / bestAsk) * 100, 4),
  };
}

/** VWAP slippage for a market order of `size`, % vs mark. null = book too thin. */
export function slippageForSize(depth: OrderBookDepthResponse | null, side: "BUY" | "SELL", size: number, mark: number): { vwap: number; slippagePct: number } | null {
  const vwap = estimateMarketFillPrice(depth, side === "BUY" ? "Long" : "Short", size);
  if (vwap == null || !mark) return null;
  return { vwap: fix(vwap, 8), slippagePct: fix(((vwap - mark) / mark) * 100 * (side === "BUY" ? 1 : -1), 4) };
}
