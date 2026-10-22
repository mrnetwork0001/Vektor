/**
 * AccountEngine: one tenant's grids + shield, run server-side so they keep
 * working after the browser tab closes. Same pure engines as the terminal and
 * the single-account worker; I/O goes through an injected client so tests can
 * drive it with a fake.
 */

import { toFillEvent } from "../src/quant/fillEvent";
import { fix, type FeeContext, type FillEvent, type MarketRules } from "../src/quant/types";
import type { Market } from "../src/types/market";
import type { Position, PositionResponse } from "../src/types/position";
import type { CreateOrderRequest, CreateStrategyOrderRequest, OpenOrder } from "../src/types/order";
import { enrichPositionWithDerived, applyCrossLiquidationPrices } from "../src/math/positionCalculations";
import { adoptGridsFromOpenOrders, applyGridFill, buildDeployStrategies, dropResting, initGridState, parseRungClientId, planGrid, reconcileGrid, restingBuyIds, restingIds, type GridConfig, type GridState } from "../src/quant/gridEngine";
import { buildShiftedPlan, shouldShift } from "../src/quant/gridShift";
import { backfillGrid, telemetryFromFills } from "../src/quant/backfill";
import { buildFlattenOrders, evaluateShield, initShieldState, resolveTrim, type PositionHealth, type ShieldState } from "../src/quant/liquidationShield";
import type { RegimeAssessment } from "../src/quant/regime";

export interface EngineClient {
  call<T = any>(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<{ status: number; json: T }>;
  userStream(h: { onEvent: (e: string, data: any) => void; onSubscribed: () => void; log: (m: string) => void }): () => void;
}

/** Market data shared by every tenant (one price stream, one regime poller). */
export interface MarketHub {
  markets: Record<string, Market>;
  marks: Record<string, { p: number; r: number }>;
  regime: Record<string, RegimeAssessment>;
}

export interface GridRequest extends Omit<GridConfig, "markPrice"> {
  autoShift?: boolean;
  regimeGuard?: boolean;
}

export interface EngineSnapshot {
  grids: Record<string, GridState>;
  options: Record<string, { autoShift: boolean; regimeGuard: boolean }>;
  held: Record<string, CreateOrderRequest[]>;
  shield: ShieldState;
  telemetry: Telemetry;
}
interface Telemetry { volumeUsd: number; builderFeesUsd: number; commissionUsd: number; fills: number; ordersPlaced: number }

export interface EngineOptions {
  builderFeeBps: number; // already capped at the tenant's approval
  log: (m: string) => void;
  persist: (s: EngineSnapshot) => void;
  now?: () => number;
}

const normalize = (raw: PositionResponse): Position => {
  const signed = parseFloat(raw.size);
  return { symbol: raw.symbol, size: Math.abs(signed), entryPrice: parseFloat(raw.entry_price), positionSide: signed < 0 ? "SHORT" : "LONG", marginMode: raw.margin_mode, isoBalance: parseFloat(raw.iso_balance), leverage: raw.leverage, accumulatedFundingFees: parseFloat(raw.accumulated_funding_fees), id: String(raw.id) };
};

export class AccountEngine {
  grids: Record<string, GridState> = {};
  options: EngineSnapshot["options"] = {};
  held: Record<string, CreateOrderRequest[]> = {};
  shield: ShieldState = initShieldState();
  telemetry: Telemetry = { volumeUsd: 0, builderFeesUsd: 0, commissionUsd: 0, fills: 0, ordersPlaced: 0 };
  healths: PositionHealth[] = [];
  wallet = 0;
  rawPositions: Position[] = [];
  fees: FeeContext;
  lastEvent = 0;
  private pending = new Map<string, { symbol: string; t: number }>();
  private edgeStreak: Record<string, number> = {};
  private shifting = new Set<string>();
  private lastFillAt: Record<string, number> = {};
  private timers: ReturnType<typeof setInterval>[] = [];
  private closeStream: (() => void) | null = null;
  private booted = false;

