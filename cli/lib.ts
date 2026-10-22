// Pure helpers for the CLI: argument parsing and output formatting. No network, no engines.

import type { GridPlan } from "../src/quant/gridEngine";
import type { BacktestResult } from "../src/quant/backtest";
import type { RangeSuggestion } from "../src/quant/rangeSuggest";

export interface ParsedArgs {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** `vektor plan ADA-USD --lower 0.21 --json` → { cmd, positional, flags }. `--k v`, `--k=v`, bare `--k` = true. */
export function parseArgs(argv: string[]): ParsedArgs {
  const [cmd = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; } else flags[key] = true;
  }
  return { cmd, positional, flags };
}

export const num = (v: string | boolean | undefined, d?: number): number => {
  if (v === undefined || v === true) { if (d === undefined) throw new Error("missing numeric flag"); return d; }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${v}`);
  return n;
};

/** Fixed-width text table. */
export function table(headers: string[], rows: (string | number)[][]): string {
  const cells = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, c) => Math.max(...cells.map((r) => (r[c] ?? "").length)));
  const line = (r: string[]) => r.map((x, c) => (x ?? "").padEnd(widths[c])).join("  ").trimEnd();
  return [line(cells[0]), widths.map((w) => "-".repeat(w)).join("  "), ...cells.slice(1).map(line)].join("\n");
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export function formatPlan(plan: GridPlan): string {
  const head = [
    `${plan.config.symbol}  ${plan.config.mode.toLowerCase()}  ${plan.config.levels} levels  ${plan.config.leverage}x  margin ${usd(plan.config.marginUsd)}`,
    `range ${plan.config.lowerPrice} – ${plan.config.upperPrice}  mark ${plan.config.markPrice}`,
    `spacing ${plan.spacingPct}%/rung  net/round-trip ${plan.netCyclePct}% (${plan.netCycleRoePct}% on margin)  fee floor ${plan.feeFloorPct}%  notional ${usd(plan.totalNotionalUsd)}`,
  ];
  const rows = plan.rungs.map((r) => [r.index, r.price, r.entrySide, r.plannedSize, usd(r.notionalUsd)]);
  const warn = plan.warnings.map((w) => `WARNING: ${w}`);
  return [...head, "", table(["#", "price", "side", "size", "notional"], rows), ...(warn.length ? ["", ...warn] : [])].join("\n");
}

export function formatBacktest(r: BacktestResult): string {
  return table(["metric", "value"], [
    ["candles", `${r.candles} (${new Date(r.from).toISOString().slice(0, 16)} → ${new Date(r.to).toISOString().slice(0, 16)})`],
    ["round trips", r.cycles], ["fills", r.fills],
    ["realized", usd(r.realizedUsd)], ["inventory PnL", usd(r.inventoryPnlUsd)],
    ["fees", usd(r.feesUsd)], ["builder fees", usd(r.builderFeesUsd)],
    ["net", usd(r.netUsd)], ["net on margin", `${r.netPctOnMargin}%`], ["annualised", `${r.annualizedPct}%`],
    ["max drawdown", usd(r.maxDrawdownUsd)], ["time in range", `${r.timeInRangePct}%`], ["volume", usd(r.volumeUsd)],
    ["inventory at end", r.final.inventory],
  ]);
}

export function formatRange(s: RangeSuggestion): string {
  return table(["field", "value"], [
    ["lower", s.lower], ["upper", s.upper], ["levels", s.levels], ["spacing", `${s.spacingPct}%`],
    ["ATR(14)", `${s.atr} (${s.atrPct}%)`], ["fee floor", `${s.feeFloorPct}%`], ["basis", s.basis],
  ]);
}

export interface FillLike { timestamp: number; symbol: string; side: string; price: string; size: string; role: string; fee: string; client_order_id?: string }

export function formatFills(fills: FillLike[], builderFeeBps: number): string {
  if (!fills.length) return "no vektor-tagged fills";
  let vol = 0, builder = 0;
  const rows = fills.map((f) => {
    const n = parseFloat(f.price) * parseFloat(f.size);
    vol += n; builder += Math.floor(((n * builderFeeBps) / 10000) * 100) / 100;
    return [new Date(f.timestamp).toISOString().slice(0, 19), f.symbol, f.side, f.price, f.size, f.role, f.fee, (f.client_order_id ?? "").slice(0, 42)];
  });
  return [table(["time", "symbol", "side", "price", "size", "role", "fee", "client_order_id"], rows), "", `${fills.length} fills  volume ${usd(vol)}  builder fees ≈ ${usd(builder)} (reconstructed at ${builderFeeBps} bps)`].join("\n");
}

export function formatStatus(s: any): string {
  const grids = Object.entries(s.grids ?? {}).map(([sym, g]: [string, any]) => [sym, `${g.range?.[0]}–${g.range?.[1]}`, g.resting, g.fills, g.cycles, usd(g.realizedUsd ?? 0), g.inventory, usd(g.builderFeesUsd ?? 0)]);
  const healths = (s.healths ?? []).map((h: any) => [h.symbol, h.side, h.size, h.distanceToLiqPct + "%", h.health]);
  const t = s.telemetry ?? {};
  return [
    `worker up ${s.uptimeSec}s  last event ${s.lastEventAgoSec}s ago  wallet ${usd(s.wallet ?? 0)}  pending watchdog ${s.pendingWatchdog ?? 0}`,
    `telemetry: fills ${t.fills ?? 0}  volume ${usd(t.volumeUsd ?? 0)}  builder fees ${usd(t.builderFeesUsd ?? 0)}  orders placed ${t.ordersPlaced ?? 0}`,
    "", grids.length ? table(["grid", "range", "resting", "fills", "trips", "realized", "inventory", "builder fees"], grids) : "no grids running",
    "", healths.length ? table(["position", "side", "size", "to liq", "health"], healths) : "no open positions",
    "", "shield log:", ...((s.shield?.log ?? []).slice(-8).map((l: any) => `  ${new Date(l.t).toISOString().slice(11, 19)} ${l.level.toUpperCase().padEnd(4)} ${l.symbol} ${l.msg}`)),
  ].join("\n");
}

export const HELP = `vektor — Strike Finance grid / shield CLI (same engines as the terminal and the worker)

usage: npx tsx cli/vektor.ts <command> [args] [--json]

public (no keys):
  plan <symbol> --lower <p> --upper <p> [--levels 12] [--margin 200] [--leverage 5] [--mode GEOMETRIC|ARITHMETIC]
  backtest <symbol> [--days 7] [--interval 1h] [--lower-pct 6] [--upper-pct 6] [--levels 12] [--margin 600] [--leverage 10] [--mode ...]
  smart-range <symbol> [--days 7] [--interval 1h]

authenticated (STRIKE_API_PUBLIC_KEY / STRIKE_API_PRIVATE_KEY):
  deploy <symbol> --lower <p> --upper <p> [--levels ...] [--margin ...] [--leverage ...] [--mode ...] [--save]
  fills [--symbol X] [--limit 200]

worker (VEKTOR_WORKER_URL, default http://localhost:8787):
  status
  stop <symbol>
  panic

env: STRIKE_API_URL (default https://api.strikefinance.org), BUILDER_FEE_BPS (default 10), VEKTOR_STATE (default worker/state.json)`;
