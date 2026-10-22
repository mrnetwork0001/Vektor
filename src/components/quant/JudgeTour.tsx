import { useCallback, useEffect, useRef, useState } from "react";
import type { Vektor } from "../../hooks/useVektor";
import type { Tab } from "./VektorHeader";

/**
 * 45-second guided auto-demo in Demo mode: deploy → let it fill → flash crash
 * → shield acts → head-to-head. Captions explain what to look at. Judges skim.
 */

interface Step { caption: string; ms: number; run?: () => Promise<void> | void }

export function useJudgeTour(v: Vektor, setTab: (t: Tab) => void) {
  const [active, setActive] = useState(false);
  const [caption, setCaption] = useState("");
  const [idx, setIdx] = useState(0);
  const cancelRef = useRef(false);
  const vRef = useRef(v); vRef.current = v;

  const steps: Step[] = [
    { caption: "Demo mode: the real engines driving an in-browser matching engine. Same code as Live.", ms: 3500, run: () => { vRef.current.switchMode("sim"); vRef.current.setSymbol("ADA-USD"); setTab("grid"); vRef.current.sim.reset(); vRef.current.sim.setSpeed(3); vRef.current.sim.trigger("RANGE"); } },
    { caption: "Deploying a 12-level geometric grid at 10x through one /v2/orders/batch — every rung carries the builder fee.", ms: 4000, run: async () => { await vRef.current.deployGrid({ lowerPrice: vRef.current.mark * 0.94, upperPrice: vRef.current.mark * 1.06, levels: 12, marginUsd: 600, leverage: 10, mode: "GEOMETRIC" }); } },
    { caption: "Green = resting buys, red = resting sells. Watch the fill log: each fill places its counter one rung away for the FILLED quantity.", ms: 9000 },
    { caption: "Flash crash −12%. Buy rungs fill, inventory builds, the long walks toward its liquidation price (orange line).", ms: 7000, run: () => vRef.current.sim.trigger("FLASH_CRASH") },
    { caption: "Aegis Shield: buffer < 8% → cancelled the resting buys. Buffer < 5% → reduce-only trim of 25%. One episode, one trim.", ms: 8000, run: () => setTab("shield") },
    { caption: "Funding Harvester: hourly funding × 24 × 365, hedge sized to spot, liquidation from real margin tiers.", ms: 6000, run: () => setTab("funding") },
    { caption: "Back on the grid: builder fees in the header are what Strike's native grid bot would have paid you — $0. Vektor pays on every fill.", ms: 7000, run: () => { setTab("grid"); vRef.current.sim.setSpeed(1); } },
    { caption: "Switch to Live, connect a wallet, and this exact flow runs on Strike mainnet. Thanks for watching.", ms: 5000 },
  ];

  const stop = useCallback(() => { cancelRef.current = true; setActive(false); setCaption(""); }, []);

  const start = useCallback(async () => {
    cancelRef.current = false;
    setActive(true);
    for (let i = 0; i < steps.length; i++) {
      if (cancelRef.current) return;
      setIdx(i);
      setCaption(steps[i].caption);
      try { await steps[i].run?.(); } catch (e) { console.warn("[tour]", e); }
      await new Promise((r) => setTimeout(r, steps[i].ms));
    }
    setActive(false); setCaption("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setTab]);

  useEffect(() => () => { cancelRef.current = true; }, []);
  return { active, caption, idx, total: steps.length, start, stop };
}

export function TourOverlay({ tour }: { tour: ReturnType<typeof useJudgeTour> }) {
  if (!tour.active) return null;
  return (
    <div className="tour-bar" role="status">
      <span className="tour-step">{tour.idx + 1}/{tour.total}</span>
      <span className="tour-caption">{tour.caption}</span>
      <button className="btn btn-secondary" onClick={tour.stop}>skip</button>
    </div>
  );
}
