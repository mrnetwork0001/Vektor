import { useState, useEffect, useRef, useCallback } from "react";
import { getKlines } from "../api/account";
import { priceStream } from "../ws/priceStream";

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface ChartBar {
  time: number; // Unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ═══════════════════════════════════════════════════════════════════
// INTERVAL / TIME HELPERS (matches Strike app PriceContext + chartTimeUtils)
// ═══════════════════════════════════════════════════════════════════

export const SUPPORTED_RESOLUTIONS = [
  "1", "3", "5", "15", "30", "60", "120", "240", "360", "480", "720",
  "1D", "3D", "1W", "1M",
] as const;

/** TradingView resolution ("15", "60", "1D") → kline interval ("15m", "1h", "1d") */
export function resolutionToInterval(resolution: string): string {
  const map: Record<string, string> = {
    "1": "1m", "3": "3m", "5": "5m", "15": "15m", "30": "30m",
    "60": "1h", "120": "2h", "240": "4h", "360": "6h", "480": "8h", "720": "12h",
    "D": "1d", "1D": "1d", "3D": "3d",
    "W": "1w", "1W": "1w",
    "M": "1M", "1M": "1M",
  };
  return map[resolution] || "15m";
}

/** Resolution string → seconds */
export function resolutionToSeconds(resolution: string): number {
  const s = String(resolution).trim();
  if (s.endsWith("m")) return (parseInt(s, 10) || 1) * 60;
  if (s.endsWith("h")) return (parseInt(s, 10) || 1) * 3600;
  if (s.endsWith("d")) return (parseInt(s, 10) || 1) * 86400;
  if (s.endsWith("w")) return (parseInt(s, 10) || 1) * 604800;
  const upper = s.toUpperCase();
  const num = parseInt(upper, 10) || 1;
  if (upper.endsWith("D")) return num * 86400;
  if (upper.endsWith("W")) return num * 604800;
  if (upper.endsWith("M")) return num * 2592000;
  return num * 60; // Pure number = minutes (TradingView convention)
}

/** Normalize any unix timestamp to seconds */
export function normalizeUnixToSeconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const abs = Math.abs(value);
  if (abs >= 1e15) return Math.floor(value / 1_000_000);
  if (abs >= 1e11) return Math.floor(value / 1_000);
  return Math.floor(value);
}

/** Normalize raw kline entry to ChartBar (handles array + object formats) */
function normalizeKline(raw: any): ChartBar | null {
  let openTime: number, open: number, high: number, low: number, close: number, volume: number;

  if (Array.isArray(raw)) {
    [openTime, open, high, low, close, volume] = raw.map(Number);
  } else if (raw && typeof raw === "object") {
    openTime = Number(raw.open_time ?? raw.openTime ?? raw.t ?? 0);
    open = Number(raw.open ?? raw.o ?? 0);
    high = Number(raw.high ?? raw.h ?? 0);
    low = Number(raw.low ?? raw.l ?? 0);
    close = Number(raw.close ?? raw.c ?? 0);
    volume = Number(raw.volume ?? raw.v ?? 0);
  } else {
    return null;
  }

  if (!openTime || !Number.isFinite(open)) return null;

  // Keep time in original unit (ms from API) — TradingView auto-detects
  return { time: openTime, open, high, low, close, volume };
}

