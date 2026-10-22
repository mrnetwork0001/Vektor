import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "react-toastify";
import { userStream } from "../ws/userStream";
import { getAccount, getPositions, getOpenOrders, getSymbols } from "../api/account";
import type { Position, PositionResponse } from "../types/position";
import type { Account, SymbolsResponse } from "../types/account";
import type { OpenOrder, OrderRow } from "../types/order";
import {
  FINAL_ORDER_STATUSES,
  type AccountUpdateData,
  type AccountUpdatePosition,
  type OrderTradeUpdateData,
} from "../types/ws";

// ═══════════════════════════════════════════════════════════════════
// CLOSE REASON MAPPING (order `cr` / CloseReason strings)
// ═══════════════════════════════════════════════════════════════════

const CLOSE_REASON_MAP: Record<string, string> = {
  market_order_exceeded_slippage: "Market order exceeded slippage tolerance",
  insufficient_balance: "Insufficient balance",
  order_less_than_min_size: "Order below minimum size",
  order_size_exceed: "Order size exceeds maximum",
  order_less_than_min_notional: "Order below minimum notional value",
  order_size_not_multiple_of_step: "Order size is not a multiple of step size",
  order_price_out_of_limit: "Order price out of limit",
  order_price_out_of_price_cap: "Order price exceeds price cap",
  order_price_out_of_price_floor: "Order price below price floor",
  order_price_not_multiple_of_tick: "Order price is not a multiple of tick size",
  order_would_match_immediately: "Post-only order would match immediately",
  order_expired_in_match: "Order expired (self-trade prevention)",
  conditional_order_triggers_immediately: "Conditional order would trigger immediately",
  no_open_position: "No open position",
  order_increase_position: "Reduce-only order would increase position",
  liquidation: "Liquidation",
};

function mapCloseReason(reason: string): string {
  if (!reason) return "Order rejected";
  return CLOSE_REASON_MAP[reason.toLowerCase().trim()] ?? reason.replace(/_/g, " ");
}

const toNumber = (value: unknown): number => {
  const num = typeof value === "string" ? parseFloat(value) : Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
};

// ── Normalizers ──

/** GET /v2/positions row (snake_case, SIGNED size, no side field). */
function normalizePositionFromApi(raw: PositionResponse): Position {
  const signed = toNumber(raw.size);
  return {
    symbol: raw.symbol,
    size: Math.abs(signed),
    entryPrice: toNumber(raw.entry_price),
    positionSide: signed < 0 ? "SHORT" : "LONG",
    marginMode: raw.margin_mode,
    isoBalance: toNumber(raw.iso_balance),
    leverage: raw.leverage,
    accumulatedFundingFees: toNumber(raw.accumulated_funding_fees),
    id: String(raw.id),
  };
}

/** WS ACCOUNT_UPDATE data.P[] entry (pa is SIGNED, "0" when closed). */
function normalizePositionFromWs(raw: AccountUpdatePosition): Position & { seq?: number } {
  const signed = toNumber(raw.pa);
  return {
    symbol: raw.s,
    size: Math.abs(signed),
    entryPrice: toNumber(raw.ep),
    positionSide: signed < 0 ? "SHORT" : "LONG",
    marginMode: raw.mt,
    isoBalance: toNumber(raw.ib),
    leverage: raw.leverage ?? 0,
    accumulatedFundingFees: toNumber(raw.funding_total),
    id: raw.position_id ?? (raw.i !== undefined ? String(raw.i) : undefined),
    seq: raw.position_seq,
  };
}

/** Merge WS position updates (one-way mode: keyed by symbol; drop on size 0). */
function mergePositions(
  current: Position[],
  updates: (Position & { seq?: number })[],
  seqs: Map<string, number>
): Position[] {
  if (!updates.length) return current;
  const map = new Map(current.map((p) => [p.symbol, p]));

  for (const { seq, ...update } of updates) {
    const existing = map.get(update.symbol);
    // Ignore stale updates (lower position_seq for the same position)
    const seqKey = `${update.symbol}:${update.id}`;
    if (seq !== undefined && existing?.id === update.id && seq < (seqs.get(seqKey) ?? 0)) continue;
    if (seq !== undefined) seqs.set(seqKey, seq);

    if (update.size === 0) {
      map.delete(update.symbol);
    } else {
      map.set(update.symbol, {
        ...update,
        leverage: update.leverage || existing?.leverage || 0,
      });
    }
  }
  return Array.from(map.values());
}

/** REST open order (PascalCase engine model, lowercase enums) → OrderRow. */
function normalizeOrderFromApi(raw: OpenOrder): OrderRow {
  return {
    Id: raw.ID,
    ClientOrderId: raw.ClientOrderID,
    Symbol: raw.Symbol,
    Side: String(raw.Side).toUpperCase(),
    Status: String(raw.Status).toUpperCase(),
    Type: String(raw.Type).toUpperCase(),
    Size: raw.Size,
    Price: raw.Price,
    StopPrice: raw.StopPrice,
    Filled: raw.Filled,
    ReduceOnly: raw.ReduceOnly,
    CreateTimestamp: raw.CreateTimestamp,
  };
}

