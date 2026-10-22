/**
 * L3 market-by-order stream (public, no auth): wss://<host>/ws/l3 + GET /v2/l3/snapshot.
 *
 * Per the strike-orderbook skill: SUBSCRIBE to "<symbol>@l3", buffer updates
 * until the ack, then snapshot, drop updates with sequence <= last_sequence,
 * apply the rest in strict +1 order. A gap, a `clear`, or a close means
 * re-bootstrap. The server closes slow clients (1013) instead of dropping
 * updates; it never batches frames. One subscription per socket keeps the
 * sequence logic simple (limit is 10 sockets / IP).
 */

import { API_BASE_URL } from "../api/config";
import { toL3Event, type L3Event } from "../quant/l3Radar";

export interface L3Order { id: string; size: number }
export interface L3Book { bids: Map<string, L3Order[]>; asks: Map<string, L3Order[]>; lastSequence: number }
export interface L3Snapshot { type: "l3_snapshot"; symbol: string; last_sequence: number; timestamp: number; bids: { price: string; orders: { order_id: string; size: string }[] }[]; asks: { price: string; orders: { order_id: string; size: string }[] }[] }

export type L3Listener = (ev: L3Event, book: L3Book) => void;
export type L3StatusListener = (status: { connected: boolean; synced: boolean; reason?: string }) => void;

const L3_WS_URL = API_BASE_URL.replace(/^http/, "ws") + "/ws/l3";
const L3_SNAPSHOT_URL = `${API_BASE_URL}/v2/l3/snapshot`;
/** Canonical price key: "72247.30" and "72247.3" are the same level. */
export const px = (p: string) => (p.includes(".") ? p.replace(/0+$/, "").replace(/\.$/, "") : p);

interface Sub {
  symbol: string;
  ws: WebSocket | null;
  book: L3Book;
  last: number;
  buffered: any[];
  synced: boolean;
  dead: boolean;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  listeners: Set<L3Listener>;
  status: Set<L3StatusListener>;
  onSnapshot: Set<(snap: L3Snapshot) => void>;
  unavailableUntil: number; // after a 403/404 don't hammer the host
}

export class L3Stream {
  private subs = new Map<string, Sub>();

  /** Subscribe; returns an unsubscribe. The feed may be unavailable for a symbol - status reports it, nothing throws. */
  subscribe(symbol: string, onEvent: L3Listener, onStatus?: L3StatusListener, onSnapshot?: (s: L3Snapshot) => void): () => void {
    let sub = this.subs.get(symbol);
    if (!sub) {
      sub = { symbol, ws: null, book: emptyBook(), last: -1, buffered: [], synced: false, dead: false, attempts: 0, timer: null, listeners: new Set(), status: new Set(), onSnapshot: new Set(), unavailableUntil: 0 };
      this.subs.set(symbol, sub);
      this.connect(sub);
    }
    sub.listeners.add(onEvent);
    if (onStatus) { sub.status.add(onStatus); onStatus({ connected: sub.ws?.readyState === WebSocket.OPEN, synced: sub.synced }); }
    if (onSnapshot) sub.onSnapshot.add(onSnapshot);
    return () => {
      const s = this.subs.get(symbol);
      if (!s) return;
      s.listeners.delete(onEvent);
      if (onStatus) s.status.delete(onStatus);
      if (onSnapshot) s.onSnapshot.delete(onSnapshot);
      if (s.listeners.size === 0) { this.teardown(s); this.subs.delete(symbol); }
    };
  }

  book(symbol: string): L3Book | null { return this.subs.get(symbol)?.book ?? null; }

  private emitStatus(sub: Sub, reason?: string) {
    const st = { connected: sub.ws?.readyState === WebSocket.OPEN, synced: sub.synced, reason };
    for (const cb of sub.status) { try { cb(st); } catch { /* listener error */ } }
  }

  private connect(sub: Sub) {
    if (sub.dead) return;
    if (typeof WebSocket === "undefined") { this.emitStatus(sub, "no WebSocket in this environment"); return; }
    if (Date.now() < sub.unavailableUntil) { sub.timer = setTimeout(() => this.connect(sub), sub.unavailableUntil - Date.now()); return; }
    sub.synced = false; sub.last = -1; sub.buffered = []; sub.book = emptyBook();
    let ws: WebSocket;
    try { ws = new WebSocket(L3_WS_URL); } catch (e: any) { this.emitStatus(sub, e?.message ?? "connect failed"); this.scheduleReconnect(sub); return; }
    sub.ws = ws;
    ws.onopen = () => {
      sub.attempts = 0;
      ws.send(JSON.stringify({ method: "SUBSCRIBE", params: [`${sub.symbol.toLowerCase()}@l3`], id: 1 }));
      this.emitStatus(sub);
    };
    ws.onmessage = (e) => {
      // Spec says one update per frame, but tolerate "\n" batching anyway.
      for (const line of String(e.data).split("\n")) {
        if (!line.trim()) continue;
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          if (m.error) { sub.unavailableUntil = Date.now() + 60_000; this.emitStatus(sub, m.error.msg ?? "subscribe rejected"); this.restart(sub); return; }
          void this.bootstrap(sub);
          continue;
        }
        if (m.type !== "l3_update") continue;
        if (!sub.synced) { sub.buffered.push(m); if (sub.buffered.length > 50_000) sub.buffered.splice(0, 25_000); continue; }
        this.apply(sub, m);
      }
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = (e) => {
      sub.ws = null; sub.synced = false;
      if (sub.dead) return;
      if (e.code === 1008 || e.code === 1003) sub.unavailableUntil = Date.now() + 60_000; // policy / unsupported → back off hard
      this.emitStatus(sub, `closed ${e.code}`);
      this.scheduleReconnect(sub);
    };
  }

