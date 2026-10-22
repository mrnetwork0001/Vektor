// ── Demo-mode matching engine ──
//
// A tiny in-memory exchange with the same ExecutionAdapter surface as the live
// Strike client, so the grid, harvester and shield run unchanged. Limit orders
// fill when the mark crosses them, market/IOC orders fill at the mark, fees
// mirror Strike's maker/taker + builder-fee formula.

import type { CreateOrderRequest, CreateStrategyOrderRequest } from "../types/order";
import type { Position } from "../types/position";
import type { Market } from "../types/market";
import { getMMR, getMaintenanceAmount } from "../math/marginTiers";
import { calculateIsolatedLiquidationPrice } from "../math/positionCalculations";
import type { ExecutionAdapter, FeeContext, FillEvent } from "../quant/types";

interface SimOrder {
  cid: string;
  id: number;
  req: CreateOrderRequest;
  size: number;
  filled: number;
  price: number;
  createdAt: number;
}

export interface SimPosition { symbol: string; size: number; entry: number; leverage: number; isoBalance: number; realized: number }

export interface SimSnapshot {
  wallet: number;
  positions: Position[];
  openOrders: SimOrder[];
  fills: FillEvent[];
  volumeUsd: number;
  builderFeesUsd: number;
  commissionUsd: number;
}

export class SimExchange implements ExecutionAdapter {
  readonly mode = "sim" as const;
  private orders = new Map<string, SimOrder>();
  /** Bracket SL legs waiting for their primary to fill (keyed by primary cid), and armed stop-markets (keyed by their own cid). */
  private pendingStops = new Map<string, SimOrder>();
  private stops = new Map<string, SimOrder>();
  private positions = new Map<string, SimPosition>();
  private marks = new Map<string, number>();
  private listeners = new Set<(f: FillEvent) => void>();
  private nextId = 1;
  private fills: FillEvent[] = [];
  wallet: number;
  volumeUsd = 0;
  builderFeesUsd = 0;
  commissionUsd = 0;
  leverage = 3;

  constructor(public fees: FeeContext, public markets: Record<string, Market>, startingWallet = 10_000) {
    this.wallet = startingWallet;
  }

  setLeverage(lev: number) { this.leverage = lev; }
  mark(symbol: string) { return this.marks.get(symbol) ?? 0; }

  onFill(cb: (f: FillEvent) => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }

  async placeBatch(orders: CreateOrderRequest[]) {
    const accepted: string[] = [];
    const failed: { index: number; error: string }[] = [];
    orders.forEach((req, index) => {
      const cid = req.client_order_id ?? `sim-${this.nextId}`;
      const size = parseFloat(req.size);
      const mark = this.mark(req.symbol);
      if (!(size > 0)) { failed.push({ index, error: "order_less_than_min_size" }); return; }
      const o: SimOrder = { cid, id: this.nextId++, req, size, filled: 0, price: parseFloat(req.price ?? "0"), createdAt: Date.now() };
      if (req.type === "market") { this.fill(o, mark, false); accepted.push(cid); return; }
      // post-only that would cross → reject like the engine does
      const crosses = req.side === "buy" ? o.price >= mark : o.price <= mark;
      if (req.post_only && crosses) { this.emit(o, 0, 0, "REJECTED", "order_would_match_immediately"); failed.push({ index, error: "order_would_match_immediately" }); return; }
      if (req.time_in_force === "IOC") {
        if (crosses) this.fill(o, mark, false); else this.emit(o, 0, 0, "EXPIRED");
        accepted.push(cid); return;
      }
      this.orders.set(cid, o);
      this.emit(o, 0, 0, "OPEN");
      accepted.push(cid);
    });
    return { accepted, failed };
  }

