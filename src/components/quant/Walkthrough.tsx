import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Tab } from "./VektorHeader";

/**
 * First-run walkthrough: a spotlight over real UI elements (tagged with
 * data-tour="…") with a tooltip, Back / Next / Skip and progress. Shows once
 * (localStorage) and can be replayed from the header's "?" button. Steps whose
 * target is not visible (e.g. inside the closed mobile drawer) are skipped.
 */

export interface TourStep { target: string; tab?: Tab; title: string; body: string }

export const WALKTHROUGH_KEY = "vektor:walkthrough:v1";

export const STEPS: TourStep[] = [
  { target: "tabs", tab: "grid", title: "Three engines, one terminal", body: "Grid Studio places and manages grids on Strike's order book. Funding Harvester earns hourly funding delta-neutral. Aegis Shield watches every position and acts before liquidation." },
  { target: "mode", title: "Demo or Live", body: "Demo runs the real engines on an in-browser matching engine - no wallet needed. Live connects your wallet and trades on Strike mainnet with builder code vektor." },
  { target: "ladder", tab: "grid", title: "The ladder", body: "Price history with your rungs overlaid: green resting buys, red resting sells, orange liquidation line, whale walls on the right edge. Toggle to the liquidity heatmap to see where the walls were." },
  { target: "design", tab: "grid", title: "Design your grid", body: "Set the range, levels, margin and leverage. Net per round trip is shown after maker and builder fees. Funding skew tilts sizes toward the side that receives funding; a per-rung stop-loss adds a bracket leg to every entry." },
  { target: "backtest", tab: "grid", title: "Backtest before you deploy", body: "Replay this exact grid over 24h / 7d / 30d of mainnet candles through the same engine. Smart range sizes a range from ATR that clears Strike's fee floor." },
  { target: "deploy", tab: "grid", title: "Deploy", body: "One POST /v2/orders/batch places every rung post-only with X-Builder-Fee-Bps. Fills place their counter orders automatically; stop the grid any time to cancel the rungs." },
  { target: "radar", tab: "grid", title: "Whale radar", body: "Top-20 book imbalance, walls above 2.5× the average level, and a VWAP slippage probe for any order size." },
  { target: "funding", tab: "funding", title: "Funding Harvester", body: "Markets ranked by annualised hourly funding. Size a 1:1 perp hedge against spot you hold, see its liquidation from real margin tiers, and launch it in builder-fee slices." },
  { target: "shield-rules", tab: "shield", title: "Aegis Shield rules", body: "Rule A cancels resting buys under an 8% buffer. Rule B trims 25% reduce-only under 5%, once per episode with a cooldown. Enable browser alerts to be notified in the background." },
  { target: "panic", title: "PANIC", body: "Cancels every order on every symbol and flattens every position with reduce-only market orders. Always confirmed first." },
  { target: "telemetry", title: "Builder telemetry & proof", body: "Volume, fills and builder fees for this account. In Live mode the Proof button opens a public page that re-reads your fills from Strike's API so anyone can verify them. You're set - press ▶ Judge tour for a 45-second auto demo." },
];

interface Props { open: boolean; onClose: () => void; setTab: (t: Tab) => void }

interface Rect { top: number; left: number; width: number; height: number }

const PAD = 8;

export function Walkthrough({ open, onClose, setTab }: Props) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [tipBelow, setTipBelow] = useState(true);
  const tipRef = useRef<HTMLDivElement>(null);

  const step = STEPS[i];

  const measure = useCallback(() => {
    const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    if (!el) { setRect(null); return false; }
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) { setRect(null); return false; }
    setRect({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 });
    setTipBelow(r.bottom + 180 < window.innerHeight || r.top < 220);
    return true;
  }, [step.target]);

  // Switch tab, scroll target into view, then measure; skip steps whose target is not visible.
  useLayoutEffect(() => {
    if (!open) return;
    let cancelled = false;
    if (step.tab) setTab(step.tab);
    const t = setTimeout(() => {
      if (cancelled) return;
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(() => {
        if (cancelled) return;
        if (!measure()) {
          if (i < STEPS.length - 1) setI(i + 1); else finish();
        }
      }, 320);
    }, 60);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, i]);

  useEffect(() => {
    if (!open) return;
    const re = () => { measure(); };
    window.addEventListener("resize", re);
    window.addEventListener("scroll", re, true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      if (e.key === "ArrowRight" || e.key === "Enter") next();
      if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("resize", re); window.removeEventListener("scroll", re, true); window.removeEventListener("keydown", onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, i, measure]);

  useEffect(() => { if (open) setI(0); }, [open]);

  const finish = () => { try { localStorage.setItem(WALKTHROUGH_KEY, "done"); } catch { /* ignore */ } onClose(); };
  const next = () => (i < STEPS.length - 1 ? setI(i + 1) : finish());
  const back = () => setI((x) => Math.max(0, x - 1));

  if (!open) return null;

  const tipStyle: React.CSSProperties = rect
    ? tipBelow
      ? { top: rect.top + rect.height + 12, left: Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - 372)) }
      : { bottom: window.innerHeight - rect.top + 12, left: Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - 372)) }
    : { top: "40%", left: "50%", transform: "translate(-50%, -50%)" };

  return (
    <div className="wt-root" role="dialog" aria-modal="true" aria-label="App walkthrough">
      <div className="wt-overlay" onClick={finish} />
      {rect && <div className="wt-spot" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }} />}
      <div className="wt-tip" ref={tipRef} style={tipStyle}>
        <div className="wt-head">
          <span className="wt-step">{i + 1} / {STEPS.length}</span>
          <button className="wt-skip" onClick={finish}>Skip tour</button>
        </div>
        <h4>{step.title}</h4>
        <p>{step.body}</p>
        <div className="wt-dots" aria-hidden="true">{STEPS.map((_, k) => <span key={k} className={k === i ? "on" : k < i ? "done" : ""} />)}</div>
        <div className="wt-actions">
          <button className="btn btn-secondary" onClick={back} disabled={i === 0}>Back</button>
          <button className="btn btn-primary" onClick={next}>{i === STEPS.length - 1 ? "Finish" : "Next"}</button>
        </div>
      </div>
    </div>
  );
}

/** First visit → true. */
export function shouldAutoStart(): boolean {
  try { return localStorage.getItem(WALKTHROUGH_KEY) !== "done"; } catch { return false; }
}
