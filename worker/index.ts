/**
 * Vektor headless worker - runs the grid + shield engines 24/7 without a
 * browser. Holds the API wallet key from the environment, persists state to
 * a JSON file, backfills fills from history on start, and serves a status
 * endpoint the UI (or curl) can read.
 *
 *   STRIKE_API_PUBLIC_KEY / STRIKE_API_PRIVATE_KEY   API wallet (from Builder Connect)
 *   STRIKE_API_URL                                   default mainnet (api.strikefinance.org)
 *   BUILDER_FEE_BPS                                  default 10
 *   VEKTOR_GRIDS                                     path to grids JSON (default worker/grids.json)
 *   VEKTOR_STATE                                     path to state JSON (default worker/state.json)
 *   VEKTOR_PORT                                      status HTTP port (default 8787)
 *
 *   npm run worker
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { StrikeClient } from "./strikeClient";
import { toFillEvent } from "../src/quant/fillEvent";
import type { FillEvent, MarketRules, FeeContext } from "../src/quant/types";
import type { Market } from "../src/types/market";
import type { Position, PositionResponse } from "../src/types/position";
import type { CreateOrderRequest, OpenOrder } from "../src/types/order";
import { enrichPositionWithDerived, applyCrossLiquidationPrices } from "../src/math/positionCalculations";
import { applyGridFill, dropResting, initGridState, parseRungClientId, planGrid, reconcileGrid, restingBuyIds, restingIds, type GridConfig, type GridState } from "../src/quant/gridEngine";
import { backfillGrid, telemetryFromFills } from "../src/quant/backfill";
import { buildFlattenOrders, DEFAULT_SHIELD_RULES, evaluateShield, initShieldState, resolveTrim, type ShieldRules, type ShieldState, type PositionHealth } from "../src/quant/liquidationShield";

// ── Config ──
const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error(`missing env ${k}`); })();
const API = env("STRIKE_API_URL", "https://api.strikefinance.org");
const client = new StrikeClient({
  apiUrl: API, priceUrl: `${API}/price`,
  userWsUrl: env("STRIKE_USER_WS_URL", API.replace("https://", "wss://") + "/ws/user-api"),
  priceWsUrl: env("STRIKE_PRICE_WS_URL", API.replace("https://", "wss://") + "/ws/price"),
  publicKey: env("STRIKE_API_PUBLIC_KEY"), privateKey: env("STRIKE_API_PRIVATE_KEY"),
  builderFeeBps: Number(env("BUILDER_FEE_BPS", "10")),
});
const GRIDS_FILE = env("VEKTOR_GRIDS", "worker/grids.json");
const STATE_FILE = env("VEKTOR_STATE", "worker/state.json");
const PORT = Number(env("VEKTOR_PORT", "8787"));

interface GridSpec extends Omit<GridConfig, "markPrice"> {}
interface WorkerConfig { grids: GridSpec[]; shield?: Partial<ShieldRules> }
interface Persisted { grids: Record<string, GridState>; shield: ShieldState; telemetry: ReturnType<typeof telemetryFromFills> & { ordersPlaced: number } }

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

// ── State ──
const markets: Record<string, Market> = {};
const marks: Record<string, { p: number; i: number; r: number; T: number }> = {};
let fees: FeeContext = { makerRate: 0, takerRate: 0.0005, builderFeeBps: client.cfg.builderFeeBps };
let wallet = 0;
let rawPositions: Position[] = [];
let healths: PositionHealth[] = [];
const grids: Record<string, GridState> = {};
let shield: ShieldState = initShieldState();
const telemetry = { volumeUsd: 0, builderFeesUsd: 0, commissionUsd: 0, fills: 0, ordersPlaced: 0 };
const pending = new Map<string, { symbol: string; t: number }>(); // watchdog for silently dropped orders
let lastEvent = Date.now();

const rulesFor = (s: string): MarketRules => {
  const m = markets[s];
  if (!m) throw new Error(`unknown market ${s}`);
  return { symbol: s, tick: parseFloat(m.order_tick_price), stepSize: parseFloat(m.order_limit_step_size), minSize: parseFloat(m.order_limit_min_size), minNotional: parseFloat(m.order_min_notional), basePrec: m.base_prec, quotePrec: m.quote_prec };
};

function persist() {
  const data: Persisted = { grids, shield, telemetry };
  writeFileSync(STATE_FILE, JSON.stringify(data, null, 1));
}
function restore() {
  if (!existsSync(STATE_FILE)) return;
  try {
    const d: Persisted = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    Object.assign(grids, d.grids ?? {});
    if (d.shield) shield = { ...initShieldState(d.shield.rules), log: d.shield.log ?? [] };
    Object.assign(telemetry, d.telemetry ?? {});
    log(`restored ${Object.keys(grids).length} grid(s) from ${STATE_FILE}`);
  } catch (e: any) { log(`state restore failed: ${e.message}`); }
}

// ── Execution ──
async function place(orders: CreateOrderRequest[]) {
  if (!orders.length) return;
  try {
    const { json } = await client.call<{ successful: unknown[] | null; failed: { index: number; error: string }[] | null }>("POST", "/v2/orders/batch", { orders }, client.builderHeaders());
    const failed = new Set((json.failed ?? []).map((f) => f.index));
    orders.forEach((o, i) => { if (!failed.has(i) && o.client_order_id) pending.set(o.client_order_id, { symbol: o.symbol, t: Date.now() }); });
    telemetry.ordersPlaced += orders.length - failed.size;
    if (failed.size) log(`batch: ${failed.size} rejected ${JSON.stringify(json.failed)}`);
  } catch (e: any) { log(`place failed: ${e.message}`); }
  persist();
}
async function cancel(symbol: string, clientOrderId: string) {
  try { await client.call("DELETE", "/v2/order/cancel", { symbol, client_order_id: clientOrderId }); } catch (e: any) { log(`cancel ${clientOrderId}: ${e.message}`); }
}

// ── Fills ──
function onFill(f: FillEvent) {
  lastEvent = Date.now();
  pending.delete(f.clientOrderId);
  if (f.fillQty > 0) { telemetry.fills++; telemetry.volumeUsd += f.fillQty * f.fillPrice; telemetry.builderFeesUsd += f.builderFee; telemetry.commissionUsd += f.commission; }
  const parsed = parseRungClientId(f.clientOrderId);
  const g = parsed ? Object.values(grids).find((x) => x.plan.gridId === parsed.gridId) : undefined;
  if (g) {
    const r = applyGridFill(g, f);
    grids[g.plan.config.symbol] = r.state;
    if (f.fillQty > 0) log(`${g.plan.config.symbol} ${f.side} ${f.fillQty} @ ${f.fillPrice} rung ${parsed!.index} (${parsed!.role}) → ${r.orders.length} counter`);
    if (r.orders.length) void place(r.orders);
  }
  if (f.clientOrderId.startsWith("vektor-shield-trim") && ["FILLED", "CANCELED", "REJECTED", "EXPIRED"].includes(f.status)) shield = resolveTrim(shield, f.clientOrderId, f.status);
  persist();
}

// ── Positions ──
const normalize = (raw: PositionResponse): Position => {
  const signed = parseFloat(raw.size);
  return { symbol: raw.symbol, size: Math.abs(signed), entryPrice: parseFloat(raw.entry_price), positionSide: signed < 0 ? "SHORT" : "LONG", marginMode: raw.margin_mode, isoBalance: parseFloat(raw.iso_balance), leverage: raw.leverage, accumulatedFundingFees: parseFloat(raw.accumulated_funding_fees), id: String(raw.id) };
};
function enriched(): Position[] {
  const basic = rawPositions.map((p) => enrichPositionWithDerived({ ...p, leverage: p.leverage || markets[p.symbol]?.default_leverage || 1 }, marks[p.symbol]?.p ?? parseFloat(markets[p.symbol]?.mark_price ?? "0"), markets[p.symbol]));
  return applyCrossLiquidationPrices(basic, wallet, markets);
}
async function loadRest() {
  const [acc, pos, open] = await Promise.all([
    client.call("GET", "/v2/account"), client.call<{ positions: PositionResponse[] | null }>("GET", "/v2/positions"), client.call<{ orders: OpenOrder[] | null }>("GET", "/v2/openOrders"),
  ]);
  wallet = parseFloat(acc.json.wallet_balance ?? "0");
  rawPositions = (pos.json.positions ?? []).map(normalize);
  return (open.json.orders ?? []).map((o) => o.ClientOrderID);
}

// ── Shield tick ──
function shieldTick() {
  const pos = enriched();
  const rules: Record<string, MarketRules> = {};
  for (const p of pos) rules[p.symbol] = rulesFor(p.symbol);
  const before = shield.log.length;
  const r = evaluateShield(shield, pos, rules, (s) => !!grids[s] && restingBuyIds(grids[s]).length > 0);
  shield = r.state; healths = r.healths;
  for (const l of r.state.log.slice(before)) log(`SHIELD ${l.level.toUpperCase()} ${l.symbol}: ${l.msg}`);
  for (const a of r.actions) {
    if (a.kind === "CANCEL_BUYS" && grids[a.symbol]) { const ids = restingBuyIds(grids[a.symbol]); grids[a.symbol] = dropResting(grids[a.symbol], ids); for (const id of ids) void cancel(a.symbol, id); }
    if (a.kind === "TRIM") void place([a.order]);
  }
  if (r.actions.length) persist();
}

// ── Watchdog: 201 with no user-stream event means silently dropped ──
async function watchdog() {
  const now = Date.now();
  for (const [cid, p] of [...pending]) {
    if (now - p.t < 8000) continue;
    pending.delete(cid);
    const { status, json } = await client.call("GET", `/v2/order?symbol=${encodeURIComponent(p.symbol)}&client_order_id=${encodeURIComponent(cid)}`);
    if (status === 404) {
      log(`WATCHDOG ${cid}: no order on the engine - treating as rejected`);
      onFill({ symbol: p.symbol, clientOrderId: cid, orderId: 0, side: "BUY", fillQty: 0, fillPrice: 0, cumFilled: 0, orderQty: 0, isMaker: true, commission: 0, builderFee: 0, timestamp: now, status: "REJECTED", closeReason: "silently_dropped" });
    } else if (["REJECTED", "CANCELED", "EXPIRED"].includes(String(json.Status ?? "").toUpperCase())) {
      onFill({ symbol: p.symbol, clientOrderId: cid, orderId: json.ID, side: "BUY", fillQty: 0, fillPrice: 0, cumFilled: 0, orderQty: 0, isMaker: true, commission: 0, builderFee: 0, timestamp: now, status: String(json.Status).toUpperCase() as FillEvent["status"], closeReason: json.CloseReason });
    }
  }
}

// ── Grids from config ──
async function ensureGrids(openIds: Set<string>) {
  const cfg: WorkerConfig = JSON.parse(readFileSync(GRIDS_FILE, "utf8"));
  if (cfg.shield) shield = { ...shield, rules: { ...DEFAULT_SHIELD_RULES, ...cfg.shield } };
  // Backfill + reconcile restored grids
  const fills = (await client.call<{ fills: any[] | null }>("GET", "/v2/history/fill?limit=1000")).json.fills ?? [];
  const t = telemetryFromFills(fills, fees.builderFeeBps);
  Object.assign(telemetry, t);
  for (const [sym, g] of Object.entries(grids)) {
    const b = backfillGrid(g, fills, fees.builderFeeBps);
    const r = reconcileGrid(b.state, openIds);
    grids[sym] = r.state;
    // Counter orders the grid would have placed while away, minus any already resting
    const missing = b.orders.filter((o) => !openIds.has(o.client_order_id!));
    log(`${sym}: backfilled ${b.replayed} fill(s), ${r.kept} resting kept, ${r.dropped} dropped, ${missing.length} counter(s) to place`);
    if (missing.length) await place(missing);
    if (r.kept === 0 && missing.length === 0 && !cfg.grids.some((s) => s.symbol === sym)) delete grids[sym];
  }
  for (const spec of cfg.grids) {
    if (grids[spec.symbol]) continue;
    const mark = marks[spec.symbol]?.p ?? parseFloat(markets[spec.symbol]?.mark_price ?? "0");
    if (!mark) { log(`${spec.symbol}: no mark yet, skipping deploy`); continue; }
    const plan = planGrid({ ...spec, markPrice: mark }, rulesFor(spec.symbol), fees);
    for (const w of plan.warnings) log(`${spec.symbol}: ${w}`);
    const state = initGridState(plan);
    grids[spec.symbol] = state;
    const orders: CreateOrderRequest[] = state.rungs.flatMap((r) => r.resting.map((o) => ({ client_order_id: o.clientOrderId, symbol: spec.symbol, side: o.side === "BUY" ? "buy" as const : "sell" as const, type: "limit" as const, size: String(o.size), price: String(r.price), time_in_force: "GTC" as const, post_only: true })));
    log(`${spec.symbol}: deploying ${orders.length} rungs ${plan.config.lowerPrice}–${plan.config.upperPrice} (${plan.spacingPct}% spacing, net ${plan.netCyclePct}%/trip)`);
    await place(orders);
  }
  persist();
}

async function panic() {
  for (const [sym, g] of Object.entries(grids)) { for (const id of restingIds(g)) await cancel(sym, id); delete grids[sym]; }
  await client.call("DELETE", "/v2/order/cancel-all", {});
  await place(buildFlattenOrders(enriched()));
  shield = { ...shield, log: [...shield.log, { t: Date.now(), symbol: "*", msg: "PANIC via worker API", level: "crit" }] };
  persist();
}

// ── Status HTTP ──
const HOST = env("VEKTOR_HOST", "127.0.0.1"); // localhost only; expose through a reverse proxy
const TOKEN = process.env.VEKTOR_TOKEN ?? ""; // required for POST control endpoints
const ALLOW = (process.env.VEKTOR_ALLOW_ORIGIN ?? "*").split(",").map((x) => x.trim());

createServer(async (req, res) => {
  const origin = String(req.headers.origin ?? "");
  res.setHeader("Access-Control-Allow-Origin", ALLOW.includes("*") ? "*" : ALLOW.includes(origin) ? origin : ALLOW[0]);
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  if (req.method === "POST" && (!TOKEN || req.headers.authorization !== `Bearer ${TOKEN}`)) {
    res.statusCode = 401; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error: TOKEN ? "bad token" : "control disabled: set VEKTOR_TOKEN" })); return;
  }
  res.setHeader("Content-Type", "application/json");
  if (req.method === "POST" && req.url === "/panic") { await panic(); res.end(JSON.stringify({ ok: true })); return; }
  if (req.method === "POST" && req.url?.startsWith("/stop/")) { const sym = decodeURIComponent(req.url.slice(6)); const g = grids[sym]; if (g) { for (const id of restingIds(g)) await cancel(sym, id); delete grids[sym]; persist(); } res.end(JSON.stringify({ ok: !!g })); return; }
  res.end(JSON.stringify({
    ok: true, uptimeSec: Math.round(process.uptime()), lastEventAgoSec: Math.round((Date.now() - lastEvent) / 1000), wallet, marks,
    grids: Object.fromEntries(Object.entries(grids).map(([s, g]) => [s, { gridId: g.plan.gridId, range: [g.plan.config.lowerPrice, g.plan.config.upperPrice], resting: restingIds(g).length, fills: g.fills, cycles: g.cycles, realizedUsd: g.realizedUsd, inventory: g.inventory, builderFeesUsd: g.builderFeesUsd, log: g.log.slice(-10) }])),
    positions: enriched(), healths, shield: { rules: shield.rules, log: shield.log.slice(-20) }, telemetry, pendingWatchdog: pending.size,
  }));
}).listen(PORT, HOST, () => log(`status on http://${HOST}:${PORT}/  (POST /panic, POST /stop/<symbol> need Bearer VEKTOR_TOKEN)`));

// ── Boot ──
(async () => {
  restore();
  const m = await client.call<{ markets: Record<string, Market> }>("GET", "/v2/markets");
  Object.assign(markets, m.json.markets);
  try {
    const p = await client.call("GET", "/v2/portfolio");
    const tier = p.json.fee_tiers?.find((t: any) => t.Tier === p.json.fee_tier);
    if (tier) fees = { ...fees, takerRate: tier.TakerRate, makerRate: p.json.maker_fee_rate_override != null && p.json.maker_fee_rate_override !== "" ? parseFloat(p.json.maker_fee_rate_override) : tier.MakerRate };
  } catch (e: any) { log(`fee tier lookup failed, using defaults: ${e.message}`); }
  log(`markets ${Object.keys(markets).join(", ")} · fees maker ${fees.makerRate} taker ${fees.takerRate} builder ${fees.builderFeeBps} bps`);

  client.priceStream((x) => { marks[x.s] = { p: parseFloat(x.p), i: parseFloat(x.i), r: parseFloat(x.r), T: x.T }; }, log);
  await new Promise((r) => setTimeout(r, 2500)); // let marks arrive

  let booted = false;
  client.userStream({
    log,
    onEvent: (e, data) => {
      lastEvent = Date.now();
      if (e === "ORDER_TRADE_UPDATE") onFill(toFillEvent(data));
      if (e === "ACCOUNT_UPDATE" && data && !data.event_type) {
        if (data.B?.[0]?.wb !== undefined) wallet = parseFloat(data.B[0].wb);
        for (const P of data.P ?? []) {
          const signed = parseFloat(P.pa);
          rawPositions = rawPositions.filter((p) => p.symbol !== P.s);
          if (signed !== 0) rawPositions.push({ symbol: P.s, size: Math.abs(signed), entryPrice: parseFloat(P.ep), positionSide: signed < 0 ? "SHORT" : "LONG", marginMode: P.mt, isoBalance: parseFloat(P.ib), leverage: P.leverage ?? 0, accumulatedFundingFees: parseFloat(P.funding_total ?? "0"), id: P.position_id });
        }
        if (["PARTIAL_LIQUIDATED", "FULLY_LIQUIDATED", "ADL"].includes(data.e)) log(`ENGINE ${data.e} ${data.P?.[0]?.s}`);
      }
    },
    onSubscribed: async () => {
      log("userstream subscribed - loading REST state");
      try {
        const openIds = new Set(await loadRest());
        if (!booted) { booted = true; await ensureGrids(openIds); }
        else { for (const [sym, g] of Object.entries(grids)) grids[sym] = reconcileGrid(g, openIds).state; persist(); }
      } catch (e: any) { log(`REST load failed: ${e.message}`); }
    },
  });

  setInterval(shieldTick, 2000);
  setInterval(() => void watchdog(), 4000);
  setInterval(() => void loadRest().catch(() => {}), 60_000); // periodic REST re-sync
})().catch((e) => { console.error(e); process.exit(1); });