  /**
   * Mirror of POST /v2/order/strategy with an sl_order leg: the primary rests
   * like a limit; once it fully fills, a reduce-only stop-market is armed that
   * triggers when the mark crosses stop_price.
   */
  async placeStrategy(req: CreateStrategyOrderRequest) {
    const { sl_order, strategy_id, tp_order, ...primary } = req;
    const res = await this.placeBatch([primary as CreateOrderRequest]);
    if (!sl_order || res.failed.length) return;
    const primaryCid = primary.client_order_id!;
    const stopReq: CreateOrderRequest = {
      client_order_id: sl_order.client_order_id ?? `${primaryCid}-sl`, symbol: req.symbol,
      side: req.side === "buy" ? "sell" : "buy", type: "stop", size: sl_order.size, stop_price: sl_order.stop_price,
      working_type: sl_order.working_type ?? "mark_price", reduce_only: true,
    };
    const stop: SimOrder = { cid: stopReq.client_order_id!, id: this.nextId++, req: stopReq, size: parseFloat(sl_order.size), filled: 0, price: parseFloat(sl_order.stop_price), createdAt: Date.now() };
    // A primary that filled synchronously (not possible for post-only, but keep it correct) arms immediately.
    if (this.orders.has(primaryCid)) this.pendingStops.set(primaryCid, stop); else this.armStop(stop);
  }

  private armStop(stop: SimOrder) {
    this.stops.set(stop.cid, stop);
    this.emit(stop, 0, 0, "OPEN");
  }

  async cancel(_symbol: string, cid: string) {
    const o = this.orders.get(cid) ?? this.stops.get(cid);
    if (!o) return;
    this.orders.delete(cid);
    this.stops.delete(cid);
    // cancelling an unfilled primary drops its unarmed stop leg too
    const pending = this.pendingStops.get(cid);
    if (pending) { this.pendingStops.delete(cid); this.emit(pending, 0, 0, "CANCELED"); }
    this.emit(o, 0, 0, "CANCELED");
  }

  async cancelAll(symbol?: string) {
    for (const o of [...this.orders.values(), ...this.stops.values()]) if (!symbol || o.req.symbol === symbol) await this.cancel(o.req.symbol, o.cid);
  }

  /** Mirror of POST /v2/orders/replace: cancel everything on the symbol, then place (auto-shift grid). */
  async replaceAll(symbol: string, orders: Omit<CreateOrderRequest, "symbol">[]) {
    await this.cancelAll(symbol);
    return this.placeBatch(orders.map((o) => ({ ...o, symbol })));
  }

  /** Advance the mark; resting limits that are crossed fill at their limit price. */
  setMark(symbol: string, price: number) {
    this.marks.set(symbol, price);
    for (const o of [...this.orders.values()]) {
      if (o.req.symbol !== symbol) continue;
      const hit = o.req.side === "buy" ? price <= o.price : price >= o.price;
      if (hit) {
        this.orders.delete(o.cid);
        this.fill(o, o.price, true);
        const stop = this.pendingStops.get(o.cid);
        if (stop && o.filled >= o.size - 1e-12) { this.pendingStops.delete(o.cid); this.armStop(stop); }
      }
    }
    // Armed stop-markets: sell stops trigger at/below, buy stops at/above; fill as taker at the mark.
    for (const s of [...this.stops.values()]) {
      if (s.req.symbol !== symbol) continue;
      const trig = s.req.side === "sell" ? price <= s.price : price >= s.price;
      if (trig) { this.stops.delete(s.cid); this.fill(s, price, false); }
    }
  }

  private fill(o: SimOrder, price: number, isMaker: boolean) {
    let qty = o.size - o.filled;
    const pos = this.positions.get(o.req.symbol);
    if (o.req.reduce_only || o.req.close_position) {
      const open = Math.abs(pos?.size ?? 0);
      const reduces = pos && ((o.req.side === "sell" && pos.size > 0) || (o.req.side === "buy" && pos.size < 0));
      if (!reduces || open <= 0) { this.emit(o, 0, 0, "REJECTED", "no_open_position"); return; }
      qty = Math.min(qty, open);
    }
    o.filled += qty;
    const notional = qty * price;
    const rate = isMaker ? this.fees.makerRate : this.fees.takerRate;
    const commission = notional * rate;
    const builderFee = Math.floor(((notional * this.fees.builderFeeBps) / 10000) * 100) / 100;
    this.applyToPosition(o.req.symbol, o.req.side === "buy" ? qty : -qty, price);
    this.wallet -= commission + builderFee;
    this.volumeUsd += notional;
    this.builderFeesUsd += builderFee;
    this.commissionUsd += commission;
    this.emit(o, qty, price, "FILLED", undefined, isMaker, commission, builderFee);
  }

