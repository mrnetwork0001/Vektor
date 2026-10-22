/**
 * Shared market data for all tenants: markets config, one mark-price stream,
 * and a regime assessment polled once per minute for every market.
 */

import type { Market } from "../src/types/market";
import { assessRegime, RANGE_FLOOR_PCT, type RegimeAssessment } from "../src/quant/regime";
import type { MarketHub } from "./engine";

const BASELINE_SAMPLES = 30;

export class Hub implements MarketHub {
  markets: Record<string, Market> = {};
  marks: Record<string, { p: number; r: number }> = {};
  regime: Record<string, RegimeAssessment> = {};
  private oiBaseline: Record<string, number[]> = {};
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private api: string, private log: (m: string) => void) {}

  async start() {
    const r = await fetch(`${this.api}/v2/markets`);
    if (!r.ok) throw new Error(`markets ${r.status}`);
    this.markets = (await r.json()).markets;
    this.connectMarks();
    await this.pollRegime().catch((e) => this.log(`regime: ${e.message}`));
    this.timer = setInterval(() => void this.pollRegime().catch((e) => this.log(`regime: ${e.message}`)), 60_000);
  }

  stop() { this.stopped = true; this.ws?.close(); if (this.timer) clearInterval(this.timer); }

  private connectMarks() {
    if (this.stopped) return;
    const ws = new WebSocket(this.api.replace("https://", "wss://") + "/ws/price");
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "subscribe", channel: "!markPrice@arr" }));
    ws.onmessage = (ev) => {
      for (const line of String(ev.data).split("\n")) {
        if (!line.trim()) continue;
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        for (const x of Array.isArray(m) ? m : [m]) if (x?.e === "markPriceUpdate") this.marks[x.s] = { p: parseFloat(x.p), r: parseFloat(x.r) };
      }
    };
    ws.onclose = () => { if (!this.stopped) setTimeout(() => this.connectMarks(), 3000); };
    ws.onerror = () => ws.close();
  }

  private async pollRegime() {
    const get = async (p: string) => { const r = await fetch(`${this.api}/price${p}`); return r.ok ? r.json() : null; };
    const [fg, oi, tk] = await Promise.all([get("/v2/fearGreed"), get("/v2/openInterest"), get("/v2/ticker/24hr")]);
    const fear = fg?.data?.value ?? null;
    const oiBy: Record<string, number> = {};
    for (const x of Array.isArray(oi) ? oi : []) oiBy[x.symbol] = parseFloat(x.openInterest);
    const tkBy: Record<string, any> = {};
    for (const x of Array.isArray(tk) ? tk : []) tkBy[x.symbol] = x;
    for (const s of Object.keys(this.markets)) {
      const t = tkBy[s];
      const base = this.oiBaseline[s] ?? [];
      this.regime[s] = assessRegime({
        symbol: s, fearGreed: fear, openInterest: oiBy[s] ?? null, oiBaseline: base,
        high24h: t ? parseFloat(t.highPrice) : null, low24h: t ? parseFloat(t.lowPrice) : null, last: t ? parseFloat(t.lastPrice) : null,
        fundingRateHourly: this.marks[s]?.r ?? null, rangeFloorPct: RANGE_FLOOR_PCT[s],
      });
      if (oiBy[s] != null) this.oiBaseline[s] = [...base, oiBy[s]].slice(-BASELINE_SAMPLES);
    }
  }
}