  private async bootstrap(sub: Sub) {
    try {
      const res = await fetch(`${L3_SNAPSHOT_URL}?symbol=${encodeURIComponent(sub.symbol)}`);
      if (!res.ok) {
        if (res.status === 400 || res.status === 403 || res.status === 404) sub.unavailableUntil = Date.now() + 120_000; // not served for this symbol/host
        this.emitStatus(sub, `snapshot ${res.status}`);
        return this.restart(sub);
      }
      const snap: L3Snapshot = await res.json();
      if (sub.dead || !sub.ws) return;
      const book = emptyBook();
      for (const [side, levels] of [[book.bids, snap.bids], [book.asks, snap.asks]] as const) {
        for (const lvl of levels ?? []) side.set(px(lvl.price), lvl.orders.map((o) => ({ id: o.order_id, size: parseFloat(o.size) })));
      }
      book.lastSequence = snap.last_sequence;
      sub.book = book; sub.last = snap.last_sequence; sub.synced = true;
      for (const cb of sub.onSnapshot) { try { cb(snap); } catch { /* listener error */ } }
      const pending = sub.buffered; sub.buffered = [];
      for (const u of pending) if (u.sequence > sub.last) { this.apply(sub, u); if (!sub.synced) return; }
      this.emitStatus(sub);
    } catch (e: any) {
      // A TypeError here is a network/CORS failure (the snapshot endpoint sends no
      // Access-Control-Allow-Origin header to browsers). Back off for 10 minutes
      // instead of hammering the 10 req/s limit; the worker/CLI are unaffected.
      const cors = e instanceof TypeError;
      if (cors) sub.unavailableUntil = Date.now() + 600_000;
      this.emitStatus(sub, cors ? "L3 snapshot blocked by CORS in the browser (worker/CLI only)" : e?.message ?? "snapshot failed");
      this.restart(sub);
    }
  }

  private apply(sub: Sub, u: any) {
    if (u.action === "clear" || u.sequence !== sub.last + 1) { this.emitStatus(sub, u.action === "clear" ? "engine clear" : "sequence gap"); return this.restart(sub); }
    sub.last = u.sequence;
    sub.book.lastSequence = u.sequence;
    const side = u.side === "buy" ? sub.book.bids : sub.book.asks;
    const k = px(String(u.price));
    const q = side.get(k) ?? [];
    if (u.action === "open") q.push({ id: u.order_id, size: parseFloat(u.remaining_size) });
    else {
      const i = q.findIndex((o) => o.id === u.order_id);
      if (i < 0) { this.emitStatus(sub, "unknown order id"); return this.restart(sub); }
      if (u.remaining_size === "0" || parseFloat(u.remaining_size) === 0) q.splice(i, 1); else q[i].size = parseFloat(u.remaining_size);
    }
    q.length ? side.set(k, q) : side.delete(k);
    const ev = toL3Event(u);
    if (!ev) return;
    for (const cb of sub.listeners) { try { cb(ev, sub.book); } catch (e) { console.error("[L3] listener error", e); } }
  }

  private restart(sub: Sub) {
    if (sub.dead) return;
    const ws = sub.ws; sub.ws = null; sub.synced = false;
    if (ws) { ws.onclose = null; ws.onmessage = null; try { ws.close(); } catch { /* ignore */ } }
    this.scheduleReconnect(sub);
  }

  private scheduleReconnect(sub: Sub) {
    if (sub.dead || sub.timer) return;
    sub.attempts += 1;
    const delay = Math.max(1000 * 2 ** Math.min(sub.attempts, 5), sub.unavailableUntil - Date.now(), 1000);
    sub.timer = setTimeout(() => { sub.timer = null; this.connect(sub); }, Math.min(delay, 120_000));
  }

  private teardown(sub: Sub) {
    sub.dead = true;
    if (sub.timer) { clearTimeout(sub.timer); sub.timer = null; }
    if (sub.ws) { sub.ws.onclose = null; sub.ws.onmessage = null; try { sub.ws.close(); } catch { /* ignore */ } sub.ws = null; }
  }
}

const emptyBook = (): L3Book => ({ bids: new Map(), asks: new Map(), lastSequence: -1 });

export const l3Stream = new L3Stream();