  constructor(private client: EngineClient, private hub: MarketHub, private opts: EngineOptions, snap?: Partial<EngineSnapshot>) {
    this.fees = { makerRate: 0, takerRate: 0.0005, builderFeeBps: opts.builderFeeBps };
    if (snap) {
      this.grids = snap.grids ?? {};
      this.options = snap.options ?? {};
      this.held = snap.held ?? {};
      if (snap.shield) this.shield = { ...initShieldState(snap.shield.rules), log: snap.shield.log ?? [] };
      if (snap.telemetry) this.telemetry = { ...this.telemetry, ...snap.telemetry };
    }
  }

  private now() { return this.opts.now ? this.opts.now() : Date.now(); }
  private log(m: string) { this.opts.log(m); }
  snapshot(): EngineSnapshot { return { grids: this.grids, options: this.options, held: this.held, shield: this.shield, telemetry: this.telemetry }; }
  private persist() { this.opts.persist(this.snapshot()); }
  private builderHeaders(): Record<string, string> { return this.fees.builderFeeBps > 0 ? { "X-Builder-Fee-Bps": String(Math.floor(this.fees.builderFeeBps)) } : {}; }

  rulesFor = (s: string): MarketRules => {
    const m = this.hub.markets[s];
    if (!m) throw new Error(`unknown market ${s}`);
    return { symbol: s, tick: parseFloat(m.order_tick_price), stepSize: parseFloat(m.order_limit_step_size), minSize: parseFloat(m.order_limit_min_size), minNotional: parseFloat(m.order_min_notional), basePrec: m.base_prec, quotePrec: m.quote_prec };
  };

  // ── lifecycle ──
  async start() {
    try {
      const p = await this.client.call("GET", "/v2/portfolio");
      const tier = p.json.fee_tiers?.find((t: any) => t.Tier === p.json.fee_tier);
      if (tier) this.fees = { ...this.fees, takerRate: tier.TakerRate, makerRate: p.json.maker_fee_rate_override != null && p.json.maker_fee_rate_override !== "" ? parseFloat(p.json.maker_fee_rate_override) : tier.MakerRate };
    } catch (e: any) { this.log(`fee tier lookup failed, defaults used: ${e.message}`); }
    this.closeStream = this.client.userStream({
      log: (m) => this.log(m),
      onEvent: (e, data) => this.onStreamEvent(e, data),
      onSubscribed: () => void this.onSubscribed(),
    });
    this.timers.push(setInterval(() => this.shieldTick(), 2000));
    this.timers.push(setInterval(() => void this.watchdog(), 4000));
    this.timers.push(setInterval(() => void this.autoShiftTick(), 3000));
    this.timers.push(setInterval(() => this.regimeTick(), 5000));
    this.timers.push(setInterval(() => void this.loadRest().catch(() => {}), 60_000));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.closeStream?.();
    this.closeStream = null;
  }

  private async onSubscribed() {
    try {
      const openOrders = await this.loadRest();
      const openIds = new Set(openOrders.map((o) => o.ClientOrderID));
      if (!this.booted) { this.booted = true; await this.recover(openOrders); }
      else { for (const [sym, g] of Object.entries(this.grids)) this.grids[sym] = reconcileGrid(g, openIds).state; this.persist(); }
    } catch (e: any) { this.log(`REST load failed: ${e.message}`); }
  }

  async loadRest(): Promise<OpenOrder[]> {
    const [acc, pos, open] = await Promise.all([
      this.client.call("GET", "/v2/account"),
      this.client.call<{ positions: PositionResponse[] | null }>("GET", "/v2/positions"),
      this.client.call<{ orders: OpenOrder[] | null }>("GET", "/v2/openOrders"),
    ]);
    this.wallet = parseFloat(acc.json.wallet_balance ?? "0");
    this.rawPositions = (pos.json.positions ?? []).map(normalize);
    return open.json.orders ?? [];
  }

