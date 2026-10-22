import { useCallback, useEffect, useState } from "react";
import { autopilotAvailable, autopilotDeploy, autopilotDisable, autopilotPanic, autopilotStatus, autopilotStop, enrollAutopilot } from "../api/autopilot";
import type { GridState } from "../quant/gridEngine";

const SYMS_KEY = "vektor:autopilot:symbols";
const readSyms = (): string[] => { try { return JSON.parse(localStorage.getItem(SYMS_KEY) ?? "[]"); } catch { return []; } };

/** Autopilot state for the signed-in account: enrolled?, server-run grids (polled every 5 s). */
export function useAutopilot(accountId: string | null, builderCode?: string, feeShareBps?: number) {
  const available = autopilotAvailable();
  const [enrolled, setEnrolled] = useState(false);
  const [status, setStatus] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  // Symbols the server owns - the browser must not run its own grid logic for them.
  const [symbols, setSymbols] = useState<string[]>(readSyms);

  const refresh = useCallback(async () => {
    if (!available || !accountId) return;
    try {
      const s = await autopilotStatus();
      setStatus(s); setEnrolled(true); setError(null);
      const syms = Object.keys(s.grids ?? {});
      setSymbols(syms); try { localStorage.setItem(SYMS_KEY, JSON.stringify(syms)); } catch { /* ignore */ }
    } catch (e: any) {
      if (e.status === 401) { setEnrolled(false); setStatus(null); setSymbols([]); try { localStorage.removeItem(SYMS_KEY); } catch { /* ignore */ } }
      else setError(e.message);
    }
  }, [available, accountId]);

  useEffect(() => {
    if (!available || !accountId) { setEnrolled(false); setStatus(null); return; }
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [available, accountId, refresh]);

  const deploy = useCallback(async (grid: Record<string, unknown>) => {
    if (!enrolled) { await enrollAutopilot(builderCode || undefined, feeShareBps); setEnrolled(true); }
    const r = await autopilotDeploy(grid);
    await refresh();
    return r;
  }, [enrolled, builderCode, feeShareBps, refresh]);

  const stop = useCallback(async (symbol: string) => { await autopilotStop(symbol); await refresh(); }, [refresh]);
  const panic = useCallback(async () => { if (enrolled) { await autopilotPanic(); await refresh(); } }, [enrolled, refresh]);
  const disable = useCallback(async () => { await autopilotDisable(); setEnrolled(false); setStatus(null); setSymbols([]); try { localStorage.removeItem(SYMS_KEY); } catch { /* ignore */ } }, []);

  const gridFor = (symbol: string): GridState | null => status?.grids?.[symbol] ?? null;

  return { available, enrolled, status, error, symbols, deploy, stop, panic, disable, refresh, gridFor };
}

export type Autopilot = ReturnType<typeof useAutopilot>;
