// ── WebSocket event schemas ──
//
// Both sockets may coalesce several JSON messages into ONE text frame,
// separated by "\n". Always split frames on newlines before JSON.parse.

// ── Price Stream Events (wss://<host>/ws/price) ──

/** <symbol>@markprice (every 3s), <symbol>@markprice@1s, !markprice@arr (array). */
export interface MarkPriceUpdate {
  e: "markPriceUpdate";
  E: number; // event time (ms)
  s: string; // symbol
  p: string; // mark price
  i: string; // index price
  r: string; // HOURLY funding rate (decimal, e.g. "0.0000125")
  T: number; // next funding time (ms, next HH:00 UTC)
}

/**
 * <symbol>@depth - top-20 DIFFS (changed levels only), flushed ~every 100ms.
 * qty "0" = level removed (possibly just dropped out of the top 20).
 * Each message diffs against the server's previous publish on the channel; a
 * symbol's first subscriber receives the full top 20 (no "0" removals).
 * No snapshot is sent on subscribe: seed from GET /price/v2/depth and re-sync
 * periodically. U/u are not contiguous between events.
 */
export interface DepthUpdate {
  e: "depthUpdate";
  E: number;
  s: string;
  U: number; // first update ID in this batch
  u: number; // final update ID in this batch
  b: string[][] | null; // changed bids [[price, qty], ...]; null when unchanged
  a: string[][] | null; // changed asks; null when unchanged
}

/** <symbol>@bookticker - full best bid/ask snapshot (latest-wins). */
export interface BookTickerUpdate {
  e: "bookTicker";
  E: number;
  s: string;
  u: number;
  b: string; // best bid price ("" if none)
  B: string; // best bid qty
  a: string; // best ask price
  A: string; // best ask qty
}

/** <symbol>@trade */
export interface TradeEvent {
  e: "trade";
  E: number;
  s: string;
  t: number; // trade ID
  p: string; // price
  q: string; // quantity
  T: number; // trade time (ms)
  m: boolean; // isBuyerMaker
}

/** <symbol>@kline_<interval>[_mark|_index] - same payload for last/mark/index candles. */
export interface KlineEvent {
  e: "kline";
  E: number;
  s: string;
  k: {
    t: number; // open time (ms)
    T: number; // close time (ms)
    s: string;
    i: string; // interval
    o: string;
    c: string;
    h: string;
    l: string;
    v: string; // "0" for mark/index candles
    n: number;
    x: boolean; // closed
    q: string;
    V: string;
    Q: string;
  };
}

/** <symbol>@miniticker, !miniticker@arr (array) */
export interface MiniTickerUpdate {
  e: "24hrMiniTicker";
  E: number;
  s: string;
  c: string; // close
  o: string; // open
  h: string; // high
  l: string; // low
  v: string; // base volume
  q: string; // quote volume
}

/** Error frame (no request id): {"e":"error","E":...,"error":{"code":401,"msg":"..."}} */
export interface WsErrorFrame {
  e: "error";
  E: number;
  error: { code: number; msg: string };
}

// ── User Stream Events (wss://<host>/ws/user-api, channel "userstream") ──
// Envelope: { e: "ORDER_TRADE_UPDATE" | "ACCOUNT_UPDATE" | "strategyUpdate" | "rfqUpdate",
//             E: send time (ms), s?: symbol (strategyUpdate/rfqUpdate only), data: {...} }
// No snapshot on subscribe and no replay: load REST state after (re)subscribing.

// E is the send time (for rfqUpdate: the RFQ's updated_at_ms).
// Balance, transfer-status and order-state updates carry NO account id, so use
// one socket per account rather than mixing master and sub-account streams.
export interface UserStreamEnvelope<T> {
  e: string;
  E: number;
  s?: string;
  data: T;
}

export interface AccountUpdateBalance {
  a: string; // asset ("USDT")
  wb: string; // wallet balance
  cw: string; // cross wallet balance (same as wb)
  bc: string; // balance change (currently always "0")
}

export interface AccountUpdatePosition {
  s: string; // symbol
  pa: string; // SIGNED position amount ("0" when closed)
  ep: string; // entry price
  mt: "cross" | "isolated"; // margin type
  ib: string; // isolated balance
  ps: "LONG" | "SHORT" | "BOTH"; // BOTH = zero size
  i?: number; // position ID
  position_id?: string; // exact position ID (string)
  position_seq?: number; // fill watermark: ignore updates with a lower seq for the same position_id
  leverage?: number;
  funding_total?: string; // accumulated funding fees
  account_id?: string;
}

