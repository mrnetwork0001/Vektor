import { useState, useEffect } from "react";
import type { Market } from "../types/market";
import { getMarkets } from "../api/account";

/**
 * Fetch /v2/markets once on mount. Returns market config keyed by symbol.
 *
 * @example
 *   const { markets, isLoading } = useMarkets();
 *   const btcMarket = markets["BTC-USD"];
 *   console.log(btcMarket.default_leverage); // 20
 *   console.log(btcMarket.margin_tiers);     // [{max_notional: "50000", ...}]
 */
export function useMarkets() {
  const [markets, setMarkets] = useState<Record<string, Market>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMarkets()
      .then(setMarkets)
      .catch((e) => setError(e.message))
      .finally(() => setIsLoading(false));
  }, []);

  const symbols = Object.keys(markets);

  return { markets, symbols, isLoading, error };
}
