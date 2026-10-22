import type { OrderBookDepthResponse } from "../types/market";
import type { DepthUpdate } from "../types/ws";

/** Levels carried by the WS depth stream (services/price depth_processor.go maxDepthLevels). */
export const DEPTH_STREAM_LEVELS = 20;

/**
 * Apply a WS depthUpdate (top-20 DIFF) to a locally maintained book.
 *
 * - Seed the book from GET /price/v2/depth?limit=20 (no snapshot is sent on subscribe).
 * - Skip events with u <= book.lastUpdateId (already covered by the snapshot);
 *   U/u are not contiguous across events, so do not require U == last+1.
 * - qty "0" removes the level (it may only have dropped out of the top 20).
 * - Diffs are relative to the server's PREVIOUS publish on the channel, not to
 *   your snapshot; when a symbol gets its first subscriber the server pushes the
 *   full top 20 with no "0" removals, so stale snapshot levels can survive.
 *   Re-sync from REST after reconnects, on a crossed book, and periodically.
 * - b / a may be null when a side did not change.
 * - The result is re-sorted and truncated to the top 20 per side.
 *
 * @returns the new book, or the same object when the event is stale
 */
export function applyDepthDiff(
  book: OrderBookDepthResponse,
  update: DepthUpdate,
  maxLevels: number = DEPTH_STREAM_LEVELS
): OrderBookDepthResponse {
  if (update.u <= book.lastUpdateId) return book;

  const merge = (levels: string[][], diff: string[][], desc: boolean): string[][] => {
    const map = new Map<string, string>();
    for (const [p, q] of levels) map.set(p, q);
    for (const [p, q] of diff) {
      // normalize the key so "100.10" and "100.1" match
      const key = [...map.keys()].find((k) => parseFloat(k) === parseFloat(p)) ?? p;
      if (parseFloat(q) === 0) map.delete(key);
      else {
        map.delete(key);
        map.set(p, q);
      }
    }
    return [...map.entries()]
      .sort((a, b) => (desc ? parseFloat(b[0]) - parseFloat(a[0]) : parseFloat(a[0]) - parseFloat(b[0])))
      .slice(0, maxLevels);
  };

  return {
    lastUpdateId: update.u,
    E: update.E,
    T: update.E,
    bids: merge(book.bids, update.b ?? [], true),
    asks: merge(book.asks, update.a ?? [], false),
  };
}

/**
 * Walk the order book to estimate the fill price for a market order (VWAP).
 *
 * @param orderBook - Current order book snapshot
 * @param side      - "Long" walks asks (buying), "Short" walks bids (selling)
 * @param size      - Order size in base asset
 * @param skipSize  - Units to skip before accumulating cost (for position flips)
 * @returns Volume-weighted average price, or null if insufficient liquidity
 *
 * @example Long 1.0 BTC, asks = [[$43,251, 1.8], [$43,251.50, 3.0]]:
 *   Fill 1.0 at $43,251 -> cost = $43,251
 *   VWAP = $43,251 / 1.0 = $43,251.00
 *
 * @example Long 2.5 BTC:
 *   Fill 1.8 at $43,251   -> cost = $77,851.80
 *   Fill 0.7 at $43,251.50 -> cost = $30,276.05
 *   VWAP = $108,127.85 / 2.5 = $43,251.14
 *
 * @example Position flip: Long 0.5 BTC, but currently Short 0.2 BTC
 *   skipSize = 0.2 (closing portion), size = 0.3 (opening portion)
 *   Only VWAP the 0.3 BTC that opens the new Long
 */
export function estimateMarketFillPrice(
  orderBook: OrderBookDepthResponse | null,
  side: "Long" | "Short",
  size: number,
  skipSize: number = 0
): number | null {
  const totalSize = size + skipSize;
  if (!orderBook || totalSize <= 0 || size <= 0) return null;

  const levels = side === "Long" ? orderBook.asks : orderBook.bids;
  if (!levels || levels.length === 0) return null;

  let remainingTotal = totalSize;
  let skipped = 0;
  let costAccumulator = 0;

  for (const [priceStr, qtyStr] of levels) {
    const price = parseFloat(priceStr);
    const qty = parseFloat(qtyStr);
    if (!price || !qty) continue;

    const fillQty = Math.min(remainingTotal, qty);

    const skipRemaining = skipSize - skipped;
    if (skipRemaining > 0) {
      const skippedQty = Math.min(fillQty, skipRemaining);
      const countedQty = fillQty - skippedQty;
      skipped += skippedQty;
      costAccumulator += countedQty * price;
    } else {
      costAccumulator += fillQty * price;
    }

    remainingTotal -= fillQty;
    if (remainingTotal <= 0) break;
  }

  if (remainingTotal > 0) return null; // not enough liquidity
  return costAccumulator / size;
}

// ═══════════════════════════════════════════════════════════════════
// ORDER BOOK AGGREGATION (for rendering)
// ═══════════════════════════════════════════════════════════════════

export interface OrderBookEntry {
  price: number;
  size: number;
  total: number; // cumulative size
}

/**
 * Get grouping increment options based on price magnitude.
 *
 * @example price=43250 -> base=1, options=[1, 5, 10, 50, 100]
 * @example price=1.50  -> base=0.0001, options=[0.0001, 0.0005, 0.001, 0.005, 0.01]
 */
export function getGroupingOptions(price: number): number[] {
  let base: number;
  if (price >= 10000) base = 1;
  else if (price >= 1000) base = 0.1;
  else if (price >= 100) base = 0.01;
  else if (price >= 10) base = 0.001;
  else if (price >= 1) base = 0.0001;
  else base = 0.00001;

  return [base, base * 5, base * 10, base * 50, base * 100];
}

/**
 * Aggregate raw order book levels into grouped price levels with cumulative totals.
 *
 * @param levels   - Raw [[price, qty], ...] from API
 * @param grouping - Price grouping increment (e.g. 10)
 * @param isBids   - true = bids (floor grouping), false = asks (ceil grouping)
 *
 * @example bids with grouping=10:
 *   $43,249 -> floor(43249/10)*10 = $43,240
 *   $43,248 -> floor(43248/10)*10 = $43,240  (aggregated together)
 */
export function aggregateOrders(
  levels: string[][],
  grouping: number,
  isBids: boolean
): OrderBookEntry[] {
  const grouped = new Map<number, number>();

  for (const [priceStr, qtyStr] of levels) {
    const price = parseFloat(priceStr);
    const qty = parseFloat(qtyStr);
    if (!price || !qty) continue;

    const groupedPrice = isBids
      ? Math.floor(price / grouping) * grouping
      : Math.ceil(price / grouping) * grouping;

    grouped.set(groupedPrice, (grouped.get(groupedPrice) ?? 0) + qty);
  }

  const entries = Array.from(grouped.entries())
    .map(([price, size]) => ({ price, size, total: 0 }))
    .sort((a, b) => (isBids ? b.price - a.price : a.price - b.price));

  // Compute cumulative totals
  let total = 0;
  for (const entry of entries) {
    total += entry.size;
    entry.total = total;
  }

  return entries;
}
