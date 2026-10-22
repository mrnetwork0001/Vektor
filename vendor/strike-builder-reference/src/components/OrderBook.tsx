import { useMemo, useState } from "react";
import type { OrderBookDepthResponse } from "../types/market";
import {
  aggregateOrders,
  getGroupingOptions,
  type OrderBookEntry,
} from "../math/orderBookUtils";
import { formatPrice, formatSize } from "../math/formatUtils";

interface Props {
  depth: OrderBookDepthResponse | null;
  midPrice: number;
  basePrec?: number;
}

/**
 * Order book component with grouping, spread, and depth bars.
 *
 * Shows:
 * - Asks (sells) on top, sorted lowest first
 * - Spread in the middle
 * - Bids (buys) on bottom, sorted highest first
 * - Depth bar proportional to cumulative total
 */
export function OrderBook({ depth, midPrice, basePrec = 4 }: Props) {
  const groupingOptions = useMemo(
    () => (midPrice > 0 ? getGroupingOptions(midPrice) : [1]),
    [midPrice]
  );
  const [groupingIndex, setGroupingIndex] = useState(0);
  const grouping = groupingOptions[groupingIndex] ?? 1;

  const { bids, asks, spread, spreadPercent } = useMemo(() => {
    if (!depth)
      return { bids: [], asks: [], spread: 0, spreadPercent: 0 };

    const bids = aggregateOrders(depth.bids, grouping, true).slice(0, 12);
    const asks = aggregateOrders(depth.asks, grouping, false).slice(0, 12);

    // Spread from RAW data (not grouped)
    const rawBestBid = depth.bids[0]
      ? parseFloat(depth.bids[0][0])
      : 0;
    const rawBestAsk = depth.asks[0]
      ? parseFloat(depth.asks[0][0])
      : 0;
    const spread = rawBestAsk && rawBestBid ? rawBestAsk - rawBestBid : 0;
    const spreadPercent =
      rawBestAsk > 0 ? (spread / rawBestAsk) * 100 : 0;

    return { bids, asks, spread, spreadPercent };
  }, [depth, grouping]);

  const maxTotal = Math.max(
    bids[bids.length - 1]?.total ?? 0,
    asks[asks.length - 1]?.total ?? 0,
    1
  );

  return (
    <div className="panel orderbook">
      <div className="panel-header">
        <h3>Order Book</h3>
        <select
          value={groupingIndex}
          onChange={(e) => setGroupingIndex(Number(e.target.value))}
          className="grouping-select"
        >
          {groupingOptions.map((g, i) => (
            <option key={i} value={i}>
              {g}
            </option>
          ))}
        </select>
      </div>

      <div className="ob-header">
        <span>Price</span>
        <span>Size</span>
        <span>Total</span>
      </div>

      {/* Asks (reversed so lowest is at bottom, near spread) */}
      <div className="ob-asks">
        {[...asks].reverse().map((entry, i) => (
          <OrderRow
            key={i}
            entry={entry}
            maxTotal={maxTotal}
            side="ask"
            basePrec={basePrec}
          />
        ))}
      </div>

      {/* Spread */}
      <div className="ob-spread">
        <span className="spread-price">{formatPrice(midPrice)}</span>
        <span className="spread-value">
          Spread: {formatPrice(spread)} ({spreadPercent.toFixed(4)}%)
        </span>
      </div>

      {/* Bids */}
      <div className="ob-bids">
        {bids.map((entry, i) => (
          <OrderRow
            key={i}
            entry={entry}
            maxTotal={maxTotal}
            side="bid"
            basePrec={basePrec}
          />
        ))}
      </div>
    </div>
  );
}

function OrderRow({
  entry,
  maxTotal,
  side,
  basePrec,
}: {
  entry: OrderBookEntry;
  maxTotal: number;
  side: "bid" | "ask";
  basePrec: number;
}) {
  const pct = (entry.total / maxTotal) * 100;
  const color = side === "bid" ? "rgba(37, 250, 176, 0.12)" : "rgba(244, 63, 94, 0.12)";

  return (
    <div
      className="ob-row"
      style={{
        background: `linear-gradient(to left, ${color} ${pct}%, transparent ${pct}%)`,
      }}
    >
      <span className={side === "bid" ? "text-green" : "text-red"}>
        {formatPrice(entry.price)}
      </span>
      <span>{formatSize(entry.size, basePrec)}</span>
      <span>{formatSize(entry.total, basePrec)}</span>
    </div>
  );
}