/** Fill gaps with flat bars. intervalMs in milliseconds. */
function fillGaps(lastBar: ChartBar | null, newBar: ChartBar, intervalMs: number): ChartBar[] {
  if (!lastBar) return [newBar];
  if (newBar.time === lastBar.time) return [newBar];
  if (newBar.time === lastBar.time + intervalMs) return [newBar];

  const result: ChartBar[] = [];
  let cursor = lastBar.time + intervalMs;
  while (cursor < newBar.time) {
    result.push({
      time: cursor, open: lastBar.close, high: lastBar.close,
      low: lastBar.close, close: lastBar.close, volume: 0,
    });
    cursor += intervalMs;
  }
  result.push(newBar);
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// HOOK — provides getHistoricalBars + subscribeToRealtimeUpdates
// for the TradingView datafeed to call
// ═══════════════════════════════════════════════════════════════════

export function useKlineData(symbol: string) {
  const lastBarPerIntervalRef = useRef<Map<string, ChartBar>>(new Map());
  const klineCallbacksRef = useRef<Map<string, (bar: ChartBar) => void>>(new Map());

  /**
   * Fetch historical bars — matches Strike app PriceContext.getHistoricalBars exactly.
   * TradingView sends from/to in seconds. We convert to ms for API.
   * Returned bars keep time in ms (TradingView auto-detects unit).
   */
  const getHistoricalBars = useCallback(
    async (resolution: string, from: number, to: number): Promise<ChartBar[]> => {
      const interval = resolutionToInterval(resolution);
      const intervalMs = resolutionToSeconds(resolution) * 1000;

      // Convert seconds → ms if needed (TradingView sends seconds). TradingView's
      // `to` is exclusive while the server's endTime is inclusive.
      const startTime = from < 10000000000 ? from * 1000 : from;
      let endTime = (to < 10000000000 ? to * 1000 : to) - 1;

      // Extend endTime for near-current requests to capture in-progress bar
      const now = Date.now();
      if (endTime > now - intervalMs * 2) {
        endTime = Math.max(endTime, now + intervalMs);
      }

      const requestedRangeMs = endTime - startTime;
      const limit = Math.min(Math.ceil(requestedRangeMs / intervalMs) + 10, 1500); // server max 1500

      console.log(`[useKlineData] getBars ${symbol} ${interval} from=${new Date(startTime).toISOString()} to=${new Date(endTime).toISOString()} limit=${limit}`);

      try {
        // Mark-price candles: rows are [openTime, o, h, l, c, v, closeTime, ...]
        const rawKlines = await getKlines(symbol, interval, startTime, endTime, limit, "mark");
        console.log(`[useKlineData] Got ${rawKlines.length} raw klines`);

        // With endTime set the server returns the newest `limit` candles up to
        // endTime (and may add a seed candle before an empty window), so drop
        // anything that opened before startTime.
        const bars = rawKlines
          .map(normalizeKline)
          .filter((b): b is ChartBar => b !== null && b.time >= startTime && b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0)
          .sort((a, b) => a.time - b.time);

        // Deduplicate
        const deduped: ChartBar[] = [];
        let prevTime = 0;
        for (const bar of bars) {
          if (bar.time > prevTime) {
            deduped.push(bar);
            prevTime = bar.time;
          }
        }

        if (deduped.length > 0) {
          lastBarPerIntervalRef.current.set(interval, deduped[deduped.length - 1]);
        }

        console.log(`[useKlineData] Returning ${deduped.length} bars, first=${deduped[0]?.time} last=${deduped[deduped.length-1]?.time}`);
        return deduped;
      } catch (err) {
        console.error("[useKlineData] Failed to fetch klines:", err);
        return [];
      }
    },
    [symbol]
  );

  /**
   * Subscribe to real-time kline updates.
   * Called by datafeed.subscribeBars().
   * Uses the mark-price candle channel "kline_<interval>_mark" to match the
   * REST history (priceType=mark). "kline_<interval>" is last-price candles,
   * "kline_<interval>_index" index-price candles; all share the "kline" payload.
   */
  const subscribeToRealtimeUpdates = useCallback(
    (resolution: string, callback: (bar: ChartBar) => void): (() => void) => {
      const interval = resolutionToInterval(resolution);
      const intervalSec = resolutionToSeconds(resolution);
      const wsChannel = `kline_${interval}_mark`;
      const callbackKey = `${symbol}:${interval}`;

      console.log(`[useKlineData] Subscribing WS: ${wsChannel} for ${symbol}`);

      // Store callback
      klineCallbacksRef.current.set(callbackKey, callback);

      // Subscribe to WS
      priceStream.subscribe(wsChannel, symbol);

      // Listen for kline events
      const unsub = priceStream.on(`kline:${symbol}`, (event: any) => {
        const k = event.k;
        if (!k || k.i !== interval) return;

        const newBar: ChartBar = {
          time: Number(k.t), // Keep in ms — matches REST bars
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c),
          volume: parseFloat(k.v),
        };

        const lastBar = lastBarPerIntervalRef.current.get(interval) ?? null;
        const intervalMs = intervalSec * 1000;

        // Fill gaps and emit each bar (not for 1M: the server uses calendar
        // months, which a fixed-length step cannot reproduce)
        const barsToEmit = interval === "1M" ? [newBar] : fillGaps(lastBar, newBar, intervalMs);
        for (const bar of barsToEmit) {
          const cb = klineCallbacksRef.current.get(callbackKey);
          if (cb) cb(bar);
        }

        lastBarPerIntervalRef.current.set(interval, newBar);
      });

      return () => {
        unsub();
        klineCallbacksRef.current.delete(callbackKey);
        priceStream.unsubscribe(wsChannel, symbol);
        console.log(`[useKlineData] Unsubscribed WS: ${wsChannel} for ${symbol}`);
      };
    },
    [symbol]
  );

  return { getHistoricalBars, subscribeToRealtimeUpdates };
}