  private applyToPosition(symbol: string, signedQty: number, price: number) {
    const p = this.positions.get(symbol) ?? { symbol, size: 0, entry: 0, leverage: this.leverage, isoBalance: 0, realized: 0 };
    const sameDir = p.size === 0 || Math.sign(p.size) === Math.sign(signedQty);
    if (sameDir) {
      const newSize = p.size + signedQty;
      p.entry = newSize !== 0 ? (p.entry * Math.abs(p.size) + price * Math.abs(signedQty)) / Math.abs(newSize) : 0;
      p.isoBalance += (Math.abs(signedQty) * price) / p.leverage;
      p.size = newSize;
    } else {
      const closeQty = Math.min(Math.abs(p.size), Math.abs(signedQty));
      const pnl = (price - p.entry) * closeQty * Math.sign(p.size);
      p.realized += pnl;
      this.wallet += pnl;
      const fraction = closeQty / Math.abs(p.size);
      p.isoBalance -= p.isoBalance * fraction;
      p.size += signedQty;
      if (Math.abs(p.size) < 1e-12) { p.size = 0; p.entry = 0; p.isoBalance = 0; }
      else if (Math.sign(p.size) === Math.sign(signedQty)) { p.entry = price; p.isoBalance = (Math.abs(p.size) * price) / p.leverage; }
    }
    this.positions.set(symbol, p);
  }

  private emit(o: SimOrder, qty: number, price: number, status: FillEvent["status"], closeReason?: string, isMaker = true, commission = 0, builderFee = 0) {
    const f: FillEvent = {
      symbol: o.req.symbol, clientOrderId: o.cid, orderId: o.id, side: o.req.side === "buy" ? "BUY" : "SELL",
      fillQty: qty, fillPrice: price, cumFilled: o.filled, orderQty: o.size, isMaker, commission, builderFee,
      timestamp: Date.now(), status, closeReason,
    };
    if (qty > 0) this.fills.push(f);
    for (const cb of this.listeners) cb(f);
  }

  /** Flash-crash style liquidation: if mark crosses the liq price, the engine closes the position. */
  checkLiquidations(): string[] {
    const liquidated: string[] = [];
    for (const p of this.positions.values()) {
      if (p.size === 0) continue;
      const liq = this.liqPrice(p);
      const mark = this.mark(p.symbol);
      if (liq > 0 && ((p.size > 0 && mark <= liq) || (p.size < 0 && mark >= liq))) {
        this.wallet -= p.isoBalance; // margin lost
        p.size = 0; p.entry = 0; p.isoBalance = 0;
        liquidated.push(p.symbol);
      }
    }
    return liquidated;
  }

  private liqPrice(p: SimPosition): number {
    const market = this.markets[p.symbol] ?? null;
    const notional = Math.abs(p.size) * this.mark(p.symbol);
    return calculateIsolatedLiquidationPrice(p.entry, p.size, p.isoBalance, getMMR(market, notional), getMaintenanceAmount(market, notional));
  }

  snapshot(): SimSnapshot {
    const positions: Position[] = [];
    for (const p of this.positions.values()) {
      if (p.size === 0) continue;
      const mark = this.mark(p.symbol);
      const notional = Math.abs(p.size) * mark;
      const market = this.markets[p.symbol] ?? null;
      const mm = notional * getMMR(market, notional) - getMaintenanceAmount(market, notional);
      const upnl = (mark - p.entry) * p.size;
      positions.push({
        symbol: p.symbol, size: Math.abs(p.size), entryPrice: p.entry, positionSide: p.size > 0 ? "LONG" : "SHORT",
        marginMode: "isolated", isoBalance: p.isoBalance, leverage: p.leverage, accumulatedFundingFees: 0,
        uPnL: upnl, notional, currentMargin: p.isoBalance, maintenanceMargin: mm, markPrice: mark,
        marginRatio: p.isoBalance + upnl > 0 ? (mm / (p.isoBalance + upnl)) * 100 : 100,
        liquidationPrice: this.liqPrice(p),
        pnlPercentage: p.isoBalance > 0 ? (upnl / p.isoBalance) * 100 : 0,
      });
    }
    return { wallet: this.wallet, positions, openOrders: [...this.orders.values()], fills: this.fills.slice(-100), volumeUsd: this.volumeUsd, builderFeesUsd: this.builderFeesUsd, commissionUsd: this.commissionUsd };
  }
}