  /** Boot: backfill fills that happened while down, reconcile against the book, adopt unknown Vektor rungs. */
  async recover(openOrders: OpenOrder[]) {
    const openIds = new Set(openOrders.map((o) => o.ClientOrderID));
    let fills: any[] = [];
    try { fills = (await this.client.call<{ fills: any[] | null }>("GET", "/v2/history/fill?limit=1000")).json.fills ?? []; } catch (e: any) { this.log(`fill history: ${e.message}`); }
    const t = telemetryFromFills(fills, this.fees.builderFeeBps);
    this.telemetry = { ...this.telemetry, ...t };
    for (const [sym, g] of Object.entries(this.grids)) {
      const b = backfillGrid(g, fills, this.fees.builderFeeBps, this.safeRules(sym));
      const r = reconcileGrid(b.state, openIds);
      const missing = b.orders.filter((o) => !openIds.has(o.client_order_id!));
      if (r.kept === 0 && missing.length === 0) { delete this.grids[sym]; this.log(`${sym}: nothing left on the book, grid closed`); continue; }
      this.grids[sym] = r.state;
      this.log(`${sym}: backfilled ${b.replayed}, kept ${r.kept}, dropped ${r.dropped}, re-placing ${missing.length}`);
      if (missing.length) await this.place(missing);
    }
    const known = new Set(Object.values(this.grids).flatMap((g) => restingIds(g)));
    const orphans = openOrders
      .filter((o) => parseRungClientId(o.ClientOrderID) && !known.has(o.ClientOrderID) && !this.grids[o.Symbol])
      .map((o) => ({ ClientOrderId: o.ClientOrderID, Symbol: o.Symbol, Side: o.Side, Size: o.Size, Price: o.Price }));
    if (orphans.length) {
      const adopted = adoptGridsFromOpenOrders(orphans, this.rulesFor, this.fees);
      for (const [sym, g] of Object.entries(adopted)) { this.grids[sym] = g; this.options[sym] ??= { autoShift: false, regimeGuard: true }; this.log(`${sym}: adopted ${restingIds(g).length} resting rung(s)`); }
    }
    this.persist();
  }

  private safeRules(sym: string): MarketRules | undefined { try { return this.rulesFor(sym); } catch { return undefined; } }

  // ── execution ──
  async place(orders: CreateOrderRequest[]) {
    if (!orders.length) return;
    try {
      const { json } = await this.client.call<{ failed: { index: number; error: string }[] | null }>("POST", "/v2/orders/batch", { orders }, this.builderHeaders());
      const failed = new Set((json?.failed ?? []).map((f) => f.index));
      orders.forEach((o, i) => { if (!failed.has(i) && o.client_order_id) this.pending.set(o.client_order_id, { symbol: o.symbol, t: this.now() }); });
      this.telemetry.ordersPlaced += orders.length - failed.size;
      if (failed.size) this.log(`batch: ${failed.size} rejected ${JSON.stringify(json.failed)}`);
    } catch (e: any) { this.log(`place failed: ${e.message}`); }
    this.persist();
  }
  private async placeStrategy(req: CreateStrategyOrderRequest) {
    try { await this.client.call("POST", "/v2/order/strategy", req, this.builderHeaders()); this.telemetry.ordersPlaced += 1; }
    catch (e: any) { this.log(`strategy ${req.client_order_id}: ${e.message}`); }
  }
  private async cancel(symbol: string, clientOrderId: string) {
    try { await this.client.call("DELETE", "/v2/order/cancel", { symbol, client_order_id: clientOrderId }); } catch (e: any) { this.log(`cancel ${clientOrderId}: ${e.message}`); }
  }

