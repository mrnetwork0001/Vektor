/**
 * Central engine hook. Owns the execution adapter (SimExchange or LiveAdapter),
 * one grid per symbol, shield / hedge state, depth history, and the demo tick
 * loop. Market data and positions come either from the simulator or from the
 * live hooks passed in. Live grids persist to localStorage and are reconciled
 * against GET /v2/openOrders after a reload.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Market, OrderBookDepthResponse } from "../types/market";
import type { Position } from "../types/position";
import type { MarkPriceUpdate } from "../types/ws";
import type { CreateOrderRequest, OrderRow } from "../types/order";
import type { FeeRates } from "../math/fees";
import { SimExchange } from "../sim/simExchange";
import { createPriceSim, stepPrice, syntheticDepth, triggerScenario, type PriceSimState, type Scenario } from "../sim/priceSim";
import { DEMO_MARKETS } from "../sim/demoMarkets";
import { LiveAdapter } from "../api/liveAdapter";
import { getPremiumIndexAll } from "../api/vektor";
import { updateLeverage } from "../api/orders";
import { getFillHistory, getFundingHistory, getOrderStatus } from "../api/history";
import { backfillGrid, fundingCollected, telemetryFromFills } from "../quant/backfill";
import { notify } from "../lib/notify";
import { fix, type ExecutionAdapter, type FeeContext, type FillEvent, type MarketRules } from "../quant/types";
import { adoptGridsFromOpenOrders, applyGridFill, buildDeployStrategies, dropResting, initGridState, parseRungClientId, planGrid, reconcileGrid, restingBuyIds, restingIds, type GridConfig, type GridPlan, type GridState } from "../quant/gridEngine";
import { buildFlattenOrders, DEFAULT_SHIELD_RULES, evaluateShield, initShieldState, resolveTrim, type PositionHealth, type ShieldRules, type ShieldState } from "../quant/liquidationShield";
import { buildHedgeSliceOrder, fundingFlipped, rankFundingOpportunities, type FundingSnapshot, type HedgePlan } from "../quant/fundingHarvester";
import { buildShiftedPlan, shouldShift } from "../quant/gridShift";
import type { RegimeAssessment } from "../quant/regime";

export type Mode = "sim" | "live";

export interface LiveInputs {
  accountId: string | null;
  markets: Record<string, Market>;
  prices: Record<string, MarkPriceUpdate>;
  depth: OrderBookDepthResponse | null;
  positions: Position[]; // enriched (liquidationPrice, markPrice, ...)
  openOrders: OrderRow[];
  ordersLoading: boolean;
  ordersLoaded: boolean; // REST open orders fetched at least once this session
  walletBalance: number;
  feeRates: FeeRates;
  builderFeeBps: number;
  vaultId?: string | null; // run new grids on this vault account (Live only)
  regime?: Record<string, RegimeAssessment>; // regime guard assessments per symbol ({} = guard off)
}

export interface HedgeRun { plan: HedgePlan; placed: number; filled: number; status: "RUNNING" | "DONE" | "UNWINDING" | "UNWOUND" | "FAILED"; error?: string; fundingHistory: number[]; collectedUsd: number; payments: number; launchedAt: number; source: "simulated" | "history" }
export interface Telemetry { volumeUsd: number; builderFeesUsd: number; commissionUsd: number; fills: number; ordersPlaced: number }
export interface DepthFrame { t: number; mark: number; bids: [number, number][]; asks: [number, number][] }

export function marketRules(m: Market | undefined, symbol: string): MarketRules {
  if (!m) return { symbol, tick: 0.0001, stepSize: 1, minSize: 1, minNotional: 10, basePrec: 8, quotePrec: 8 };
  return {
    symbol, tick: parseFloat(m.order_tick_price), stepSize: parseFloat(m.order_limit_step_size),
    minSize: parseFloat(m.order_limit_min_size), minNotional: parseFloat(m.order_min_notional),
    basePrec: m.base_prec, quotePrec: m.quote_prec,
  };
}

const HISTORY_LEN = 240;
const DEPTH_FRAMES = 120;
const STORE_KEY = "vektor:grids:v1";

interface SimBundle { ex: SimExchange; price: Record<string, PriceSimState>; depth: OrderBookDepthResponse | null; history: number[]; funding: Record<string, number> }

function createSim(): SimBundle {
  const ex = new SimExchange({ makerRate: 0, takerRate: 0.0005, builderFeeBps: 10 }, DEMO_MARKETS, 10_000);
  const price: Record<string, PriceSimState> = {};
  const funding: Record<string, number> = {};
  let seed = 7;
  for (const [s, m] of Object.entries(DEMO_MARKETS)) {
    price[s] = createPriceSim(parseFloat(m.mark_price), seed++);
    ex.setMark(s, parseFloat(m.mark_price));
    funding[s] = parseFloat(m.funding_rate);
  }
  return { ex, price, depth: null, history: [], funding };
}

const toFrame = (d: OrderBookDepthResponse | null, mark: number): DepthFrame | null =>
  d && d.bids.length ? { t: Date.now(), mark, bids: d.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)] as [number, number]), asks: d.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)] as [number, number]) } : null;

export function useVektor(live: LiveInputs) {
  const [mode, setMode] = useState<Mode>("sim");
  const [symbol, setSymbol] = useState("ADA-USD");
  const [, bump] = useReducer((x: number) => x + 1, 0);

  const markets = useMemo(() => (mode === "live" && Object.keys(live.markets).length ? live.markets : DEMO_MARKETS), [mode, live.markets]);
  const fees: FeeContext = useMemo(() => ({ makerRate: live.feeRates.makerRate, takerRate: live.feeRates.takerRate, builderFeeBps: mode === "sim" ? 10 : live.builderFeeBps }), [live.feeRates, live.builderFeeBps, mode]);
  const rulesFor = useCallback((s: string) => marketRules(markets[s], s), [markets]);

  // ── Simulator ──
  const simRef = useRef<SimBundle | null>(null);
  if (!simRef.current) simRef.current = createSim();
  const sim = simRef.current;
  const [simRunning, setSimRunning] = useState(true);
  const [simSpeed, setSimSpeed] = useState(1);
  const [scenario, setScenario] = useState<Scenario>("RANGE");

  // ── Adapter ──
  const liveAdapterRef = useRef(new LiveAdapter(live.builderFeeBps));
  liveAdapterRef.current.setBuilderFee(live.builderFeeBps);
  const adapter: ExecutionAdapter = mode === "sim" ? sim.ex : liveAdapterRef.current;

  // ── Engine state (refs for the hot path, bumped into React once per event) ──
  const gridsRef = useRef<Record<string, GridState>>({});
  const shieldRef = useRef<ShieldState>(initShieldState());
  const hedgeRef = useRef<HedgeRun | null>(null);
  const telemetryRef = useRef<Telemetry>({ volumeUsd: 0, builderFeesUsd: 0, commissionUsd: 0, fills: 0, ordersPlaced: 0 });
  const healthsRef = useRef<PositionHealth[]>([]);
  const liveHistoryRef = useRef<number[]>([]);
  const depthFramesRef = useRef<Record<string, DepthFrame[]>>({});
  const [liveFunding, setLiveFunding] = useState<FundingSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const modeRef = useRef(mode); modeRef.current = mode;
  const pendingRef = useRef<Map<string, { symbol: string; t: number }>>(new Map()); // live watchdog
  // Auto-shift (trailing grid)
  const autoShiftRef = useRef<Record<string, boolean>>({});
  const edgeStreakRef = useRef<Record<string, number>>({});
  const shiftBusyRef = useRef<Set<string>>(new Set());
  const lastFillAtRef = useRef<Record<string, number>>({});
  // Regime guard: counters held while PAUSE, flushed on recovery
  const heldOrdersRef = useRef<Record<string, CreateOrderRequest[]>>({});
  const regimeLevelRef = useRef<Record<string, string>>({});
  const regimeRef = useRef(live.regime ?? {}); regimeRef.current = live.regime ?? {};
  const regimeAction = (sym: string) => regimeRef.current[sym]?.recommendation.action ?? "RUN";

  const gridLog = (sym: string, kind: GridState["log"][number]["kind"], msg: string) => {
    const g = gridsRef.current[sym];
    if (g) gridsRef.current[sym] = { ...g, log: [...g.log, { t: Date.now(), kind, msg }].slice(-300) };
  };
  const findGridById = (gridId: string) => Object.values(gridsRef.current).find((g) => g.plan.gridId === gridId);

  // Persist live grids (no secrets in there) so a reload can reconcile.
  const persist = useCallback(() => {
    if (modeRef.current !== "live") return;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(gridsRef.current)); } catch { /* ignore */ }
  }, []);

  const place = useCallback(async (orders: CreateOrderRequest[]) => {
    if (!orders.length) return;
    try {
      const res = await adapter.placeBatch(orders);
      telemetryRef.current.ordersPlaced += res.accepted.length;
      if (adapter.mode === "live") for (const cid of res.accepted) pendingRef.current.set(cid, { symbol: orders[0].symbol, t: Date.now() });
      if (res.failed.length) gridLog(orders[0].symbol, "ERROR", `${res.failed.length} order(s) rejected: ${res.failed.map((f) => f.error).join(", ")}`);
    } catch (e: any) {
      setError(e.message ?? String(e));
      gridLog(orders[0].symbol, "ERROR", e.message ?? String(e));
    }
    persist();
    bump();
  }, [adapter, persist]);

  // Fill routing: grid counters, shield trim resolution, telemetry, alerts.
  useEffect(() => {
    const unsub = adapter.onFill((f: FillEvent) => {
      pendingRef.current.delete(f.clientOrderId);
      if (f.fillQty > 0) {
        const t = telemetryRef.current;
        t.fills += 1; t.volumeUsd += f.fillQty * f.fillPrice; t.builderFeesUsd += f.builderFee; t.commissionUsd += f.commission;
        lastFillAtRef.current[f.symbol] = Date.now();
      }
      const parsed = parseRungClientId(f.clientOrderId);
      const g = parsed ? findGridById(parsed.gridId) : undefined;
      if (g) {
        const sym = g.plan.config.symbol;
        const r = applyGridFill(g, f, Date.now(), rulesFor(sym));
        gridsRef.current[sym] = r.state;
        if (r.state.cycles > g.cycles && modeRef.current === "live") notify("Grid round trip", `${sym}: +${(r.state.realizedUsd - g.realizedUsd).toFixed(4)} USD`);
        for (const id of r.cancel) void adapter.cancel(sym, id).catch(() => {}); // orphaned stop/exit legs
        if (r.orders.length) {
          if (regimeAction(sym) === "PAUSE") {
            heldOrdersRef.current[sym] = [...(heldOrdersRef.current[sym] ?? []), ...r.orders];
            gridLog(sym, "SKIP", `Regime PAUSE - ${r.orders.length} counter order(s) held`);
          } else void place(r.orders);
        }
        for (const s of r.strategies) void adapter.placeStrategy?.(s).catch((e: any) => { setError(e.message); gridLog(sym, "ERROR", `bracket re-arm failed: ${e.message}`); });
      }
      const h = hedgeRef.current;
      if (h && f.clientOrderId.startsWith(`vektor-hedge-${h.plan.symbol}`)) {
        if (f.fillQty > 0) h.filled = fix(h.filled + f.fillQty, 8);
        if (f.status === "REJECTED" || f.status === "EXPIRED" || f.closeReason === "silently_dropped") { h.status = "FAILED"; h.error = f.closeReason || f.status; notify("Hedge failed", `${h.plan.symbol}: ${h.error}`, "crit"); }
        else if (f.status === "FILLED" && h.filled >= h.plan.totalSize - 1e-9 && h.status === "RUNNING") h.status = "DONE";
      }
      if (f.clientOrderId.startsWith("vektor-shield-trim") && (f.status === "FILLED" || f.status === "CANCELED" || f.status === "REJECTED" || f.status === "EXPIRED")) {
        shieldRef.current = resolveTrim(shieldRef.current, f.clientOrderId, f.status);
      }
      persist();
      bump();
    });
    return unsub;
  }, [adapter, place, persist, rulesFor]);

  // ── Unified market view ──
  const mark = mode === "sim" ? sim.ex.mark(symbol) : parseFloat(live.prices[symbol]?.p ?? "0") || 0;
  const depth = mode === "sim" ? sim.depth : live.depth;
  const positions: Position[] = mode === "sim" ? sim.ex.snapshot().positions : live.positions;
  const wallet = mode === "sim" ? sim.ex.wallet : live.walletBalance;

  useEffect(() => {
    if (mode !== "live" || !mark) return;
    liveHistoryRef.current = [...liveHistoryRef.current.slice(-HISTORY_LEN + 1), mark];
  }, [mark, mode]);
  useEffect(() => { liveHistoryRef.current = []; }, [symbol]);
  const history = mode === "sim" ? sim.history : liveHistoryRef.current;

  // Depth frames for the heatmap (live: at most 1 frame / s)
  const lastFrameAt = useRef(0);
  useEffect(() => {
    if (mode !== "live" || !live.depth) return;
    const now = Date.now();
    if (now - lastFrameAt.current < 1000) return;
    lastFrameAt.current = now;
    const fr = toFrame(live.depth, mark);
    if (fr) depthFramesRef.current[symbol] = [...(depthFramesRef.current[symbol] ?? []).slice(-DEPTH_FRAMES + 1), fr];
  }, [live.depth, mark, mode, symbol]);

  // ── Auto-shift: re-centre the ladder in one /v2/orders/replace when price leaves the range ──
  const maybeShift = useCallback(async (sym: string, m: number) => {
    const g = gridsRef.current[sym];
    if (!g || !autoShiftRef.current[sym] || !m || shiftBusyRef.current.has(sym) || !adapter.replaceAll) return;
    if (Date.now() - (lastFillAtRef.current[sym] ?? 0) < 2000) return; // let a fresh fill's counter settle
    const d = shouldShift(g, m, { hysteresisPct: 0.5, edgeTicks: 20, minIntervalMs: 60_000 }, edgeStreakRef.current[sym] ?? 0);
    edgeStreakRef.current[sym] = d.edgeStreak;
    if (!d.shift) return;
    shiftBusyRef.current.add(sym);
    try {
      const r = buildShiftedPlan(g, m, rulesFor(sym), fees);
      gridsRef.current[sym] = r.newState;
      const res = await adapter.replaceAll(sym, r.ordersWithoutSymbol);
      telemetryRef.current.ordersPlaced += res.accepted.length;
      if (adapter.mode === "live") for (const cid of res.accepted) pendingRef.current.set(cid, { symbol: sym, t: Date.now() });
      if (res.failed.length) gridLog(sym, "ERROR", `shift: ${res.failed.length} rejected ${res.failed.map((f) => f.error).join(", ")}`);
      gridLog(sym, "DEPLOY", `Auto-shift (${d.reason}) → ${r.ordersWithoutSymbol.length} orders via /v2/orders/replace`);
      if (modeRef.current === "live") notify("Grid shifted", `${sym}: ${String(d.reason).toLowerCase().replace(/_/g, " ")} → ${r.plan.config.lowerPrice}–${r.plan.config.upperPrice}`);
      edgeStreakRef.current[sym] = 0;
    } catch (e: any) {
      gridsRef.current[sym] = g; // replace is all-or-nothing on static errors
      setError(e.message); gridLog(sym, "ERROR", `shift failed: ${e.message}`);
    } finally { shiftBusyRef.current.delete(sym); persist(); bump(); }
  }, [adapter, fees, rulesFor, persist]);

  useEffect(() => {
    if (mode !== "live") return;
    for (const sym of Object.keys(gridsRef.current)) { const p = live.prices[sym]; if (p) void maybeShift(sym, parseFloat(p.p)); }
  }, [mode, live.prices, maybeShift]);

  // ── Regime guard: notify on level change, flush held counters when PAUSE lifts ──
  useEffect(() => {
    for (const [sym, a] of Object.entries(live.regime ?? {})) {
      const prev = regimeLevelRef.current[sym];
      if (prev && prev !== a.level) {
        notify(`Regime ${a.level}`, `${sym}: ${a.reasons.join("; ")}`, a.level === "EXTREME" ? "crit" : a.level === "ELEVATED" ? "warn" : "info");
        const level = (a.level === "EXTREME" ? "crit" : a.level === "ELEVATED" ? "warn" : "info") as "crit" | "warn" | "info";
        shieldRef.current = { ...shieldRef.current, log: [...shieldRef.current.log, { t: Date.now(), symbol: sym, msg: `Regime ${prev} → ${a.level}: ${a.recommendation.action}`, level }].slice(-200) };
      }
      regimeLevelRef.current[sym] = a.level;
      if (a.recommendation.action !== "PAUSE" && heldOrdersRef.current[sym]?.length) {
        const held = heldOrdersRef.current[sym]; heldOrdersRef.current[sym] = [];
        gridLog(sym, "DEPLOY", `Regime recovered - placing ${held.length} held counter order(s)`);
        void place(held);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.regime, place]);

  // ── Shield evaluation (both modes) ──
  const runShield = useCallback((pos: Position[]) => {
    const rulesBySymbol: Record<string, MarketRules> = {};
    for (const p of pos) rulesBySymbol[p.symbol] = rulesFor(p.symbol);
    const before = shieldRef.current.log.length;
    const r = evaluateShield(shieldRef.current, pos, rulesBySymbol, (s) => !!gridsRef.current[s] && restingBuyIds(gridsRef.current[s]).length > 0);
    shieldRef.current = r.state;
    healthsRef.current = r.healths;
    for (const l of r.state.log.slice(before)) if (l.level !== "info") notify(l.level === "crit" ? "Shield trim" : "Shield warning", `${l.symbol}: ${l.msg}`, l.level);
    for (const a of r.actions) {
      const g = gridsRef.current[a.symbol];
      if (a.kind === "CANCEL_BUYS" && g) {
        const ids = restingBuyIds(g);
        gridsRef.current[a.symbol] = dropResting(g, ids);
        for (const id of ids) void adapter.cancel(a.symbol, id).catch((e) => setError(e.message));
      }
      if (a.kind === "TRIM") void place([a.order]);
    }
  }, [adapter, place, rulesFor]);

  useEffect(() => {
    if (mode === "live") { runShield(live.positions); bump(); }
  }, [mode, live.positions, runShield]);

  // ── Live: restore, backfill fills from history, reconcile against open orders ──
  const reconciledFor = useRef<string | null>(null);
  useEffect(() => {
    if (mode !== "live" || !live.accountId || live.ordersLoading || !live.ordersLoaded || reconciledFor.current === live.accountId) return;
    reconciledFor.current = live.accountId;
    let saved: Record<string, GridState> = {};
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}"); } catch { saved = {}; }
    const open = new Set(live.openOrders.map((o) => o.ClientOrderId));
    (async () => {
      let fills: Awaited<ReturnType<typeof getFillHistory>> = [];
      try { fills = await getFillHistory({ limit: 1000 }); } catch (e: any) { console.warn("[Vektor] fill history", e.message); }
      // Telemetry from every Vektor-tagged fill on the account (real history, not "since the tab opened")
      const t = telemetryFromFills(fills, live.builderFeeBps);
      telemetryRef.current = { ...telemetryRef.current, ...t };
      const next: Record<string, GridState> = {};
      const toPlace: CreateOrderRequest[] = [];
      for (const [sym, g] of Object.entries(saved)) {
        const b = backfillGrid(g, fills, live.builderFeeBps, rulesFor(sym));
        const r = reconcileGrid(b.state, open);
        const missing = b.orders.filter((o) => !open.has(o.client_order_id!));
        if (r.kept > 0 || missing.length) {
          next[sym] = r.state;
          toPlace.push(...missing);
          notify("Grid restored", `${sym}: ${b.replayed} fill(s) backfilled, ${r.kept} rungs resting, ${missing.length} counter(s) re-placed`);
        }
      }
      // Orders on the book that no saved grid knows about (lost memory, other device): adopt them.
      const known = new Set(Object.values(next).flatMap((g) => restingIds(g)));
      const orphans = live.openOrders.filter((o) => parseRungClientId(o.ClientOrderId) && !known.has(o.ClientOrderId) && !next[o.Symbol]);
      if (orphans.length) {
        const adopted = adoptGridsFromOpenOrders(orphans, rulesFor, fees);
        for (const [sym, g] of Object.entries(adopted)) { next[sym] = g; notify("Grid adopted", `${sym}: ${restingIds(g).length} resting rung(s) found on the book`); }
      }
      gridsRef.current = next;
      if (toPlace.length) await place(toPlace);
      persist();
      bump();
    })();
  }, [mode, live.accountId, live.ordersLoading, live.ordersLoaded, live.openOrders, live.builderFeeBps, persist, place, rulesFor, fees]);
  useEffect(() => { if (!live.accountId) reconciledFor.current = null; }, [live.accountId]);

  // ── Live watchdog: 201 with no user-stream event → GET /v2/order; 404 = silently dropped ──
  useEffect(() => {
    if (mode !== "live" || !live.accountId) return;
    const t = setInterval(async () => {
      const now = Date.now();
      for (const [cid, p] of [...pendingRef.current]) {
        if (now - p.t < 8000) continue;
        pendingRef.current.delete(cid);
        try {
          const st = await getOrderStatus(p.symbol, cid);
          const final = st === null ? "REJECTED" : (["REJECTED", "CANCELED", "EXPIRED"].includes(st.status) ? st.status : null);
          if (!final) continue;
          const parsed = parseRungClientId(cid);
          const g = parsed ? findGridById(parsed.gridId) : undefined;
          if (g) gridsRef.current[g.plan.config.symbol] = applyGridFill(g, { symbol: p.symbol, clientOrderId: cid, orderId: 0, side: "BUY", fillQty: 0, fillPrice: 0, cumFilled: 0, orderQty: 0, isMaker: true, commission: 0, builderFee: 0, timestamp: now, status: final as FillEvent["status"], closeReason: st?.closeReason || "silently_dropped" }).state;
          notify("Order dropped", `${cid.slice(0, 40)}… ${st ? st.closeReason || st.status : "never reached the engine"}`, "warn");
          persist(); bump();
        } catch { /* retry next round */ }
      }
    }, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, live.accountId, persist]);

  // ── Live hedge: funding collected from /v2/history/funding (real payments, hourly) ──
  useEffect(() => {
    if (mode !== "live" || !live.accountId) return;
    const poll = async () => {
      const h = hedgeRef.current;
      if (!h || h.status === "UNWOUND") return;
      try {
        const rows = await getFundingHistory({ symbol: h.plan.symbol, startTime: h.launchedAt });
        const f = fundingCollected(rows, h.plan.symbol, h.launchedAt);
        h.collectedUsd = f.usd; h.payments = f.payments; h.fundingHistory = f.rates.slice(-24); h.source = "history";
        if (h.status === "DONE" && fundingFlipped(h.fundingHistory, h.plan.side, 3)) { notify("Funding flipped", `${h.plan.symbol}: 3 adverse hours - unwinding`, "warn"); await unwindHedgeRef.current(); }
        bump();
      } catch (e: any) { console.warn("[Vektor] funding history", e.message); }
    };
    void poll();
    const t = setInterval(poll, 60_000);
    return () => clearInterval(t);
  }, [mode, live.accountId]);
  const unwindHedgeRef = useRef<() => Promise<void>>(async () => {});

  // ── Funding snapshots ──
  useEffect(() => {
    if (mode !== "live") return;
    let stop = false;
    const load = () => getPremiumIndexAll().then((rows) => {
      if (stop) return;
      setLiveFunding(rows.map((r) => ({ symbol: r.symbol, markPrice: parseFloat(r.markPrice), indexPrice: parseFloat(r.indexPrice), fundingRateHourly: parseFloat(r.fundingRate), nextFundingTime: r.nextFundingTime })));
    }).catch((e) => console.warn("[Vektor] premiumIndex", e));
    load();
    const t = setInterval(load, 30_000);
    return () => { stop = true; clearInterval(t); };
  }, [mode]);

  const fundingSnapshots: FundingSnapshot[] = useMemo(() => {
    if (mode === "live") {
      if (liveFunding.length) return liveFunding;
      return Object.entries(live.prices).map(([s, p]) => ({ symbol: s, markPrice: parseFloat(p.p), indexPrice: parseFloat(p.i), fundingRateHourly: parseFloat(p.r), nextFundingTime: p.T }));
    }
    return Object.keys(DEMO_MARKETS).map((s) => ({ symbol: s, markPrice: sim.ex.mark(s), indexPrice: sim.ex.mark(s) * (1 - sim.funding[s] * 4), fundingRateHourly: sim.funding[s], nextFundingTime: Math.ceil(Date.now() / 3_600_000) * 3_600_000 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, liveFunding, live.prices, sim, mark]);
  const fundingRanked = useMemo(() => rankFundingOpportunities(fundingSnapshots), [fundingSnapshots]);

  // ── Demo tick loop ──
  useEffect(() => {
    if (mode !== "sim" || !simRunning) return;
    const tick = () => {
      const s = simRef.current!;
      for (const [sym, ps] of Object.entries(s.price)) {
        const p = stepPrice(ps);
        s.ex.setMark(sym, p);
        void maybeShift(sym, p);
        if (sym === symbol && ps.scenario === "RANGE" && scenario !== "RANGE") setScenario("RANGE");
        s.funding[sym] = Math.max(-0.0001, Math.min(0.0002, s.funding[sym] + (Math.random() - 0.5) * 0.000002));
      }
      const liq = s.ex.checkLiquidations();
      if (liq.length) { shieldRef.current = { ...shieldRef.current, log: [...shieldRef.current.log, { t: Date.now(), symbol: liq[0], msg: "LIQUIDATED by the engine", level: "crit" as const }] }; notify("Liquidated", liq[0], "crit"); }
      const m = s.ex.mark(symbol);
      s.depth = syntheticDepth(m, rulesFor(symbol).tick, s.price[symbol]);
      s.history = [...s.history.slice(-HISTORY_LEN + 1), m];
      const fr = toFrame(s.depth, m);
      if (fr) depthFramesRef.current[symbol] = [...(depthFramesRef.current[symbol] ?? []).slice(-DEPTH_FRAMES + 1), fr];

      const h = hedgeRef.current;
      if (h && h.status === "RUNNING") {
        void place([buildHedgeSliceOrder(h.plan, h.placed, s.ex.mark(h.plan.symbol), rulesFor(h.plan.symbol))]);
        h.placed += 1;
        if (h.placed >= h.plan.slices) h.status = "DONE";
      }
      if (h && h.status === "DONE") {
        const r = s.funding[h.plan.symbol];
        h.collectedUsd += h.plan.notionalUsd * r * (1 / 60);
        if (s.history.length % 20 === 0) h.fundingHistory = [...h.fundingHistory.slice(-23), r];
        if (fundingFlipped(h.fundingHistory, h.plan.side, 3)) {
          h.status = "UNWINDING";
          void place(buildFlattenOrders(s.ex.snapshot().positions.filter((p) => p.symbol === h.plan.symbol)));
          h.status = "UNWOUND";
          notify("Funding flipped", `${h.plan.symbol} hedge unwound`, "warn");
        }
      }
      runShield(s.ex.snapshot().positions);
      bump();
    };
    const id = setInterval(tick, Math.max(60, 500 / simSpeed));
    return () => clearInterval(id);
  }, [mode, simRunning, simSpeed, symbol, scenario, rulesFor, runShield, place, maybeShift]);

  // ── Actions ──
  const previewGrid = useCallback((cfg: Omit<GridConfig, "markPrice" | "symbol">): GridPlan | { error: string } => {
    try { return planGrid({ ...cfg, symbol, markPrice: mark }, rulesFor(symbol), fees); } catch (e: any) { return { error: e.message }; }
  }, [fees, mark, rulesFor, symbol]);

  const stopGrid = useCallback(async (sym: string = symbol) => {
    const g = gridsRef.current[sym];
    if (!g) return;
    const ids = restingIds(g);
    delete gridsRef.current[sym];
    for (const id of ids) await adapter.cancel(sym, id).catch(() => {});
    persist();
    bump();
  }, [adapter, persist, symbol]);

  const deployGrid = useCallback(async (cfg: Omit<GridConfig, "markPrice" | "symbol">): Promise<GridPlan> => {
    // Regime guard: WIDEN scales the half-widths; PAUSE refuses new grids.
    const rec = regimeRef.current[symbol]?.recommendation;
    if (rec?.action === "PAUSE") throw new Error(`Regime guard: ${symbol} is EXTREME - deploy paused`);
    const f = rec?.action === "WIDEN" && rec.widenFactor ? rec.widenFactor : 1;
    const lowerPrice = f !== 1 ? mark - (mark - cfg.lowerPrice) * f : cfg.lowerPrice;
    const upperPrice = f !== 1 ? mark + (cfg.upperPrice - mark) * f : cfg.upperPrice;
    const vaultId = mode === "live" ? live.vaultId ?? undefined : undefined;
    const plan = planGrid({ ...cfg, lowerPrice, upperPrice, vaultId, symbol, markPrice: mark }, rulesFor(symbol), fees);
    if (f !== 1) plan.warnings.push(`Range widened ×${f} by the regime guard`);
    if (mode === "sim") sim.ex.setLeverage(cfg.leverage);
    if (mode === "live") {
      // Make Strike's symbol leverage match the grid (sizing alone does not change the account setting).
      try { await updateLeverage(symbol, cfg.leverage); } catch (e: any) { notify("Leverage not updated", `${symbol}: ${e.message} - orders use the account's current setting`, "warn"); }
    }
    if (gridsRef.current[symbol]) await stopGrid(symbol);
    const rules = rulesFor(symbol);
    const state = initGridState(plan, Date.now(), rules);
    gridsRef.current[symbol] = state;
    if (plan.config.stopLossPct && adapter.placeStrategy) {
      // Brackets: one POST /v2/order/strategy per entry rung (post-only primary + stop leg), builder fee on all legs
      const { strategies } = buildDeployStrategies(plan, rules);
      for (const s of strategies) {
        try { await adapter.placeStrategy(s); telemetryRef.current.ordersPlaced += 1; }
        catch (e: any) { setError(e.message); gridLog(symbol, "ERROR", `bracket ${s.client_order_id}: ${e.message}`); }
      }
      persist(); bump();
    } else {
      const orders: CreateOrderRequest[] = state.rungs.flatMap((r) => r.resting.filter((o) => o.role !== "s").map((o) => ({
        client_order_id: o.clientOrderId, symbol, side: o.side === "BUY" ? "buy" as const : "sell" as const, type: "limit" as const,
        size: String(o.size), price: String(r.price), time_in_force: "GTC" as const, post_only: true, ...(vaultId ? { vault_id: vaultId } : {}),
      })));
      await place(orders);
    }
    return plan;
  }, [fees, mark, mode, place, rulesFor, sim, stopGrid, symbol, live.vaultId]);

  const setAutoShift = useCallback((sym: string, on: boolean) => { autoShiftRef.current[sym] = on; edgeStreakRef.current[sym] = 0; bump(); }, []);

  const launchHedge = useCallback(async (plan: HedgePlan) => {
    hedgeRef.current = { plan, placed: 0, filled: 0, status: "RUNNING", fundingHistory: [], collectedUsd: 0, payments: 0, launchedAt: Date.now(), source: mode === "sim" ? "simulated" : "history" };
    if (mode === "sim") sim.ex.setLeverage(Math.round(plan.notionalUsd / Math.max(plan.marginUsd, 1e-9)));
    if (mode === "live") {
      const lev = Math.max(1, Math.round(plan.notionalUsd / Math.max(plan.marginUsd, 1e-9)));
      try { await updateLeverage(plan.symbol, lev); } catch (e: any) { notify("Leverage not updated", `${plan.symbol}: ${e.message}`, "warn"); }
      for (let i = 0; i < plan.slices; i++) {
        const m = parseFloat(live.prices[plan.symbol]?.p ?? "0") || plan.notionalUsd / plan.totalSize;
        await place([buildHedgeSliceOrder(plan, i, m, rulesFor(plan.symbol))]);
        hedgeRef.current.placed = i + 1;
        bump();
        if (i < plan.slices - 1) await new Promise((r) => setTimeout(r, 2000));
      }
      // Live: DONE is set by the fill handler once the full size is filled; leave RUNNING otherwise (IOC remainder = partial).
      if (hedgeRef.current.status === "RUNNING" && hedgeRef.current.filled >= plan.totalSize - 1e-9) hedgeRef.current.status = "DONE";
    }
    bump();
  }, [live.prices, mode, place, rulesFor, sim]);

  const unwindHedge = useCallback(async () => {
    const h = hedgeRef.current;
    if (!h) return;
    h.status = "UNWINDING";
    await place(buildFlattenOrders(positions.filter((p) => p.symbol === h.plan.symbol)));
    h.status = "UNWOUND";
    bump();
  }, [place, positions]);
  unwindHedgeRef.current = unwindHedge;

  const panic = useCallback(async () => {
    for (const sym of Object.keys(gridsRef.current)) await stopGrid(sym);
    await adapter.cancelAll().catch(() => {});
    await place(buildFlattenOrders(positions));
    if (hedgeRef.current) hedgeRef.current.status = "UNWOUND";
    shieldRef.current = { ...shieldRef.current, log: [...shieldRef.current.log, { t: Date.now(), symbol: "*", msg: "PANIC: cancelled all orders and flattened every position", level: "crit" as const }] };
    bump();
  }, [adapter, place, positions, stopGrid]);

  const setShieldRules = useCallback((rules: Partial<ShieldRules>) => {
    shieldRef.current = { ...shieldRef.current, rules: { ...shieldRef.current.rules, ...rules } };
    bump();
  }, []);

  const trigger = useCallback((sc: Scenario) => {
    triggerScenario(simRef.current!.price[symbol], sc, 25);
    setScenario(sc);
    setSimRunning(true);
  }, [symbol]);

  const resetEngines = () => {
    gridsRef.current = {}; hedgeRef.current = null; shieldRef.current = initShieldState(shieldRef.current.rules);
    telemetryRef.current = { volumeUsd: 0, builderFeesUsd: 0, commissionUsd: 0, fills: 0, ordersPlaced: 0 };
    healthsRef.current = []; depthFramesRef.current = {};
  };
  const switchMode = useCallback((m: Mode) => {
    if (m === mode) return;
    resetEngines(); reconciledFor.current = null; setError(null); setMode(m);
  }, [mode]);
  const resetSim = useCallback(() => { simRef.current = createSim(); resetEngines(); setScenario("RANGE"); bump(); }, []);

  const simSnap = mode === "sim" ? sim.ex.snapshot() : null;

  return {
    mode, switchMode, symbol, setSymbol, symbols: Object.keys(markets), markets, rulesFor, fees,
    mark, depth, positions, wallet, history, openOrders: mode === "sim" ? simSnap!.openOrders.length : live.openOrders.length,
    depthFrames: depthFramesRef.current[symbol] ?? [],
    grid: gridsRef.current[symbol] ?? null, grids: gridsRef.current, previewGrid, deployGrid, stopGrid,
    autoShift: autoShiftRef.current, setAutoShift, regime: live.regime ?? {}, heldOrders: heldOrdersRef.current,
    shield: shieldRef.current, healths: healthsRef.current, setShieldRules, defaultRules: DEFAULT_SHIELD_RULES,
    fundingRanked, fundingSnapshots, hedge: hedgeRef.current, launchHedge, unwindHedge,
    telemetry: telemetryRef.current, panic, error, clearError: () => setError(null),
    sim: { running: simRunning, setRunning: setSimRunning, speed: simSpeed, setSpeed: setSimSpeed, scenario, trigger, reset: resetSim },
  };
}

export type Vektor = ReturnType<typeof useVektor>;
