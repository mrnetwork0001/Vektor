// ── Position data (base from API/WS + derived from mark price) ──

/**
 * Position row from GET /v2/positions → { positions: PositionResponse[], count }.
 * `size` is SIGNED: positive = long, negative = short (one-way mode).
 */
export interface PositionResponse {
  id: number;
  account_id: string;
  margin_mode: "cross" | "isolated";
  leverage: number;
  size: string;
  entry_price: string;
  iso_balance: string;
  accumulated_funding_fees: string; // signed: + received, − paid
  create_timestamp: number;
  update_timestamp: number;
  symbol: string;
  upnl: string;
  maintenance_margin: string;
  bankruptcy_price: string;
  liquidation_price: string;
}

export interface Position {
  // Base fields from REST / WebSocket ACCOUNT_UPDATE
  symbol: string; // e.g. "BTC-USD"
  size: number; // absolute position size (always positive)
  entryPrice: number;
  positionSide: "LONG" | "SHORT"; // from the sign of size
  marginMode: "cross" | "isolated";
  isoBalance: number; // isolated margin reserve (only for isolated)
  leverage: number; // position leverage setting
  accumulatedFundingFees: number; // signed cumulative funding (+ received, − paid)
  id?: string;

  // Derived fields (recalculated on every mark price update)
  uPnL?: number; // (mark − entry) × signedSize
  notional?: number; // markPrice × |size|
  currentMargin?: number; // isolated: isoBalance, cross: initial margin (notional / leverage)
  requiredMargin?: number; // notional / leverage (isolated only)
  maintenanceMargin?: number; // notional × MMR − MA
  // UI ROE (not served by the backend for open positions):
  // uPnL / (entry × |size| / leverage) × 100 — same margin base as the
  // backend's roi_pct on closing fills
  pnlPercentage?: number;
  markPrice?: number; // mark used for the derived fields (rounded to quote_prec)
  marginRatio?: number; // MM / MarginBalance × 100 (isolated: iso + uPnL; cross: shared cross balance)
  liquidationPrice?: number;
}

/**
 * Context needed to calculate cross-margin liquidation price.
 * For each cross position, you need data about ALL OTHER cross positions.
 */
export interface CrossLiquidationContext {
  walletBalance: number;
  totalIsolatedMargin: number; // sum of isoBalance for all isolated positions
  otherCrossUPnL: number; // sum of uPnL for OTHER cross positions
  otherCrossMaintenanceMargin: number; // sum of maintenanceMargin for OTHER cross positions
}
