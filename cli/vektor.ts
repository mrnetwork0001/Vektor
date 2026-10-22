#!/usr/bin/env -S npx tsx
/**
 * Vektor CLI - plan, backtest, deploy and monitor grids from a shell or an AI agent.
 * Reuses worker/strikeClient.ts and the pure engines in src/quant; never touches browser code.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { StrikeClient } from "../worker/strikeClient";
import { planGrid, initGridState, type GridConfig, type GridMode } from "../src/quant/gridEngine";
import { parseKlines, runGridBacktest } from "../src/quant/backtest";
import { suggestRange } from "../src/quant/rangeSuggest";
import type { FeeContext, MarketRules } from "../src/quant/types";
import type { Market } from "../src/types/market";
import type { CreateOrderRequest } from "../src/types/order";
import { HELP, formatBacktest, formatFills, formatPlan, formatRange, formatStatus, num, parseArgs } from "./lib";

const API = process.env.STRIKE_API_URL ?? "https://api.strikefinance.org";
const PRICE = `${API}/price`;
const MAINNET_PRICE = "https://api.strikefinance.org/price"; // backtests always use mainnet candles (testnet has no trades)
const WORKER = process.env.VEKTOR_WORKER_URL ?? "http://localhost:8787";
const BUILDER_FEE_BPS = Number(process.env.BUILDER_FEE_BPS ?? "10");
const STATE_FILE = process.env.VEKTOR_STATE ?? "worker/state.json";

const args = parseArgs(process.argv.slice(2));
const json = args.flags.json === true;
const out = (human: string, data: unknown) => console.log(json ? JSON.stringify(data, null, 2) : human);
const fail = (m: string): never => { console.error(`error: ${m}`); process.exit(1); };

async function publicGet<T = any>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json();
}

const rulesOf = (m: Market): MarketRules => ({
  symbol: m.symbol, tick: parseFloat(m.order_tick_price), stepSize: parseFloat(m.order_limit_step_size),
  minSize: parseFloat(m.order_limit_min_size), minNotional: parseFloat(m.order_min_notional), basePrec: m.base_prec, quotePrec: m.quote_prec,
});

async function marketAndFees(symbol: string): Promise<{ market: Market; fees: FeeContext; mark: number }> {
  const [{ markets }, tiers] = await Promise.all([publicGet<{ markets: Record<string, Market> }>(`${API}/v2/markets`), publicGet<any>(`${API}/v2/fee-tiers`).catch(() => null)]);
  const market = markets[symbol] ?? fail(`unknown symbol ${symbol}; have ${Object.keys(markets).join(", ")}`);
  const t0 = tiers?.feeTiers?.find((t: any) => t.Tier === 0) ?? tiers?.feeTiers?.[0];
  const fees: FeeContext = { makerRate: t0?.MakerRate ?? 0, takerRate: t0?.TakerRate ?? 0.0005, builderFeeBps: BUILDER_FEE_BPS };
  const mp = await publicGet<{ p: string }>(`${PRICE}/v2/markPrice?symbol=${encodeURIComponent(symbol)}`).catch(() => null);
  return { market, fees, mark: parseFloat(mp?.p ?? market.mark_price) };
}

function gridCfgFromFlags(symbol: string, mark: number, f: Record<string, string | boolean>): Omit<GridConfig, "markPrice"> {
  const lower = f.lower !== undefined ? num(f.lower) : mark * (1 - num(f["lower-pct"], 6) / 100);
  const upper = f.upper !== undefined ? num(f.upper) : mark * (1 + num(f["upper-pct"], 6) / 100);
  const mode = String(f.mode ?? "GEOMETRIC").toUpperCase() as GridMode;
  if (mode !== "GEOMETRIC" && mode !== "ARITHMETIC") fail("--mode must be GEOMETRIC or ARITHMETIC");
  return { symbol, lowerPrice: lower, upperPrice: upper, levels: num(f.levels, 12), marginUsd: num(f.margin, 200), leverage: num(f.leverage, 5), mode };
}

async function candles(symbol: string, days: number, interval: string) {
  const end = Date.now(), start = end - days * 86_400_000;
  const rows = await publicGet<(string | number)[][]>(`${MAINNET_PRICE}/v2/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&startTime=${start}&endTime=${end}&limit=1500&priceType=last`);
  const cs = parseKlines(rows);
  if (cs.length < 15) fail(`only ${cs.length} candles for ${symbol} - not enough history`);
  return cs;
}

function client(): StrikeClient {
  const publicKey = process.env.STRIKE_API_PUBLIC_KEY, privateKey = process.env.STRIKE_API_PRIVATE_KEY;
  if (!publicKey || !privateKey) fail("STRIKE_API_PUBLIC_KEY and STRIKE_API_PRIVATE_KEY are required (register at https://app.strikefinance.org/api-keys)");
  const ws = API.replace("https://", "wss://");
  return new StrikeClient({ apiUrl: API, priceUrl: PRICE, userWsUrl: `${ws}/ws/user-api`, priceWsUrl: `${ws}/ws/price`, publicKey: publicKey!, privateKey: privateKey!, builderFeeBps: BUILDER_FEE_BPS });
}

async function workerCall(method: string, path: string) {
  const r = await fetch(`${WORKER}${path}`, { method }).catch((e) => fail(`worker unreachable at ${WORKER}: ${e.message}`));
  return r.json();
}

(async () => {
  const sym = args.positional[0];
  switch (args.cmd) {
    case "plan": {
      if (!sym) fail("plan <symbol> ...");
      const { market, fees, mark } = await marketAndFees(sym);
      const plan = planGrid({ ...gridCfgFromFlags(sym, mark, args.flags), markPrice: mark }, rulesOf(market), fees);
      out(formatPlan(plan), plan);
      break;
    }
    case "backtest": {
      if (!sym) fail("backtest <symbol> ...");
      const { market, fees, mark } = await marketAndFees(sym);
      const cs = await candles(sym, num(args.flags.days, 7), String(args.flags.interval ?? "1h"));
      // Express the range as % of the window's first open so the grid shape is what gets tested.
      const cfg = gridCfgFromFlags(sym, mark, args.flags);
      const scale = cs[0].o / mark;
      const r = runGridBacktest({ ...cfg, lowerPrice: cfg.lowerPrice * scale, upperPrice: cfg.upperPrice * scale }, cs, rulesOf(market), fees);
      const { equity, final, ...summary } = r;
      out(formatBacktest(r), { ...summary, inventory: final.inventory, equityPoints: equity.length });
      break;
    }
    case "smart-range": {
      if (!sym) fail("smart-range <symbol>");
      const { fees, mark } = await marketAndFees(sym);
      const cs = await candles(sym, num(args.flags.days, 7), String(args.flags.interval ?? "1h"));
      const s = suggestRange(cs, fees) ?? fail("could not derive a range");
      const k = mark / cs[cs.length - 1].c; // re-anchor to the current mark
      const re = { ...s, lower: s.lower * k, upper: s.upper * k };
      out(formatRange(re), re);
      break;
    }
    case "deploy": {
      if (!sym) fail("deploy <symbol> --lower --upper ...");
      const c = client();
      const { market, fees, mark } = await marketAndFees(sym);
      const plan = planGrid({ ...gridCfgFromFlags(sym, mark, args.flags), markPrice: mark }, rulesOf(market), fees);
      for (const w of plan.warnings) console.error(`WARNING: ${w}`);
      const state = initGridState(plan);
      const orders: CreateOrderRequest[] = state.rungs.flatMap((r) => r.resting.map((o) => ({
        client_order_id: o.clientOrderId, symbol: sym, side: o.side === "BUY" ? "buy" as const : "sell" as const, type: "limit" as const,
        size: String(o.size), price: String(r.price), time_in_force: "GTC" as const, post_only: true,
      })));
      const { json: res } = await c.call<{ successful: unknown[] | null; failed: { index: number; error: string }[] | null }>("POST", "/v2/orders/batch", { orders }, c.builderHeaders());
      const failed = res.failed ?? [];
      if (args.flags.save) {
        let st: any = { grids: {} };
        if (existsSync(STATE_FILE)) { try { st = JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { /* overwrite */ } }
        st.grids = { ...(st.grids ?? {}), [sym]: state };
        writeFileSync(STATE_FILE, JSON.stringify(st, null, 1));
      }
      out([formatPlan(plan), "", `placed ${orders.length - failed.length}/${orders.length} rungs (gridId ${plan.gridId})`, ...failed.map((f) => `  rejected #${f.index}: ${f.error}`), args.flags.save ? `saved to ${STATE_FILE} - (re)start the worker to manage it` : "not saved: pass --save so the worker manages fills"].join("\n"),
        { gridId: plan.gridId, placed: orders.length - failed.length, failed, saved: !!args.flags.save, plan });
      break;
    }
    case "fills": {
      const c = client();
      const q = new URLSearchParams({ limit: String(num(args.flags.limit, 200)) });
      if (args.flags.symbol) q.set("symbol", String(args.flags.symbol));
      const { json: res } = await c.call<{ fills: any[] | null }>("GET", `/v2/history/fill?${q}`);
      const fills = (res.fills ?? []).filter((f) => String(f.client_order_id ?? "").startsWith("vektor-"));
      out(formatFills(fills, BUILDER_FEE_BPS), fills);
      break;
    }
    case "status": { const s = await workerCall("GET", "/"); out(formatStatus(s), s); break; }
    case "stop": { if (!sym) fail("stop <symbol>"); const s = await workerCall("POST", `/stop/${encodeURIComponent(sym)}`); out(s.ok ? `stopped ${sym}` : `no grid on ${sym}`, s); break; }
    case "panic": { const s = await workerCall("POST", "/panic"); out("panic sent: all orders cancelled, positions flattened", s); break; }
    case "help": case "--help": case "-h": console.log(HELP); break;
    default: fail(`unknown command "${args.cmd}"\n\n${HELP}`);
  }
})().catch((e) => fail(e.message ?? String(e)));
