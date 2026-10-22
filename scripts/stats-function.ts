// Vercel serverless function: live hero stats for the landing page.
// Runs the same grid backtest engine as the app and CLI on the latest 7 days of
// mainnet ADA-USD candles, with the parameters printed in the landing footnote.
// Cached at the edge for an hour.
import { parseKlines, runGridBacktest } from "../src/quant/backtest";

const API = "https://api.strikefinance.org";
const SYMBOL = "ADA-USD";
const CFG = { levels: 12, marginUsd: 600, leverage: 10, mode: "GEOMETRIC" as const, pct: 6, bps: 10, days: 7 };

export default async function handler(_req: any, res: any) {
  try {
    const m = (await (await fetch(`${API}/v2/markets`)).json()).markets[SYMBOL];
    const tiers = (await (await fetch(`${API}/v2/fee-tiers`)).json()).feeTiers ?? [];
    const t0 = tiers.find((t: any) => t.Tier === 0) ?? tiers[0] ?? { MakerRate: 0, TakerRate: 0.0005 };
    const end = Date.now(), start = end - CFG.days * 86_400_000;
    const rows = await (await fetch(`${API}/price/v2/klines?symbol=${SYMBOL}&interval=1h&priceType=last&startTime=${start}&endTime=${end}&limit=1500`)).json();
    const cs = parseKlines(rows);
    if (cs.length < 24) throw new Error("not enough candles");
    const p0 = cs[0].o;
    const rules = { symbol: SYMBOL, tick: parseFloat(m.order_tick_price), stepSize: parseFloat(m.order_limit_step_size), minSize: parseFloat(m.order_limit_min_size), minNotional: parseFloat(m.order_min_notional), basePrec: m.base_prec, quotePrec: m.quote_prec };
    const r = runGridBacktest({ symbol: SYMBOL, lowerPrice: p0 * (1 - CFG.pct / 100), upperPrice: p0 * (1 + CFG.pct / 100), levels: CFG.levels, marginUsd: CFG.marginUsd, leverage: CFG.leverage, mode: CFG.mode },
      cs, rules, { makerRate: t0.MakerRate, takerRate: t0.TakerRate, builderFeeBps: CFG.bps });
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({ symbol: SYMBOL, roundTrips: r.cycles, builderFeesUsd: r.builderFeesUsd, from: r.from, to: r.to, candles: r.candles, cfg: CFG, computedAt: end });
  } catch (e: any) {
    res.status(502).json({ error: e?.message ?? "stats failed" });
  }
}
