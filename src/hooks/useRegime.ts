/**
 * Polls the public regime inputs every 60 s (and once immediately), keeps a
 * rolling open-interest baseline per symbol in memory, and returns one
 * assessment per symbol. Endpoint failures leave the previous values in place.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getFearGreed, getOpenInterestAll, getTickers24h, type FearGreed, type OpenInterestRow, type Ticker24h } from "../api/regime";
import { assessRegime, RANGE_FLOOR_PCT, type RegimeAssessment } from "../quant/regime";

const POLL_MS = 60_000;
const BASELINE_SAMPLES = 30; // ~30 minutes of OI history at 1/min

export interface RegimeState {
  fearGreed: FearGreed | null;
  openInterest: Record<string, OpenInterestRow>;
  tickers: Record<string, Ticker24h>;
  assessments: Record<string, RegimeAssessment>;
  updatedAt: number | null;
  error: string | null;
}

export function useRegime(symbols: string[], fundingBySymbol: Record<string, number>, enabled = true) {
  const [state, setState] = useState<RegimeState>({ fearGreed: null, openInterest: {}, tickers: {}, assessments: {}, updatedAt: null, error: null });
  const baselineRef = useRef<Record<string, number[]>>({});
  const symbolsKey = symbols.join(",");
  const fundingRef = useRef(fundingBySymbol); fundingRef.current = fundingBySymbol;

  const poll = useCallback(async () => {
    const [fg, oiRows, tk] = await Promise.all([getFearGreed(), getOpenInterestAll(), getTickers24h()]);
    setState((prev) => {
      const openInterest = { ...prev.openInterest };
      for (const r of oiRows) openInterest[r.symbol] = r;
      const tickers = { ...prev.tickers };
      for (const t of tk) tickers[t.symbol] = t;
      const fearGreed = fg ?? prev.fearGreed;
      const assessments: Record<string, RegimeAssessment> = {};
      for (const s of symbolsKey.split(",").filter(Boolean)) {
        const oi = openInterest[s]?.openInterest ?? null;
        const base = baselineRef.current[s] ?? [];
        const t = tickers[s];
        assessments[s] = assessRegime({
          symbol: s, fearGreed: fearGreed?.value ?? null, openInterest: oi, oiBaseline: base,
          high24h: t?.high ?? null, low24h: t?.low ?? null, last: t?.last ?? null,
          fundingRateHourly: fundingRef.current[s] ?? null, rangeFloorPct: RANGE_FLOOR_PCT[s],
        });
        if (oi != null && oiRows.length) baselineRef.current[s] = [...base, oi].slice(-BASELINE_SAMPLES);
      }
      const failed = [!fg && "fearGreed", !oiRows.length && "openInterest", !tk.length && "ticker/24hr"].filter(Boolean) as string[];
      return { fearGreed, openInterest, tickers, assessments, updatedAt: Date.now(), error: failed.length ? `unavailable: ${failed.join(", ")}` : null };
    });
  }, [symbolsKey]);

  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    const run = () => { if (!stop) void poll().catch((e) => setState((p) => ({ ...p, error: e?.message ?? String(e) }))); };
    run();
    const id = setInterval(run, POLL_MS);
    return () => { stop = true; clearInterval(id); };
  }, [enabled, poll]);

  return { ...state, refresh: poll, baselineSamples: (s: string) => baselineRef.current[s]?.length ?? 0 };
}

export type Regime = ReturnType<typeof useRegime>;