// ═══════════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════════

/**
 * User data: REST state + /ws/user-api updates.
 *
 * 1. Connect the user stream (session.logon → subscribe "userstream")
 * 2. On every subscribe ack (initial and after reconnects), reload REST state:
 *    /v2/account, /v2/symbols, /v2/positions, /v2/openOrders
 * 3. ACCOUNT_UPDATE: wallet balance (B[0].wb) + positions (P)
 * 4. ORDER_TRADE_UPDATE: open orders list + fill toasts (fills: t > 0)
 */
export function useUserStream(accountId: string | null) {
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [account, setAccount] = useState<Account | null>(null);
  const [symbols, setSymbols] = useState<SymbolsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const isMountedRef = useRef(true);
  const positionSeqRef = useRef(new Map<string, number>());
  const lastWalletRef = useRef<number | null>(null);

  // Toast deduplication cache
  const toastCacheRef = useRef<Map<string, number>>(new Map());

  // Order update buffer — 300ms batching (replace = cancel + new)
  const orderBufferRef = useRef<OrderTradeUpdateData[]>([]);
  const orderFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (orderFlushTimerRef.current) {
        clearTimeout(orderFlushTimerRef.current);
        orderFlushTimerRef.current = null;
      }
    };
  }, []);

  const loadRest = useCallback(async () => {
    setIsLoading(true);
    const [acc, syms, pos, ords] = await Promise.all([
      getAccount().catch((e) => { console.error("[useUserStream] getAccount failed:", e); return null; }),
      getSymbols().catch((e) => { console.error("[useUserStream] getSymbols failed:", e); return null; }),
      getPositions().catch((e) => { console.error("[useUserStream] getPositions failed:", e); return null; }),
      getOpenOrders().catch((e) => { console.error("[useUserStream] getOpenOrders failed:", e); return null; }),
    ]);
    if (!isMountedRef.current) return;
    if (acc) {
      setAccount(acc);
      lastWalletRef.current = toNumber(acc.wallet_balance);
    }
    if (syms) setSymbols(syms);
    if (pos) setPositions(pos.map(normalizePositionFromApi));
    if (ords) setOrders(ords.map(normalizeOrderFromApi));
    setIsLoading(false);
  }, []);

  /** Re-read effective symbol settings (e.g. after a leverage / margin mode change). */
  const refreshSymbols = useCallback(() => {
    getSymbols().then((s) => isMountedRef.current && setSymbols(s)).catch(() => {});
  }, []);

  // ── ORDER_TRADE_UPDATE toasts ──
  const showOrderToast = useCallback((d: OrderTradeUpdateData) => {
    const status = (d.X ?? "").toUpperCase();
    const isFill = d.t > 0; // only fill updates carry a trade ID
    if (!isFill && status !== "REJECTED" && status !== "CANCELED") return;

    const key = isFill ? `fill-${d.t}-${d.i}` : `${d.i}-${status}`;
    const cache = toastCacheRef.current;
    if (cache.has(key)) return;
    cache.set(key, Date.now());
    if (cache.size > 200) {
      const cutoff = Date.now() - 60000;
      for (const [k, ts] of cache) if (ts < cutoff) cache.delete(k);
    }

    const side = d.S === "BUY" ? "Buy" : "Sell";
    if (isFill) {
      const price = parseFloat(d.L);
      toast.success(`Filled: ${side} ${d.l} ${d.s} at $${Number.isFinite(price) ? price : d.L} (fee ${d.n})`);
    } else if (status === "REJECTED") {
      toast.error(mapCloseReason(d.cr));
    } else if (d.cr === "market_order_exceeded_slippage") {
      toast.error(mapCloseReason(d.cr));
    } else {
      toast.success(`Order Cancelled: ${side} ${d.q} ${d.s}`);
    }
  }, []);

  // ── Buffered order state update (300ms batching) ──
  const bufferOrderUpdate = useCallback((d: OrderTradeUpdateData) => {
    orderBufferRef.current.push(d);
    if (!orderFlushTimerRef.current) {
      orderFlushTimerRef.current = setTimeout(() => {
        const batch = orderBufferRef.current.splice(0);
        orderFlushTimerRef.current = null;
        if (batch.length === 0) return;
        setOrders((prev) => batch.reduce(applyOrderUpdate, prev));
      }, 300);
    }
  }, []);

  // ── WS: connect, then load REST after each subscribe ack ──
  useEffect(() => {
    if (!accountId) {
      setAccount(null);
      setSymbols(null);
      setPositions([]);
      setOrders([]);
      return;
    }

    const unsubSubscribed = userStream.on("subscribed", () => {
      if (isMountedRef.current) loadRest();
    });

    const unsubAccount = userStream.on("ACCOUNT_UPDATE", (data: any) => {
      if (!isMountedRef.current || !data) return;

      // Wrapped async outcomes: { event_type, event_data }
      if (data.event_type) {
        const ev = data.event_type as string;
        if (ev === "LEVERAGE_UPDATED" || ev === "MARGIN_UPDATED") refreshSymbols();
        if (ev.endsWith("_FAILED")) toast.error(`${ev}: ${String(data.event_data?.error ?? "")}`);
        return;
      }

      const d = data as AccountUpdateData;

      // Wallet balance (balance + position updates carry B[0].wb)
      // (bc is always "0", so a deposit amount is derived from the wb delta)
      const wb = d.B?.[0]?.wb;
      if (wb !== undefined) {
        const prevWallet = lastWalletRef.current;
        lastWalletRef.current = toNumber(wb);
        if (d.e === "DEPOSIT" && prevWallet !== null && toNumber(wb) > prevWallet) {
          toast.success(`Deposit credited: +$${(toNumber(wb) - prevWallet).toFixed(2)}`);
        }
        setAccount((prev) => (prev ? { ...prev, wallet_balance: String(wb) } : prev));
      }

      // Positions
      if (d.P?.length) {
        const updates = d.P.map(normalizePositionFromWs);
        setPositions((prev) => mergePositions(prev, updates, positionSeqRef.current));
      }

      // data.e is the reason type
      const symbol = d.P?.[0]?.s || "position";
      switch (d.e) {
        case "PARTIAL_LIQUIDATED":
          toast.error(`Your ${symbol} position was partially liquidated`);
          break;
        case "FULLY_LIQUIDATED":
          toast.error(`Your ${symbol} position was fully liquidated`);
          break;
        case "ADL":
          toast.error(`Your ${symbol} position was auto-deleveraged`);
          break;
        case "DEPOSIT_PENDING":
          toast.info("Deposit detected on-chain, awaiting confirmations");
          break;
        case "DEPOSIT_FAILED":
          toast.error("Deposit failed");
          break;
        case "WITHDRAWAL_SETTLED":
          toast.success(`Withdrawal settled${d.th ? ` (tx ${d.th.slice(0, 10)}…)` : ""}`);
          break;
        case "WITHDRAWAL_FAILED":
          toast.error("Withdrawal failed");
          break;
      }
    });

    const unsubOrder = userStream.on("ORDER_TRADE_UPDATE", (data: OrderTradeUpdateData) => {
      if (!isMountedRef.current || !data) return;
      showOrderToast(data);
      bufferOrderUpdate(data);
    });

    userStream.connect();

    return () => {
      unsubSubscribed();
      unsubAccount();
      unsubOrder();
      userStream.disconnect();
    };
  }, [accountId, loadRest, refreshSymbols, showOrderToast, bufferOrderUpdate]);

  const walletBalance = account ? parseFloat(account.wallet_balance || "0") : 0;

  return { positions, orders, walletBalance, account, symbols, refreshSymbols, isLoading };
}