  // ── stream ──
  onStreamEvent(e: string, data: any) {
    this.lastEvent = this.now();
    if (e === "ORDER_TRADE_UPDATE" && data) this.onFill(toFillEvent(data));
    if (e === "ACCOUNT_UPDATE" && data && !data.event_type) {
      if (data.B?.[0]?.wb !== undefined) this.wallet = parseFloat(data.B[0].wb);
      for (const P of data.P ?? []) {
        const signed = parseFloat(P.pa);
        this.rawPositions = this.rawPositions.filter((p) => p.symbol !== P.s);
        if (signed !== 0) this.rawPositions.push({ symbol: P.s, size: Math.abs(signed), entryPrice: parseFloat(P.ep), positionSide: signed < 0 ? "SHORT" : "LONG", marginMode: P.mt, isoBalance: parseFloat(P.ib), leverage: P.leverage ?? 0, accumulatedFundingFees: parseFloat(P.funding_total ?? "0"), id: P.position_id });
      }
      if (["PARTIAL_LIQUIDATED", "FULLY_LIQUIDATED", "ADL"].includes(data.e)) this.log(`ENGINE ${data.e} ${data.P?.[0]?.s}`);
    }
  }

  onFill(f: FillEvent) {
    this.pending.delete(f.clientOrderId);
    const parsed = parseRungClientId(f.clientOrderId);
    const g = parsed ? Object.values(this.grids).find((x) => x.plan.gridId === parsed.gridId) : undefined;
    const before = g?.fills;
    if (g) {
      const sym = g.plan.config.symbol;
      const r = applyGridFill(g, f, this.now(), this.safeRules(sym));
      if (r.state === g && f.fillQty > 0) return; // duplicate delivery (trade id already applied)
      this.grids[sym] = r.state;
      if (f.fillQty > 0) { this.lastFillAt[sym] = this.now(); this.log(`${sym} ${f.side} ${f.fillQty} @ ${f.fillPrice} rung ${parsed!.index}(${parsed!.role}) → ${r.orders.length} counter`); }
      for (const id of r.cancel) void this.cancel(sym, id);
      if (r.orders.length) {
        if (this.isPaused(sym)) { this.held[sym] = [...(this.held[sym] ?? []), ...r.orders]; this.log(`${sym}: regime PAUSE - ${r.orders.length} counter(s) held`); }
        else void this.place(r.orders);
      }
      for (const s of r.strategies) void this.placeStrategy(s);
    }
    if (f.fillQty > 0 && (!g || this.grids[g.plan.config.symbol]?.fills !== before)) {
      this.telemetry.fills++; this.telemetry.volumeUsd = fix(this.telemetry.volumeUsd + f.fillQty * f.fillPrice, 2);
      this.telemetry.builderFeesUsd = fix(this.telemetry.builderFeesUsd + f.builderFee, 4); this.telemetry.commissionUsd = fix(this.telemetry.commissionUsd + f.commission, 6);
    }
    if (f.clientOrderId.startsWith("vektor-shield-trim") && ["FILLED", "CANCELED", "REJECTED", "EXPIRED"].includes(f.status)) this.shield = resolveTrim(this.shield, f.clientOrderId, f.status);
    this.persist();
  }

