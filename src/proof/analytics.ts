// Pure analytics over public fill rows - what the proof page renders.

import type { FillRow, FundingRow } from "../api/history";
import { builderFeeFor, telemetryFromFills } from "../quant/backfill";
import { parseRungClientId } from "../quant/gridEngine";
import { fix } from "../quant/types";

export type Source = "grid" | "hedge" | "shield" | "flatten" | "other";

export const classify = (cid: string | undefined): Source => {
  if (!cid) return "other";
  if (cid.startsWith("vektor-grid-")) return "grid";
  if (cid.startsWith("vektor-hedge-")) return "hedge";
  if (cid.startsWith("vektor-shield-")) return "shield";
  if (cid.startsWith("vektor-flatten-")) return "flatten";
  return "other";
};

export interface SymbolStats { symbol: string; fills: number; volumeUsd: number; roundTrips: number; realizedPnlUsd: number; feesUsd: number; builderFeesUsd: number; gridIds: string[] }

export interface ProofSummary {
  totalFills: number; vektorFills: number; otherFills: number;
  volumeUsd: number; builderFeesUsd: number; commissionUsd: number;
  roundTrips: number; realizedPnlUsd: number;
  bySource: Record<Source, number>;
  bySymbol: SymbolStats[];
  firstTs: number | null; lastTs: number | null;
  fundingUsd: number; fundingPayments: number;
  timeline: { t: number; cumVolumeUsd: number; cumPnlUsd: number; cumBuilderUsd: number }[];
}

export function summarize(fills: FillRow[], funding: FundingRow[], bps: number): ProofSummary {
  const mine = fills.filter((f) => classify(f.client_order_id) !== "other").sort((a, b) => a.timestamp - b.timestamp);
  const t = telemetryFromFills(fills, bps);
  const bySource: Record<Source, number> = { grid: 0, hedge: 0, shield: 0, flatten: 0, other: 0 };
  for (const f of fills) bySource[classify(f.client_order_id)]++;
  const sym = new Map<string, SymbolStats>();
  let roundTrips = 0, realized = 0;
  const timeline: ProofSummary["timeline"] = [];
  let cv = 0, cp = 0, cb = 0;
  for (const f of mine) {
    const n = parseFloat(f.size) * parseFloat(f.price);
    const pnl = parseFloat(f.realized_pnl || "0") || 0;
    const parsed = parseRungClientId(f.client_order_id ?? "");
    const s = sym.get(f.symbol) ?? { symbol: f.symbol, fills: 0, volumeUsd: 0, roundTrips: 0, realizedPnlUsd: 0, feesUsd: 0, builderFeesUsd: 0, gridIds: [] };
    s.fills++; s.volumeUsd += n; s.realizedPnlUsd += pnl; s.builderFeesUsd += builderFeeFor(n, bps);
    if (f.fee_type === "commission") s.feesUsd += parseFloat(f.fee) || 0;
    if (parsed?.role === "x") { s.roundTrips++; roundTrips++; }
    if (parsed && !s.gridIds.includes(parsed.gridId)) s.gridIds.push(parsed.gridId);
    sym.set(f.symbol, s);
    realized += pnl;
    cv += n; cp += pnl; cb += builderFeeFor(n, bps);
    timeline.push({ t: f.timestamp, cumVolumeUsd: fix(cv, 2), cumPnlUsd: fix(cp, 4), cumBuilderUsd: fix(cb, 2) });
  }
  const fundingRows = funding.filter((r) => r.amount);
  return {
    totalFills: fills.length, vektorFills: mine.length, otherFills: fills.length - mine.length,
    volumeUsd: t.volumeUsd, builderFeesUsd: t.builderFeesUsd, commissionUsd: t.commissionUsd,
    roundTrips, realizedPnlUsd: fix(realized, 4), bySource,
    bySymbol: [...sym.values()].map((s) => ({ ...s, volumeUsd: fix(s.volumeUsd, 2), realizedPnlUsd: fix(s.realizedPnlUsd, 4), feesUsd: fix(s.feesUsd, 4), builderFeesUsd: fix(s.builderFeesUsd, 2) })).sort((a, b) => b.volumeUsd - a.volumeUsd),
    firstTs: mine[0]?.timestamp ?? null, lastTs: mine[mine.length - 1]?.timestamp ?? null,
    fundingUsd: fix(fundingRows.reduce((a, r) => a + parseFloat(r.amount), 0), 4), fundingPayments: fundingRows.length,
    timeline,
  };
}

/** Parse ?account=… | ?address=… (&chain=) | &bps= from a query string. */
export function parseProofQuery(search: string): { account?: string; address?: string; chain?: string; bps: number; base: string } {
  const q = new URLSearchParams(search);
  const bps = Math.max(0, Math.min(100, Number(q.get("bps") ?? 10) || 10));
  const base = q.get("net") === "testnet" ? "https://api-v2-testnet.strikefinance.org" : "https://api.strikefinance.org";
  return { account: q.get("account") ?? undefined, address: q.get("address") ?? undefined, chain: q.get("chain") ?? undefined, bps, base };
}
