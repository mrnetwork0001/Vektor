// ── L3 spoof & iceberg radar ──
//
// Pure analysis over Strike's market-by-order feed (or synthetic events of
// the same shape). Per order we know open → fills → cancel, so we can tell
// walls that were real (they got hit) from walls that were pulled when price
// came close (spoofs), and levels that keep refilling after fills (icebergs).

export type L3Action = "open" | "modify" | "cancel" | "partial_fill" | "full_fill" | "clear";
export type L3SideTag = "BID" | "ASK";

export interface L3Event {
  t: number; // engine ms
  seq: number;
  action: L3Action;
  orderId: string;
  side: L3SideTag;
  price: number;
  deltaSize: number; // signed, as the feed reports it
  remainingSize: number;
  tradeId?: number;
}

export interface L3Signal {
  kind: "SPOOF" | "ICEBERG";
  side: L3SideTag;
  price: number;
  notional: number;
  evidence: string;
  t: number;
  orderId?: string;
}

export interface L3RadarConfig {
  tick: number;
  windowMs: number; // rolling memory for signals / timeline
  spoofMultiple: number; // order notional ≥ this × avg open notional counts as a wall
  spoofMaxLifeMs: number; // cancelled within this long of opening
  spoofApproachTicks: number; // mark came within this many ticks of the order
  icebergRefills: number; // refills within icebergWindowMs → signal
  icebergWindowMs: number;
  icebergRefillGapMs: number; // an open this soon after a fill at the same level is a refill
  timelineCap: number;
}

export const DEFAULT_L3_CONFIG: Omit<L3RadarConfig, "tick"> = {
  windowMs: 5 * 60_000, spoofMultiple: 4, spoofMaxLifeMs: 15_000, spoofApproachTicks: 6,
  icebergRefills: 3, icebergWindowMs: 90_000, icebergRefillGapMs: 2_500, timelineCap: 600,
};

interface TrackedOrder { side: L3SideTag; price: number; size: number; openedAt: number; filled: number; minDistTicks: number; wall: boolean }
interface LevelStat { lastFillAt: number; refills: number[]; lastSignalAt: number }
interface WallStat { hitNotional: number; pulledNotional: number }

export interface L3RadarState {
  cfg: L3RadarConfig;
  orders: Map<string, TrackedOrder>;
  avgOpenNotional: number; // EMA of order notional at open
  opens: number;
  levels: Map<string, LevelStat>; // `${side}@${price}`
  walls: Map<string, WallStat>; // reliability per price key
  signals: L3Signal[];
  timeline: L3Event[]; // wall opens/cancels + every fill, for the UI
  lastMark: number;
  lastSeq: number;
}

const key = (side: L3SideTag, price: number) => `${side}@${price}`;

export function createRadar(tick: number, over: Partial<L3RadarConfig> = {}): L3RadarState {
  return { cfg: { tick, ...DEFAULT_L3_CONFIG, ...over }, orders: new Map(), avgOpenNotional: 0, opens: 0, levels: new Map(), walls: new Map(), signals: [], timeline: [], lastMark: 0, lastSeq: -1 };
}

/** Map a raw l3_update JSON to L3Event. Returns null for `clear` (caller resets). */
export function toL3Event(u: any): L3Event | null {
  if (!u || u.type !== "l3_update" || u.action === "clear") return null;
  return {
    t: Number(u.timestamp), seq: Number(u.sequence), action: u.action, orderId: String(u.order_id),
    side: u.side === "buy" ? "BID" : "ASK", price: parseFloat(u.price),
    deltaSize: parseFloat(u.delta_size ?? "0"), remainingSize: parseFloat(u.remaining_size ?? "0"),
    tradeId: u.trade_id != null ? Number(u.trade_id) : undefined,
  };
}