  // ── grids ──
  async deployGrid(req: GridRequest) {
    const { autoShift = false, regimeGuard = true, ...cfg } = req;
    const sym = cfg.symbol;
    const mark = this.hub.marks[sym]?.p ?? parseFloat(this.hub.markets[sym]?.mark_price ?? "0");
    if (!mark) throw new Error(`no mark price for ${sym}`);
    const rec = this.hub.regime[sym]?.recommendation;
    if (regimeGuard && rec?.action === "PAUSE") throw new Error(`regime guard: ${sym} is EXTREME - deploy paused (send regimeGuard:false to override)`);
    const f = regimeGuard && rec?.action === "WIDEN" && rec.widenFactor ? rec.widenFactor : 1;
    const lowerPrice = f !== 1 ? mark - (mark - cfg.lowerPrice) * f : cfg.lowerPrice;
    const upperPrice = f !== 1 ? mark + (cfg.upperPrice - mark) * f : cfg.upperPrice;
    const rules = this.rulesFor(sym);
    const plan = planGrid({ ...cfg, lowerPrice, upperPrice, markPrice: mark }, rules, this.fees);
    if (plan.warnings.some((w) => /below min/i.test(w))) throw new Error(plan.warnings.find((w) => /below min/i.test(w))!);
    try { await this.client.call("POST", "/v2/leverage", { symbol: sym, leverage: cfg.leverage }); } catch (e: any) { this.log(`${sym}: leverage not set (${e.message})`); }
    if (this.grids[sym]) await this.stopGrid(sym);
    const state = initGridState(plan, this.now(), rules);
    this.grids[sym] = state;
    this.options[sym] = { autoShift, regimeGuard };
    if (plan.config.stopLossPct) {
      for (const s of buildDeployStrategies(plan, rules).strategies) await this.placeStrategy(s);
      this.persist();
    } else {
      await this.place(state.rungs.flatMap((r) => r.resting.filter((o) => o.role !== "s").map((o) => ({
        client_order_id: o.clientOrderId, symbol: sym, side: o.side === "BUY" ? "buy" as const : "sell" as const, type: "limit" as const,
        size: String(o.size), price: String(r.price), time_in_force: "GTC" as const, post_only: true,
      }))));
    }
    this.log(`${sym}: deployed ${restingIds(state).length} rungs ${plan.rungs[0]?.price}–${plan.rungs[plan.rungs.length - 1]?.price}${f !== 1 ? ` (widened ×${f})` : ""}`);
    return plan;
  }

  async stopGrid(sym: string) {
    const g = this.grids[sym];
    if (!g) return false;
    delete this.grids[sym]; delete this.options[sym]; delete this.held[sym];
    for (const id of restingIds(g)) await this.cancel(sym, id);
    this.persist();
    this.log(`${sym}: grid stopped`);
    return true;
  }

  async panic() {
    for (const sym of Object.keys(this.grids)) await this.stopGrid(sym);
    try { await this.client.call("DELETE", "/v2/order/cancel-all", {}); } catch (e: any) { this.log(`cancel-all: ${e.message}`); }
    await this.place(buildFlattenOrders(this.enriched()));
    this.shield = { ...this.shield, log: [...this.shield.log, { t: this.now(), symbol: "*", msg: "PANIC via Autopilot", level: "crit" as const }].slice(-200) };
    this.persist();
  }

  // ── periodic ──
  enriched(): Position[] {
    const m = this.hub.markets;
    const basic = this.rawPositions.map((p) => enrichPositionWithDerived({ ...p, leverage: p.leverage || m[p.symbol]?.default_leverage || 1 }, this.hub.marks[p.symbol]?.p ?? parseFloat(m[p.symbol]?.mark_price ?? "0"), m[p.symbol]));
    return applyCrossLiquidationPrices(basic, this.wallet, m);
  }

  shieldTick() {
    const pos = this.enriched();
    const rules: Record<string, MarketRules> = {};
    for (const p of pos) { const r = this.safeRules(p.symbol); if (r) rules[p.symbol] = r; }
    const before = this.shield.log.length;
    const r = evaluateShield(this.shield, pos, rules, (s) => !!this.grids[s] && restingBuyIds(this.grids[s]).length > 0);
    this.shield = r.state; this.healths = r.healths;
    for (const l of r.state.log.slice(before)) this.log(`SHIELD ${l.level.toUpperCase()} ${l.symbol}: ${l.msg}`);
    for (const a of r.actions) {
      if (a.kind === "CANCEL_BUYS" && this.grids[a.symbol]) { const ids = restingBuyIds(this.grids[a.symbol]); this.grids[a.symbol] = dropResting(this.grids[a.symbol], ids); for (const id of ids) void this.cancel(a.symbol, id); }
      if (a.kind === "TRIM") void this.place([a.order]);
    }
    if (r.actions.length) this.persist();
  }

