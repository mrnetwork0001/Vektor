import { useState, useEffect, useRef } from "react";
import { priceStream } from "../ws/priceStream";
import { getDepth, getMarkPrice } from "../api/account";
import { applyDepthDiff, DEPTH_STREAM_LEVELS } from "../math/orderBookUtils";
import type { DepthUpdate, MarkPriceUpdate } from "../types/ws";
import type { OrderBookDepthResponse } from "../types/market";

/**
 * Subscribe to the price stream for a symbol. Returns live mark prices and depth.
 *
 * Order book maintenance (the WS sends top-20 DIFFS and no snapshot):
 *   1. Subscribe to "depth"; buffer depthUpdate events until synced
 *   2. On the subscribe ack (and after every reconnect), fetch
 *      GET /price/v2/depth?limit=20 and replay buffered diffs with u > lastUpdateId
 *   3. Apply live diffs; re-sync when the book crosses and every 60s
 *
 * Mark prices: REST GET /price/v2/markPrice?symbol= seeds the selected symbol;
 * "!markPrice@arr" (every 3s, all symbols) keeps every symbol live so positions
 * in other markets are valued too. Per-symbol "markPrice" / "markPrice@1s"
 * channels exist as well.
 *
 * @example
 *   const { markPrice, fundingRate, nextFundingTime, depth } = usePriceStream("BTC-USD");
 */
export function usePriceStream(symbol: string) {
  const [prices, setPrices] = useState<Record<string, MarkPriceUpdate>>({});
  const [depth, setDepth] = useState<OrderBookDepthResponse | null>(null);
  const depthRef = useRef<OrderBookDepthResponse | null>(null);
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Connect WS + all-symbol mark prices on mount
  useEffect(() => {
    priceStream.connect();
    priceStream.subscribe("!markPrice@arr");
    const unsub = priceStream.on("markPriceUpdate", (event: MarkPriceUpdate) => {
      setPrices((prev) => (prev[event.s]?.E > event.E ? prev : { ...prev, [event.s]: event }));
    });
    return () => {
      unsub();
      priceStream.unsubscribe("!markPrice@arr");
    };
  }, []);

  useEffect(() => {
    if (!symbol) return;

    let cancelled = false;
    let synced = false;
    let generation = 0; // bumped by every resync; stale snapshot fetches are discarded
    let buffer: DepthUpdate[] = []; // diffs received while (re)syncing
    depthRef.current = null;

    // Throttled render (150ms leading edge)
    const render = () => {
      if (!throttleRef.current) {
        setDepth(depthRef.current);
        throttleRef.current = setTimeout(() => {
          throttleRef.current = null;
          setDepth(depthRef.current);
        }, 150);
      }
    };

    const crossed = (book: OrderBookDepthResponse) =>
      book.bids.length > 0 &&
      book.asks.length > 0 &&
      parseFloat(book.bids[0][0]) >= parseFloat(book.asks[0][0]);

    // Seed from REST, then replay buffered diffs with u > lastUpdateId
    const resync = async () => {
      const gen = ++generation;
      synced = false;
      buffer = [];
      try {
        const snapshot = await getDepth(symbol, DEPTH_STREAM_LEVELS);
        if (cancelled || gen !== generation) return;
        let book: OrderBookDepthResponse = {
          lastUpdateId: Number(snapshot.lastUpdateId) || 0,
          E: snapshot.E,
          T: snapshot.T,
          bids: snapshot.bids ?? [],
          asks: snapshot.asks ?? [],
        };
        for (const ev of buffer) book = applyDepthDiff(book, ev);
        buffer = [];
        synced = true;
        depthRef.current = book;
        render();
      } catch (e) {
        console.error("[usePriceStream] depth snapshot failed:", e);
        if (!cancelled && gen === generation) setTimeout(() => void resync(), 1000);
      }
    };

    // ── Order book: subscribe, re-sync on every ack (incl. reconnects) ──
    // Diffs are relative to the server's previous publish (not to our snapshot),
    // a symbol's first subscriber gets a full top-20 push without "0" removals,
    // and slow clients can silently miss messages — so also re-sync on a crossed
    // book and every 60s.
    const unsubAck = priceStream.on(`subscribed:depth|${symbol}`, () => void resync());
    const unsubDepth = priceStream.on(`depthUpdate:${symbol}`, (event: DepthUpdate) => {
      if (!synced) {
        buffer.push(event);
        return;
      }
      if (!depthRef.current) return;
      depthRef.current = applyDepthDiff(depthRef.current, event);
      if (crossed(depthRef.current)) void resync();
      else render();
    });
    const resyncTimer = setInterval(() => {
      if (synced) void resync();
    }, 60_000);
    // Fallback if the WS is down: show a REST snapshot anyway
    const fallbackTimer = setTimeout(() => {
      if (!synced && generation === 0) void resync();
    }, 5_000);
    priceStream.subscribe("depth", symbol);

    // ── Mark price seed ──
    getMarkPrice(symbol)
      .then((snapshot) => {
        if (cancelled || snapshot?.s !== symbol) return;
        // Keep a newer WS value if one already arrived
        setPrices((prev) => (prev[symbol] && prev[symbol].E >= snapshot.E ? prev : { ...prev, [symbol]: snapshot }));
      })
      .catch((e) => console.error("[usePriceStream] Initial mark price fetch failed:", e));

    return () => {
      cancelled = true;
      generation++;
      clearInterval(resyncTimer);
      clearTimeout(fallbackTimer);
      unsubAck();
      unsubDepth();
      priceStream.unsubscribe("depth", symbol);
      if (throttleRef.current) {
        clearTimeout(throttleRef.current);
        throttleRef.current = null;
      }
      depthRef.current = null;
      setDepth(null);
    };
  }, [symbol]);

  const markPriceData = prices[symbol];
  const markPrice = markPriceData ? parseFloat(markPriceData.p) : 0;
  const indexPrice = markPriceData ? parseFloat(markPriceData.i) : 0;
  const fundingRate = markPriceData ? parseFloat(markPriceData.r) : 0; // hourly
  const nextFundingTime = markPriceData?.T ?? 0;

  return {
    prices,
    markPrice,
    indexPrice,
    fundingRate,
    nextFundingTime,
    depth,
  };
}