// ═══════════════════════════════════════════════════════════════════
// ORDER STATE UPDATE
// ═══════════════════════════════════════════════════════════════════

/** WS order type names (Binance-style) → REST names, uppercased. */
const WS_TYPE_TO_REST: Record<string, string> = {
  MARKET: "MARKET",
  LIMIT: "LIMIT",
  STOP_MARKET: "STOP",
  STOP: "STOP_LIMIT",
  TAKE_PROFIT_MARKET: "TAKE_PROFIT",
  TAKE_PROFIT: "TAKE_PROFIT_LIMIT",
  TRAILING_STOP_MARKET: "TRAILING_STOP_MARKET",
};

function applyOrderUpdate(current: OrderRow[], d: OrderTradeUpdateData): OrderRow[] {
  const status = String(d.X ?? "").toUpperCase();
  const index = current.findIndex(
    (o) => o.Id === d.i || (d.c && o.ClientOrderId === d.c)
  );

  // Fill updates (t > 0) only carry the fill; the order update that follows has the new z / X.
  if (d.t > 0) {
    if (index === -1) return current;
    if (FINAL_ORDER_STATUSES.has(status)) return current.filter((_, i) => i !== index);
    const updated = [...current];
    updated[index] = { ...updated[index], Filled: d.z || updated[index].Filled };
    return updated;
  }

  if (FINAL_ORDER_STATUSES.has(status)) {
    return index === -1 ? current : current.filter((_, i) => i !== index);
  }

  const row: OrderRow = {
    Id: d.i,
    ClientOrderId: d.c,
    Symbol: d.s,
    Side: d.S,
    Status: status, // NEW | OPEN
    Type: WS_TYPE_TO_REST[d.o] ?? d.o,
    Size: d.q,
    Price: d.p,
    StopPrice: d.sp,
    Filled: d.z,
    ReduceOnly: d.R,
    CreateTimestamp: index === -1 ? d.T : current[index].CreateTimestamp,
  };

  if (index === -1) return [row, ...current];
  const updated = [...current];
  updated[index] = row;
  return updated;
}
