// ── Market configuration from GET /v2/markets ──
// Response: { markets: { [symbol]: Market } }. Decimals are strings.

export interface MarginTier {
  max_notional: string;
  max_leverage: number;
  maintenance_margin_rate: string;
  // Engine-derived: MA[0] = 0, MA[i] = MA[i-1] + MaxNotional[i-1] × (MMR[i] − MMR[i-1])
  maintenance_amount: string;
}

export type MarketStatus = "pre_trading" | "trading" | "break" | "close";

export interface Market {
  symbol: string; // e.g. "BTC-USD"
  name: string;
  base_asset: string; // e.g. "BTC"
  status: MarketStatus;
  created_at: number; // unix ms
  base_prec: number; // decimal places for sizes
  quote_prec: number; // decimal places for prices / USD amounts
  default_leverage: number;

  // Margin tiers (sorted by max_notional ascending; max_leverage non-increasing)
  margin_tiers: MarginTier[];

  reduce_only: boolean; // market-wide reduce-only mode

  // Price constraints
  order_tick_price: string; // price grid: price = order_min_price + k × tick
  order_min_price: string; // limit price must be ≥ this
  order_max_price: string; // "0" = no maximum
  order_limit_price_bound: string; // limit buy ≤ mark×(1+b), limit sell ≥ mark×(1−b)
  order_market_price_bound: string;

  // Size constraints. Max/step: limit fields for limit/stop_limit/take_profit_limit,
  // market fields for market/stop/take_profit. Step grids are anchored at the
  // matching min: size = min + k × step.
  order_limit_step_size: string;
  order_limit_min_size: string; // grid anchor for limit-type sizes
  order_limit_max_size: string; // size > max is rejected
  order_market_step_size: string;
  order_market_min_size: string; // minimum size for EVERY order type (not close_position)
  order_market_max_size: string; // size > max is rejected
  order_min_notional: string; // not applied to reduce_only / close_position

  liquidation_fee_rate: string;
  liquidation_fee_retention_factor: string;
  trigger_protect: string;

  // Snapshot prices (from the price service)
  mark_price: string;
  index_price: string;
  last_price: string;
  bid1_price: string;
  bid1_size: string;
  ask1_price: string;
  ask1_size: string;
  funding_rate: string; // hourly rate
  next_funding_time: number; // unix ms (next HH:00 UTC)

  impact_notional: string; // added by GET /v2/markets
}

export interface MarketsResponse {
  markets: Record<string, Market>;
}

/**
 * Order book snapshot from price service GET /price/v2/depth?symbol=&limit=
 * (limit default 20, max 1000). Also used as the locally-maintained book.
 */
export interface OrderBookDepthResponse {
  lastUpdateId: number;
  E: number; // message time (ms)
  T: number; // snapshot time (ms)
  bids: string[][]; // [[price, qty], ...] highest first
  asks: string[][]; // [[price, qty], ...] lowest first
}