/**
 * ACCOUNT_UPDATE `data` (balance / position / transfer-status variants).
 * Async outcomes arrive instead as a wrapped variant - see AccountUpdateWrapped.
 * data.e (reason type):
 *   balance updates  → ORDER | FUNDING | DEPOSIT | WITHDRAW | ACCOUNT_UPDATE
 *   position updates → POSITION_OPENED | POSITION_CLOSED | POSITION_UPDATE |
 *                      PARTIAL_LIQUIDATED | FULLY_LIQUIDATED | ADL
 *   transfer status  → DEPOSIT_PENDING | DEPOSIT_FAILED | WITHDRAWAL_SETTLED | WITHDRAWAL_FAILED
 * data.r: raw engine reason for balance updates (e.g. FILL, DEPOSIT, WITHDRAWAL, FUNDING);
 *   "" for position updates; DEPOSIT or the withdrawal type for transfer status events.
 */
export interface AccountUpdateData {
  e: string;
  B: AccountUpdateBalance[];
  P: AccountUpdatePosition[];
  r: string;
  E: number;
  T: number;
  th?: string; // on-chain tx hash (transfer status)
  request_id?: string;
  asset_symbol?: string;
  asset_amount?: string; // atomic units
  usd_value?: string;
  staking_reward_balance?: string; // only when changed
  locked_reward_credit?: string; // only when changed
  // Vault accounts only
  custody_balances?: Record<string, string>;
  inventory_costs_usd?: Record<string, string>;
  conversion_reserved_usd?: string;
  slp_adl?: unknown;
}

/**
 * Wrapped ACCOUNT_UPDATE `data` (no e/B/P): async outcomes of REST calls, e.g.
 * LEVERAGE_UPDATED / LEVERAGE_UPDATE_FAILED, MARGIN_UPDATED / MARGIN_UPDATE_FAILED
 * (event_data.request_id matches the REST response request_id), plus
 * INTERNAL_TRANSFER_*, STAKING_REWARD_CLAIM_FAILED, VAULT_*, CREDIT_* events.
 */
export interface AccountUpdateWrapped {
  event_type: string;
  event_data: Record<string, unknown>;
}

/**
 * ORDER_TRADE_UPDATE `data` (Binance-style uppercase enums).
 * X (status): NEW (pending/untriggered) | OPEN (resting, possibly partially filled - check z) |
 *             FILLED | CANCELED | REJECTED | EXPIRED |
 *             PARTIALLY_FILLED (only on a fill whose order snapshot was unavailable)
 * o / ot (type): MARKET | LIMIT | STOP_MARKET (stop) | STOP (stop_limit) |
 *                TAKE_PROFIT_MARKET (take_profit) | TAKE_PROFIT (take_profit_limit) | TRAILING_STOP_MARKET
 * Order updates and fill updates are separate messages. A message is a fill
 * exactly when t > 0 (x = "TRADE" also appears on resting orders).
 */
export interface OrderTradeUpdateData {
  s: string; // symbol
  c: string; // client order ID
  S: "BUY" | "SELL"; // side
  o: string; // order type
  f: string; // time in force
  q: string; // original quantity
  p: string; // original price
  ap: string; // always ""
  sp: string; // stop price
  x: string; // execution type
  X: string; // order status
  i: number; // order ID
  cr: string; // close reason
  l: string; // this fill's qty ("" on order updates)
  z: string; // cumulative filled qty
  L: string; // this fill's price ("" on order updates)
  N: string; // commission asset ("USDT" on fills)
  n: string; // this fill's commission (negative = maker rebate)
  lf?: string; // liquidation fee
  ott: number; // order trade time (ms)
  t: number; // trade ID (0 on order updates)
  b: string; // always ""
  a: string; // always ""
  m: boolean; // is maker
  R: boolean; // reduce only
  wt: string; // working type: MARK_PRICE | CONTRACT_PRICE | ""
  ot: string; // original order type
  ps: string; // "BOTH" on fills, "" on order updates
  cp: boolean; // close position
  AP?: string; // activation price (trailing)
  CR?: string; // callback rate (trailing)
  rp: string; // realized PnL of this fill, gross of fees
  act: string; // auto close type (liquidation, adl, ...)
  E: number; // event time
  T: number; // transaction time
  account_id?: string;
  fill_id?: string;
  position_id?: string;
  position_seq?: number;
  position_context?: Record<string, unknown>; // position BEFORE this fill
  builder_fee?: string; // charged separately from n
  closing_margin?: string;
  order_id?: string; // exact order ID (string)
  trade_id?: string; // exact trade ID (string)
}

// Final statuses - remove from open orders list
export const FINAL_ORDER_STATUSES = new Set([
  "FILLED",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
]);
