// Snapshot of GET /v2/markets on testnet (2026-10-22) so demo mode works offline.
import type { Market } from "../types/market";

const tiers = (rows: [string, number, string, string][]) =>
  rows.map(([max_notional, max_leverage, maintenance_margin_rate, maintenance_amount]) => ({ max_notional, max_leverage, maintenance_margin_rate, maintenance_amount }));

function mk(symbol: string, base: string, tick: string, step: string, minSize: string, minNotional: string, mark: number, fr: string, margin_tiers: Market["margin_tiers"]): Market {
  return {
    symbol, name: `${base}/USD Perp`, base_asset: base, status: "trading", created_at: 0, base_prec: 8, quote_prec: 8, default_leverage: 20,
    margin_tiers, reduce_only: false,
    order_tick_price: tick, order_min_price: tick, order_max_price: "0", order_limit_price_bound: "0.05", order_market_price_bound: "0.05",
    order_limit_step_size: step, order_limit_min_size: minSize, order_limit_max_size: "0", order_market_step_size: step, order_market_min_size: minSize, order_market_max_size: "0",
    order_min_notional: minNotional, liquidation_fee_rate: "0.0125", liquidation_fee_retention_factor: "0.5", trigger_protect: "0.05",
    mark_price: String(mark), index_price: String(mark), last_price: String(mark), bid1_price: String(mark), bid1_size: "0", ask1_price: String(mark), ask1_size: "0",
    funding_rate: fr, next_funding_time: Math.ceil(Date.now() / 3_600_000) * 3_600_000, impact_notional: "1000",
  };
}

export const DEMO_MARKETS: Record<string, Market> = {
  "ADA-USD": mk("ADA-USD", "ADA", "0.0001", "1", "1", "5", 0.2224, "0.000031", tiers([["50000", 20, "0.01", "0"], ["250000", 10, "0.025", "750"], ["1000000", 5, "0.05", "7000"]])),
  "BTC-USD": mk("BTC-USD", "BTC", "0.1", "0.00001", "0.00001", "100", 83212, "0.0000125", tiers([["50000", 50, "0.004", "0"], ["250000", 25, "0.005", "50"], ["1000000", 20, "0.01", "1300"]])),
  "ETH-USD": mk("ETH-USD", "ETH", "0.01", "0.001", "0.001", "10", 2446.8, "-0.000008", tiers([["50000", 50, "0.005", "0"], ["250000", 25, "0.01", "250"], ["1000000", 20, "0.02", "2750"]])),
  "SOL-USD": mk("SOL-USD", "SOL", "0.01", "0.01", "0.01", "10", 105.95, "0.000019", tiers([["50000", 20, "0.01", "0"], ["250000", 10, "0.025", "750"], ["1000000", 5, "0.05", "7000"]])),
};
