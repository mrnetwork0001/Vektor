// ── Order types (REST enums are lowercase snake_case) ──

export type OrderSide = "buy" | "sell";
export type OrderType =
  | "market"
  | "limit"
  | "stop"
  | "stop_limit"
  | "take_profit"
  | "take_profit_limit"
  | "trailing_stop_market";
export type OrderStatus =
  | "pending"
  | "open"
  | "filled"
  | "canceled"
  | "untriggered"
  | "rejected"
  | "expired";
export type TimeInForce = "GTC" | "FOK" | "IOC";
export type WorkingType = "mark_price" | "contract_price";

/** POST /v2/order body. Decimals may be sent as strings. */
export interface CreateOrderRequest {
  client_order_id?: string; // ≤256 chars; must not start with copy:, liq_, bankrupt_, adl_, if_transfer_, if_adl_ …
  symbol: string;
  side: OrderSide;
  type: OrderType;
  size: string;
  price?: string; // limit / stop_limit / take_profit_limit
  stop_price?: string; // stop / stop_limit / take_profit / take_profit_limit
  time_in_force?: TimeInForce; // default GTC
  working_type?: WorkingType;
  post_only?: boolean;
  reduce_only?: boolean;
  close_position?: boolean; // size clamped to the open position
  price_protect?: boolean;
  // trailing_stop_market only: callback_rate in percent units [0.1, 5]; requires
  // reduce_only: true, no close_position; activation_price optional (omitted =
  // activate at placement). working_type defaults to contract_price for trailing
  // stops and to mark_price for other conditional orders.
  callback_rate?: string;
  activation_price?: string;
  slippage?: string;
  vault_id?: string;
  sub_account_id?: string;
}

/** Async create acknowledgement (HTTP 201). Fills/rejects arrive on the user stream. */
export interface CreateOrderResponse {
  client_order_id: string;
  account_id: string;
  symbol: string;
  status: "pending";
  sequence_id?: number;
  message_id?: string;
}

/** TP / SL leg of POST /v2/order/strategy. Side is the opposite of the primary; legs are always reduce-only. */
export interface StrategyLeg {
  client_order_id?: string;
  type: OrderType; // tp_order: take_profit | take_profit_limit; sl_order: stop | stop_limit
  size: string;
  price?: string; // *_limit legs
  stop_price: string;
  time_in_force?: TimeInForce;
  working_type?: WorkingType;
  post_only?: boolean;
  price_protect?: boolean;
}

export interface CreateStrategyOrderRequest {
  strategy_id: string;
  client_order_id?: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  size: string;
  price?: string;
  stop_price?: string;
  time_in_force?: TimeInForce;
  working_type?: WorkingType;
  post_only?: boolean;
  reduce_only?: boolean;
  close_position?: boolean;
  price_protect?: boolean;
  vault_id?: string;
  sub_account_id?: string;
  tp_order?: StrategyLeg; // at least one of tp_order / sl_order is required
  sl_order?: StrategyLeg;
}

export interface CreateStrategyOrderResponse {
  strategy_id: string;
  primary_client_order_id: string;
  tp_client_order_id?: string;
  sl_client_order_id?: string;
  account_id: string;
  symbol: string;
  sequence_id: number;
  message_id: string;
}

/** DELETE /v2/order/cancel body: order_id or client_order_id (client_order_id wins if both). */
export interface CancelOrderRequest {
  symbol: string;
  order_id?: number;
  client_order_id?: string;
  vault_id?: string;
  sub_account_id?: string;
}

export interface CancelOrderResponse {
  order_id: number;
  client_order_id?: string;
  symbol: string;
  sequence_id?: number;
  message_id?: string;
}

export interface CancelAllOrdersResponse {
  account_id: string;
  symbol?: string;
  canceled_count: number;
  sequence_id: number;
  message_id: string;
}

export interface ReplaceOrderResponse {
  cancel?: CancelOrderResponse;
  new_order?: CreateOrderResponse;
  sequence_id?: number;
  message_id?: string;
}

/**
 * Open order from GET /v2/openOrders → { orders: OpenOrder[], count }.
 * This endpoint returns the engine order model directly, so keys are
 * PascalCase Go field names. Enums are lowercase snake_case strings.
 */
export interface OpenOrder {
  ID: number;
  ClientOrderID: string;
  AccountID: string;
  Symbol: string;
  Strategy?: { ID: string; IsPrimary: boolean };
  CloseReason: string;
  Side: OrderSide;
  Status: OrderStatus;
  Type: OrderType;
  OriginType: OrderType | "";
  AutoCloseType: string;
  TimeInForce: TimeInForce;
  WorkingType: WorkingType | "none";
  Size: string;
  Filled: string;
  Price: string;
  StopPrice: string;
  BoundPrice: string;
  Trailing?: { CallbackRate: string; ActivationPrice: string; Extreme: string; Activated: boolean };
  PostOnly: boolean;
  ReduceOnly: boolean;
  ClosePosition: boolean;
  PriceProtect: boolean;
  CreateTimestamp: number;
  EntryTimestamp: number;
  EventTimestamp: number;
  Builder?: { Code: string; FeeBps: number };
}

/**
 * Normalized open-order row kept in UI state. Built from REST OpenOrder or
 * from WS ORDER_TRADE_UPDATE (whose enums are uppercase Binance-style), so
 * Side/Status/Type are stored uppercase.
 */
export interface OrderRow {
  Id: number;
  ClientOrderId: string;
  Symbol: string;
  Side: string; // BUY | SELL
  Status: string; // PENDING | OPEN | NEW | ...
  Type: string; // LIMIT | MARKET | STOP | ...
  Size: string;
  Price: string;
  StopPrice: string;
  Filled: string;
  ReduceOnly: boolean;
  CreateTimestamp: number;
}