  private isPaused(sym: string) { return (this.options[sym]?.regimeGuard ?? true) && this.hub.regime[sym]?.recommendation.action === "PAUSE"; }

  regimeTick() {
    for (const [sym, orders] of Object.entries(this.held)) {
      if (orders.length && !this.isPaused(sym) && this.grids[sym]) { this.held[sym] = []; this.log(`${sym}: regime recovered - placing ${orders.length} held counter(s)`); void this.place(orders); }
    }
  }

  async watchdog() {
    const now = this.now();
    for (const [cid, p] of [...this.pending]) {
      if (now - p.t < 8000) continue;
      this.pending.delete(cid);
      try {
        const { status, json } = await this.client.call("GET", `/v2/order?symbol=${encodeURIComponent(p.symbol)}&client_order_id=${encodeURIComponent(cid)}`);
        const st = String(json?.Status ?? "").toUpperCase();
        if (status === 404 || ["REJECTED", "CANCELED", "EXPIRED"].includes(st)) {
          this.onFill({ symbol: p.symbol, clientOrderId: cid, orderId: json?.ID ?? 0, side: "BUY", fillQty: 0, fillPrice: 0, cumFilled: 0, orderQty: 0, isMaker: true, commission: 0, builderFee: 0, timestamp: now, status: status === 404 ? "REJECTED" : st as FillEvent["status"], closeReason: status === 404 ? "silently_dropped" : json?.CloseReason });
        }
      } catch { /* retry next round */ }
    }
  }

  async autoShiftTick() {
    for (const [sym, g] of Object.entries(this.grids)) {
      if (!this.options[sym]?.autoShift || this.shifting.has(sym)) continue;
      const mark = this.hub.marks[sym]?.p;
      if (!mark || this.now() - (this.lastFillAt[sym] ?? 0) < 2000) continue;
      const d = shouldShift(g, mark, { hysteresisPct: 0.5, edgeTicks: 20, minIntervalMs: 60_000 }, this.edgeStreak[sym] ?? 0, this.now());
      this.edgeStreak[sym] = d.edgeStreak;
      if (!d.shift) continue;
      this.shifting.add(sym);
      try {
        const r = buildShiftedPlan(g, mark, this.rulesFor(sym), this.fees, this.now());
        this.grids[sym] = r.newState;
        await this.client.call("POST", "/v2/orders/replace", { symbol: sym, orders: r.ordersWithoutSymbol }, this.builderHeaders());
        for (const o of r.ordersWithoutSymbol) if (o.client_order_id) this.pending.set(o.client_order_id, { symbol: sym, t: this.now() });
        this.log(`${sym}: auto-shift (${d.reason}) → ${r.ordersWithoutSymbol.length} orders via /v2/orders/replace`);
        this.edgeStreak[sym] = 0;
      } catch (e: any) { this.grids[sym] = g; this.log(`${sym}: shift failed ${e.message}`); }
      finally { this.shifting.delete(sym); this.persist(); }
    }
  }

  status() {
    return {
      wallet: this.wallet, lastEventAgoSec: this.lastEvent ? Math.round((this.now() - this.lastEvent) / 1000) : null,
      grids: Object.fromEntries(Object.entries(this.grids).map(([s, g]) => [s, { ...g, log: g.log.slice(-30) }])),
      options: this.options, held: Object.fromEntries(Object.entries(this.held).map(([s, o]) => [s, o.length])),
      positions: this.enriched(), healths: this.healths, shield: { rules: this.shield.rules, log: this.shield.log.slice(-30) },
      telemetry: this.telemetry, builderFeeBps: this.fees.builderFeeBps,
    };
  }
}
