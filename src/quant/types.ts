// ── Shared quant types ──
//
// Engines are pure functions over these types so the same code drives both
// the demo simulator (src/sim) and the live Strike API (src/api).

import type { CreateOrderRequest, CreateStrategyOrderRequest } from "../types/order";

/** Subset of GET /v2/markets needed to snap prices/sizes to engine rules. */
export interface MarketRules {
  symbol: string;
  tick: number; // order_tick_price
  stepSize: number; // order_limit_step_size
  minSize: number; // order_limit_min_size (grid anchor)
  minNotional: number; // order_min_notional
  basePrec: number;
  quotePrec: number;
}

export interface FeeContext {
  makerRate: number; // fraction, e.g. 0.0002 (negative = rebate)
  takerRate: number;
  builderFeeBps: number; // 0..100
}

/** A fill as both the simulator and the live user stream report it. */
export interface FillEvent {
  symbol: string;
  clientOrderId: string;
  orderId: number | string;
  side: "BUY" | "SELL";
  fillQty: number; // this fill
  fillPrice: number;
  cumFilled: number; // cumulative for the order
  orderQty: number;
  isMaker: boolean;
  commission: number; // negative = rebate
  builderFee: number;
  timestamp: number;
  status: "OPEN" | "FILLED" | "PARTIALLY_FILLED" | "CANCELED" | "REJECTED" | "EXPIRED";
  closeReason?: string;
}

/** Execution backend: live (Strike REST) or simulated. */
export interface ExecutionAdapter {
  readonly mode: "live" | "sim";
  placeBatch(orders: CreateOrderRequest[]): Promise<{ accepted: string[]; failed: { index: number; error: string }[] }>;
  /** Bracket (primary + SL leg) via POST /v2/order/strategy. Optional: adapters without it fall back to plain limits. */
  placeStrategy?(req: CreateStrategyOrderRequest): Promise<void>;
  cancel(symbol: string, clientOrderId: string): Promise<void>;
  cancelAll(symbol?: string): Promise<void>;
  onFill(cb: (fill: FillEvent) => void): () => void;
  /**
   * Optional: cancel every active order on `symbol` and place `orders` in ONE
   * engine command (POST /v2/orders/replace). Items carry no symbol. Used by
   * the auto-shift grid so the book is never half-old/half-new.
   */
  replaceAll?(symbol: string, orders: Omit<CreateOrderRequest, "symbol">[]): Promise<{ accepted: string[]; failed: { index: number; error: string }[] }>;
}

export const snapDown = (v: number, step: number) => (step > 0 ? Math.floor(v / step + 1e-9) * step : v);
export const snapUp = (v: number, step: number) => (step > 0 ? Math.ceil(v / step - 1e-9) * step : v);
export const fix = (v: number, prec: number) => Number(v.toFixed(prec));