/** Feed one event. `mark` is the current mark/mid price (used for the approach test). Mutates and returns state. */
export function ingest(s: L3RadarState, ev: L3Event, mark: number): L3RadarState {
  const { cfg } = s;
  s.lastMark = mark || s.lastMark;
  s.lastSeq = ev.seq;
  const prune = ev.t - cfg.windowMs;

  // Keep the approach distance fresh for every tracked wall on every event (walls are few).
  if (s.lastMark > 0) {
    for (const o of s.orders.values()) if (o.wall) {
      const d = Math.abs(o.price - s.lastMark) / cfg.tick;
      if (d < o.minDistTicks) o.minDistTicks = d;
    }
  }

  switch (ev.action) {
    case "open": {
      const notional = ev.remainingSize * ev.price;
      s.opens += 1;
      s.avgOpenNotional = s.opens === 1 ? notional : s.avgOpenNotional + (notional - s.avgOpenNotional) * 0.05;
      const wall = s.opens > 5 && notional >= cfg.spoofMultiple * s.avgOpenNotional;
      const dist = s.lastMark > 0 ? Math.abs(ev.price - s.lastMark) / cfg.tick : Infinity;
      s.orders.set(ev.orderId, { side: ev.side, price: ev.price, size: ev.remainingSize, openedAt: ev.t, filled: 0, minDistTicks: dist, wall });
      if (wall) pushTimeline(s, ev);
      // Iceberg: an open right after a fill at the same level is a refill.
      const lv = level(s, ev.side, ev.price);
      if (lv.lastFillAt && ev.t - lv.lastFillAt <= cfg.icebergRefillGapMs) {
        lv.refills = lv.refills.filter((t) => t >= ev.t - cfg.icebergWindowMs);
        lv.refills.push(ev.t);
        if (lv.refills.length >= cfg.icebergRefills && ev.t - lv.lastSignalAt > cfg.icebergWindowMs) {
          lv.lastSignalAt = ev.t;
          s.signals.push({ kind: "ICEBERG", side: ev.side, price: ev.price, notional, t: ev.t, orderId: ev.orderId, evidence: `${lv.refills.length} refills within ${Math.round(cfg.icebergWindowMs / 1000)}s after fills at this level` });
        }
      }
      break;
    }
    case "partial_fill":
    case "full_fill": {
      const o = s.orders.get(ev.orderId);
      const filledQty = Math.abs(ev.deltaSize);
      if (o) {
        o.filled += filledQty;
        o.size = ev.remainingSize;
        if (o.wall) wallStat(s, o.price).hitNotional += filledQty * o.price;
      }
      level(s, ev.side, ev.price).lastFillAt = ev.t;
      pushTimeline(s, ev);
      if (ev.action === "full_fill") s.orders.delete(ev.orderId);
      break;
    }
    case "modify": {
      const o = s.orders.get(ev.orderId);
      if (o) o.size = ev.remainingSize;
      break;
    }
    case "cancel": {
      const o = s.orders.get(ev.orderId);
      if (o) {
        const life = ev.t - o.openedAt;
        const untouched = o.filled === 0;
        const near = o.minDistTicks <= cfg.spoofApproachTicks;
        if (o.wall) {
          pushTimeline(s, ev);
          if (near) wallStat(s, o.price).pulledNotional += o.size * o.price;
          if (untouched && near && life <= cfg.spoofMaxLifeMs) {
            s.signals.push({ kind: "SPOOF", side: o.side, price: o.price, notional: o.size * o.price, t: ev.t, orderId: ev.orderId, evidence: `${(o.size * o.price / Math.max(1, s.avgOpenNotional)).toFixed(1)}× avg wall pulled after ${(life / 1000).toFixed(1)}s, mark came within ${o.minDistTicks.toFixed(0)} ticks, 0 filled` });
          }
        }
        s.orders.delete(ev.orderId);
      }
      break;
    }
    case "clear":
      return reset(s);
  }

  if (s.signals.length && s.signals[0].t < prune) s.signals = s.signals.filter((x) => x.t >= prune);
  if (s.timeline.length && s.timeline[0].t < prune) s.timeline = s.timeline.filter((x) => x.t >= prune);
  return s;
}

/** Snapshot bootstrap: seed resting orders without emitting signals. */
export function seedFromSnapshot(s: L3RadarState, snap: { timestamp: number; bids: { price: string; orders: { order_id: string; size: string }[] }[]; asks: typeof snap.bids }): L3RadarState {
  reset(s);
  for (const [side, levels] of [["BID", snap.bids], ["ASK", snap.asks]] as const) {
    for (const lvl of levels) for (const o of lvl.orders) {
      const price = parseFloat(lvl.price), size = parseFloat(o.size), n = price * size;
      s.opens += 1;
      s.avgOpenNotional = s.opens === 1 ? n : s.avgOpenNotional + (n - s.avgOpenNotional) * 0.05;
      s.orders.set(o.order_id, { side, price, size, openedAt: snap.timestamp, filled: 0, minDistTicks: Infinity, wall: false });
    }
  }
  // Mark walls after the average is known
  for (const o of s.orders.values()) o.wall = o.size * o.price >= s.cfg.spoofMultiple * s.avgOpenNotional;
  return s;
}

export function reset(s: L3RadarState): L3RadarState {
  s.orders.clear(); s.timeline = []; s.lastSeq = -1;
  return s;
}

/** 0..1 share of wall notional at this price that got hit rather than pulled near touch; null when nothing observed. */
export function wallReliability(s: L3RadarState, price: number): number | null {
  const w = s.walls.get(priceKey(price));
  if (!w) return null;
  const total = w.hitNotional + w.pulledNotional;
  return total > 0 ? w.hitNotional / total : null;
}

/** Walls currently resting, with their reliability. */
export function restingWalls(s: L3RadarState): { side: L3SideTag; price: number; notional: number; ageMs: number; reliability: number | null }[] {
  const now = s.timeline.length ? s.timeline[s.timeline.length - 1].t : Date.now();
  return [...s.orders.values()].filter((o) => o.wall).map((o) => ({ side: o.side, price: o.price, notional: o.size * o.price, ageMs: now - o.openedAt, reliability: wallReliability(s, o.price) })).sort((a, b) => b.notional - a.notional);
}

export function activeSignals(s: L3RadarState, now: number): L3Signal[] {
  return s.signals.filter((x) => x.t >= now - s.cfg.windowMs).slice(-50).reverse();
}

const priceKey = (p: number) => p.toPrecision(10);
function wallStat(s: L3RadarState, price: number): WallStat {
  const k = priceKey(price);
  let w = s.walls.get(k);
  if (!w) { w = { hitNotional: 0, pulledNotional: 0 }; s.walls.set(k, w); }
  return w;
}
function level(s: L3RadarState, side: L3SideTag, price: number): LevelStat {
  const k = key(side, price);
  let l = s.levels.get(k);
  if (!l) { l = { lastFillAt: 0, refills: [], lastSignalAt: -Infinity }; s.levels.set(k, l); }
  return l;
}
function pushTimeline(s: L3RadarState, ev: L3Event) {
  s.timeline.push(ev);
  if (s.timeline.length > s.cfg.timelineCap) s.timeline.splice(0, s.timeline.length - s.cfg.timelineCap);
}
