import { useEffect, useRef, useState } from "react";
import { l3Stream } from "../ws/l3Stream";
import { activeSignals, createRadar, ingest, restingWalls, seedFromSnapshot, wallReliability, type L3Event, type L3RadarState, type L3Signal } from "../quant/l3Radar";

export interface L3View {
  signals: L3Signal[];
  events: L3Event[]; // timeline: wall opens/cancels + fills, oldest first
  walls: ReturnType<typeof restingWalls>;
  connected: boolean;
  synced: boolean;
  reason?: string;
  eventsPerSec: number;
  reliability: (price: number) => number | null;
}

const EMPTY: L3View = { signals: [], events: [], walls: [], connected: false, synced: false, eventsPerSec: 0, reliability: () => null };

/**
 * L3 feed → radar for one symbol. Safe when the feed is unavailable (returns
 * EMPTY with connected:false and a reason). React state is refreshed at most
 * twice a second regardless of event rate (ADA runs ~150 events/s).
 */
export function useL3(symbol: string, tick: number, mark: number, enabled = true): L3View {
  const [view, setView] = useState<L3View>(EMPTY);
  const radarRef = useRef<L3RadarState | null>(null);
  const markRef = useRef(mark); markRef.current = mark;
  const statusRef = useRef<{ connected: boolean; synced: boolean; reason?: string }>({ connected: false, synced: false });
  const countRef = useRef(0);

  useEffect(() => {
    if (!enabled || !symbol || !(tick > 0)) { setView(EMPTY); return; }
    const radar = createRadar(tick);
    radarRef.current = radar;
    countRef.current = 0;
    const unsub = l3Stream.subscribe(
      symbol,
      (ev) => { countRef.current += 1; ingest(radar, ev, markRef.current); },
      (st) => { statusRef.current = st; },
      (snap) => { seedFromSnapshot(radar, snap); }
    );
    const timer = setInterval(() => {
      const now = Date.now();
      const r = radarRef.current;
      if (!r) return;
      const eps = countRef.current * 2; countRef.current = 0;
      setView({
        signals: activeSignals(r, now), events: r.timeline.slice(), walls: restingWalls(r),
        connected: statusRef.current.connected, synced: statusRef.current.synced, reason: statusRef.current.reason,
        eventsPerSec: eps, reliability: (p) => wallReliability(r, p),
      });
    }, 500);
    return () => { clearInterval(timer); unsub(); radarRef.current = null; setView(EMPTY); };
  }, [symbol, tick, enabled]);

  return view;
}
