import { useEffect, useRef } from "react";
import { useKlineData, SUPPORTED_RESOLUTIONS, normalizeUnixToSeconds } from "../hooks/useKlineData";

// TradingView charting library (loaded from /public/static/charting_library/)
// @ts-ignore - UMD global, types not in node_modules
const TV_LIB_PATH = "/static/charting_library/";

interface Props {
  symbol: string;
  markPrice: number;
}

/** Price → pricescale (matches Strike app chartDatafeed.ts) */
function getPricescale(price: number): number {
  if (!price || price <= 0) return 100000;
  if (price >= 10000) return 1;
  if (price >= 1000) return 10;
  if (price >= 100) return 100;
  if (price >= 10) return 1000;
  if (price >= 1) return 10000;
  const magnitude = Math.floor(Math.log10(price));
  return Math.pow(10, Math.max(5, 5 - magnitude - 1));
}

export function Chart({ symbol, markPrice }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<any>(null);
  const { getHistoricalBars, subscribeToRealtimeUpdates } = useKlineData(symbol);

  // Refs for datafeed (stable across renders)
  const requestCacheRef = useRef(new Map<string, any>());
  const lastBarTimeRef = useRef(0);
  const unsubscribeFnsRef = useRef(new Map<string, () => void>());

  // Hold latest callbacks in refs so datafeed closures always see current values
  const getHistoricalBarsRef = useRef(getHistoricalBars);
  getHistoricalBarsRef.current = getHistoricalBars;
  const subscribeRef = useRef(subscribeToRealtimeUpdates);
  subscribeRef.current = subscribeToRealtimeUpdates;
  const markPriceRef = useRef(markPrice);
  markPriceRef.current = markPrice;

  useEffect(() => {
    if (!containerRef.current) return;

    // Wait for charting_library script to be available
    const initChart = () => {
      // @ts-ignore
      const TradingView = (window as any).TradingView;
      if (!TradingView?.widget) {
        console.error("[Chart] TradingView widget not loaded");
        return;
      }

      const datafeed = createDatafeed(
        symbol,
        markPriceRef,
        getHistoricalBarsRef,
        subscribeRef,
        requestCacheRef,
        lastBarTimeRef,
        unsubscribeFnsRef
      );

      const w = new TradingView.widget({
        symbol,
        datafeed,
        interval: "5",
        container: containerRef.current!,
        library_path: TV_LIB_PATH,
        locale: "en",
        disabled_features: [
          "use_localstorage_for_settings",
          "header_symbol_search",
          "symbol_info",
          "timeframes_toolbar",
          "volume_force_overlay",
          "context_menus",
          "scales_context_menu",
          "display_market_status",
          "header_compare",
          "show_object_tree",
          "study_templates",
          "border_around_the_chart",
          "main_series_scale_menu",
          "delete_button_in_legend",
          "header_widget",
        ],
        enabled_features: [],
        fullscreen: false,
        autosize: true,
        theme: "dark",
        loading_screen: { backgroundColor: "#080808" },
        overrides: {
          "mainSeriesProperties.candleStyle.upColor": "#089981",
          "mainSeriesProperties.candleStyle.downColor": "#F23645",
          "mainSeriesProperties.candleStyle.borderUpColor": "#089981",
          "mainSeriesProperties.candleStyle.borderDownColor": "#F23645",
          "mainSeriesProperties.candleStyle.wickUpColor": "#089981",
          "mainSeriesProperties.candleStyle.wickDownColor": "#F23645",
          "mainSeriesProperties.statusViewStyle.showExchange": false,
          "paneProperties.backgroundType": "solid",
          "paneProperties.background": "#080808",
        },
        studies_overrides: {
          "volume.volume.color.0": "#F23645",
          "volume.volume.color.1": "#089981",
        },
      });

      widgetRef.current = w;
    };

    // Load TradingView UMD script if not already loaded
    if ((window as any).TradingView?.widget) {
      initChart();
    } else {
      const script = document.createElement("script");
      script.src = `${TV_LIB_PATH}charting_library.standalone.js`;
      script.onload = initChart;
      script.onerror = () => console.error("[Chart] Failed to load TradingView library");
      document.head.appendChild(script);
    }

    return () => {
      if (widgetRef.current) {
        try { widgetRef.current.remove(); } catch { /* ignore */ }
        widgetRef.current = null;
      }
      // Clean up WS subscriptions
      for (const unsub of unsubscribeFnsRef.current.values()) {
        try { unsub(); } catch { /* ignore */ }
      }
      unsubscribeFnsRef.current.clear();
      requestCacheRef.current.clear();
      lastBarTimeRef.current = 0;
    };
  }, [symbol]); // Recreate widget on symbol change

  return (
    <div className="panel chart-panel">
      <div
        ref={containerRef}
        className="chart-container"
        style={{ width: "100%", height: 450 }}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// DATAFEED (matches Strike app chartDatafeed.ts pattern)
// ═══════════════════════════════════════════════════════════════════

function createDatafeed(
  symbol: string,
  markPriceRef: React.MutableRefObject<number>,
  getHistoricalBarsRef: React.MutableRefObject<(res: string, from: number, to: number) => Promise<any[]>>,
  subscribeRef: React.MutableRefObject<(res: string, cb: (bar: any) => void) => () => void>,
  requestCacheRef: React.MutableRefObject<Map<string, any>>,
  lastBarTimeRef: React.MutableRefObject<number>,
  unsubscribeFnsRef: React.MutableRefObject<Map<string, () => void>>
) {
  return {
    onReady: (callback: (config: any) => void) => {
      setTimeout(() => callback({
        supported_resolutions: [...SUPPORTED_RESOLUTIONS],
        symbols_types: [{ name: "crypto", value: "crypto" }],
      }), 0);
    },

    resolveSymbol: (
      symbolName: string,
      onResolvedCallback: (info: any) => void,
      _onError: (reason: string) => void
    ) => {
      setTimeout(() => {
        onResolvedCallback({
          name: symbolName,
          ticker: symbolName,
          description: symbolName,
          type: "crypto",
          session: "24x7",
          timezone: "Etc/UTC",
          minmov: 1,
          pricescale: getPricescale(markPriceRef.current),
          has_intraday: true,
          supported_resolutions: [...SUPPORTED_RESOLUTIONS],
          volume_precision: 2,
          data_status: "streaming",
        });
      }, 0);
    },

    getBars: async (
      _symbolInfo: any,
      resolution: string,
      periodParams: { from: number; to: number; firstDataRequest: boolean },
      onHistoryCallback: (bars: any[], meta: { noData?: boolean }) => void,
      onErrorCallback: (error: any) => void
    ) => {
      try {
        const { from, to, firstDataRequest } = periodParams;
        const cacheKey = `${symbol}-${resolution}-${from}-${to}`;

        if (!firstDataRequest && requestCacheRef.current.has(cacheKey)) {
          const cached = requestCacheRef.current.get(cacheKey);
          onHistoryCallback(cached.bars, cached.meta);
          return;
        }

        const bars = await getHistoricalBarsRef.current(resolution, from, to);

        if (bars.length > 0) {
          const lastBar = bars[bars.length - 1];
          if (lastBar.time > lastBarTimeRef.current) {
            lastBarTimeRef.current = lastBar.time;
          }

          // Cap cache size
          if (requestCacheRef.current.size >= 50) {
            const keys = Array.from(requestCacheRef.current.keys()).slice(0, 25);
            keys.forEach((k) => requestCacheRef.current.delete(k));
          }
          requestCacheRef.current.set(cacheKey, { bars, meta: { noData: false } });

          onHistoryCallback(bars, { noData: false });
        } else {
          onHistoryCallback([], { noData: true });
        }
      } catch (error) {
        console.error("[Chart] getBars error:", error);
        onErrorCallback(error);
        onHistoryCallback([], { noData: true });
      }
    },

    subscribeBars: (
      _symbolInfo: any,
      resolution: string,
      onRealtimeCallback: (bar: any) => void,
      subscribeUID: string,
      _onResetCacheNeeded: () => void
    ) => {
      const wrappedCallback = (bar: any) => {
        const barTime = Number(bar?.time);
        if (Number.isFinite(barTime) && barTime > lastBarTimeRef.current) {
          lastBarTimeRef.current = barTime;
        }
        onRealtimeCallback(bar);
      };

      const unsubscribe = subscribeRef.current(resolution, wrappedCallback);
      if (unsubscribe) {
        unsubscribeFnsRef.current.set(subscribeUID, unsubscribe);
      }
    },

    unsubscribeBars: (subscriberUID: string) => {
      const unsub = unsubscribeFnsRef.current.get(subscriberUID);
      if (unsub) {
        unsub();
        unsubscribeFnsRef.current.delete(subscriberUID);
      }
    },
  };
}
