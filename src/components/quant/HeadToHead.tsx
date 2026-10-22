import { useEffect, useState } from "react";
import type { Vektor } from "../../hooks/useVektor";
import type { GridMode } from "../../quant/gridEngine";
import { createNativeGridBot, getMainnetKlines, stopNativeGridBot } from "../../api/vektor";
import { authenticatedFetch } from "../../api/auth";
import { API_BASE_URL } from "../../api/config";
import { parseKlines, runGridBacktest, type BacktestResult } from "../../quant/backtest";
import { formatCurrency } from "../../math/formatUtils";
import { Row } from "./GridStudio";

interface Props {
  v: Vektor;
  cfg: { lowerPrice: number; upperPrice: number; levels: number; marginUsd: number; leverage: number; mode: GridMode };
}

interface NativeBot { id: string; status: string; grid_profit_net?: string; orders?: unknown[]; last_error?: string; stop_reason?: string }

/**
 * Strike's native /v2/grid/bot vs Vektor's batch grid: same range, same
 * candles. The native bot is arithmetic-only and carries no builder code, so
 * builder revenue is 0 by construction - that's the point of the comparison.
 */
export function HeadToHead({ v, cfg }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<{ vektor: BacktestResult; native: BacktestResult } | null>(null);
  const [bot, setBot] = useState<NativeBot | null>(null);

  const compare = async () => {
    setBusy(true); setErr(null);
    try {
      const cs = parseKlines(await getMainnetKlines(v.symbol, "1h", 7));
      if (cs.length < 15) throw new Error("not enough mainnet history");
      const scale = cs[0].o / (v.mark || cs[cs.length - 1].c);
      const base = { symbol: v.symbol, ...cfg, lowerPrice: cfg.lowerPrice * scale, upperPrice: cfg.upperPrice * scale };
      const rules = v.rulesFor(v.symbol);
      setRes({
        vektor: runGridBacktest(base, cs, rules, v.fees),
        native: runGridBacktest({ ...base, mode: "ARITHMETIC" }, cs, rules, { ...v.fees, builderFeeBps: 0 }),
      });
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const createBot = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await createNativeGridBot({ symbol: v.symbol, mode: "NEUTRAL", lower_price: String(cfg.lowerPrice), upper_price: String(cfg.upperPrice), grid_count: cfg.levels, collateral: String(cfg.marginUsd) });
      setBot({ id: r.bot_id, status: r.status });
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  // Poll the native bot (a 201 is not a running bot; it can vanish silently)
  useEffect(() => {
    if (!bot || v.mode !== "live" || bot.status === "STOPPED") return;
    const t = setInterval(async () => {
      try {
        const r = await authenticatedFetch(`${API_BASE_URL}/v2/grid/bot/${bot.id}`, "GET");
        if (r.status === 404) { setBot((b) => (b ? { ...b, status: "404 (not stored yet / rejected)" } : b)); return; }
        const j = await r.json();
        setBot({ id: j.id ?? bot.id, status: j.status, grid_profit_net: j.grid_profit_net, orders: j.orders, last_error: j.last_error, stop_reason: j.stop_reason });
      } catch { /* keep polling */ }
    }, 3000);
    return () => clearInterval(t);
  }, [bot?.id, bot?.status, v.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const g = v.grid;
  return (
    <div className="panel">
      <h3>Head-to-head: Vektor grid vs Strike native grid bot</h3>
      <div className="form-row">
        <button className="btn btn-primary" disabled={busy || !v.mark} onClick={compare}>{busy ? "…" : "Backtest both (7d mainnet)"}</button>
        {v.mode === "live" && (bot ? (
          <button className="btn btn-danger" disabled={busy} onClick={() => stopNativeGridBot(bot.id).then(() => setBot((b) => b && { ...b, status: "STOPPING" })).catch((e) => setErr(e.message))}>Stop native bot</button>
        ) : (
          <button className="btn btn-secondary" disabled={busy} onClick={createBot}>Run native bot with same range</button>
        ))}
      </div>
      {err && <div className="error">{err}</div>}
      {res && (
        <table className="mini">
          <thead><tr><th></th><th>Vektor ({cfg.mode.toLowerCase()})</th><th>Native (arithmetic)</th></tr></thead>
          <tbody>
            <Cmp k="Round trips" a={String(res.vektor.cycles)} b={String(res.native.cycles)} />
            <Cmp k="Net PnL (user)" a={formatCurrency(res.vektor.netUsd)} b={formatCurrency(res.native.netUsd)} />
            <Cmp k="Volume routed" a={formatCurrency(res.vektor.volumeUsd)} b={formatCurrency(res.native.volumeUsd)} />
            <Cmp k="Builder revenue" a={formatCurrency(res.vektor.builderFeesUsd)} b="$0.00 (no builder code)" hi />
            <Cmp k="Max drawdown" a={formatCurrency(res.vektor.maxDrawdownUsd)} b={formatCurrency(res.native.maxDrawdownUsd)} />
            <Cmp k="Shield-able from client" a="yes - Rules A/B cancel & trim" b="no - server owns the orders" />
          </tbody>
        </table>
      )}
      {bot && (
        <div className="kv">
          <Row k="Native bot" val={`${bot.id.slice(0, 28)}… · ${bot.status}`} />
          <Row k="Native net profit" val={bot.grid_profit_net ?? "-"} />
          <Row k="Native levels" val={bot.orders ? String(bot.orders.length) : "-"} />
          {(bot.last_error || bot.stop_reason) && <div className="error">{bot.last_error ?? bot.stop_reason}</div>}
          <Row k="Vektor grid (live)" val={g ? `${g.cycles} round trips · ${formatCurrency(g.realizedUsd)} · ${formatCurrency(g.builderFeesUsd)} builder fees` : "not running"} />
        </div>
      )}
      <p className="text-xs text-secondary">Both runs use the same candles, fees and matching engine. The native bot's grid orders never carry a builder code (per Strike's grid-bot docs), so its builder revenue is zero.</p>
    </div>
  );
}

const Cmp = ({ k, a, b, hi }: { k: string; a: string; b: string; hi?: boolean }) => (
  <tr><td className="text-secondary">{k}</td><td className={hi ? "text-green" : ""}><b>{a}</b></td><td>{b}</td></tr>
);
