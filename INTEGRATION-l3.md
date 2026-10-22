# L3 spoof & iceberg radar — integration

New files (no shared files touched):
- `src/quant/l3Radar.ts` — pure analyzer (`createRadar`, `ingest`, `seedFromSnapshot`, `wallReliability`, `restingWalls`, `activeSignals`, `toL3Event`)
- `src/quant/__tests__/l3Radar.test.ts` — 5 tests
- `src/ws/l3Stream.ts` — WebSocket + snapshot bootstrap client (`l3Stream` singleton)
- `src/hooks/useL3.ts` — `useL3(symbol, tick, mark, enabled)` → `{ signals, events, walls, connected, synced, reason, eventsPerSec, reliability }`
- `src/components/quant/L3Radar.tsx` — panel (pure props)

## Mount in GridStudio.tsx

```tsx
import { useL3 } from "../../hooks/useL3";
import { L3Radar } from "./L3Radar";

// inside GridStudio(), after `const g = v.grid;`
const l3 = useL3(symbol, v.rulesFor(symbol).tick, mark, v.mode === "live");

// in the JSX, e.g. right after the <HeadToHead .../> card:
<L3Radar signals={l3.signals} events={l3.events} walls={l3.walls} mark={mark}
         status={{ connected: l3.connected, synced: l3.synced, reason: l3.reason, eventsPerSec: l3.eventsPerSec }} />
```

`enabled` is `v.mode === "live"` because the feed is mainnet-only data; in Demo mode the panel shows "L3 feed offline". If you want Demo to show something, feed synthetic events: `ingest(createRadar(tick), ev, mark)` with hand-built `L3Event`s (see the test for the shape) and pass `radar.timeline` / `activeSignals(radar, now)` straight into the panel.

Optional: use `l3.reliability(price)` in the whale-wall table (`analyzeDepth` walls) to colour walls that have a history of being pulled.

## CSS to paste into src/styles/vektor.css

```css
.l3-panel { grid-column: 1 / -1; }
.l3-timeline { width: 100%; height: 220px; display: block; background: rgba(255,255,255,0.015); border: 1px solid var(--border); border-radius: 6px; }
.l3-grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; margin-top: 10px; }
.l3-spoof { color: var(--amber); font-weight: 600; }
.l3-ice { color: #60a5fa; font-weight: 600; }
@media (max-width: 1100px) { .l3-grid { grid-template-columns: 1fr; } }
```

## Feed facts verified on mainnet (2026-10-22)

- Public, no auth. `GET https://api.strikefinance.org/v2/l3/snapshot?symbol=ADA-USD` → `{type:"l3_snapshot", symbol, last_sequence, timestamp, bids:[{price, orders:[{order_id,size}]}], asks:[…]}`. Works for **ADA-USD and BTC-USD** (the skill doc says "currently BTC-USD" only — stale). ETH/SOL untested.
- `wss://api.strikefinance.org/ws/l3`, `{"method":"SUBSCRIBE","params":["ada-usd@l3"],"id":1}` → ack `{"id":1,"result":null}`, then one `l3_update` per frame exactly as documented: `{type, symbol, action: open|cancel|partial_fill|full_fill|modify|clear, order_id, side: buy|sell, price, delta_size, remaining_size, sequence, timestamp, trade_id?, taker_order_id?}`.
- Rate: ~160 updates/s on ADA (a market maker re-quoting a 10-level ladder every ~100 ms — long runs of cancel+open). The hook throttles React to 2 renders/s; the radar itself is O(walls) per event.
- Limits: 10 req/s per IP shared by snapshots + handshakes; 10 sockets per IP. The client uses one socket per symbol and backs off 60–120 s on 400/403/404.

## Uncertainty

- The spoof heuristic (4× avg wall, pulled within 15 s, untouched, mark within 6 ticks) is tuned by hand; the market maker's constant re-quoting on ADA produces *cancel+open at the same price* pairs that are NOT spoofs — they fail the "wall" size test with the current EMA, but if the MM quotes bigger sizes they could show up. Raising `spoofMultiple` or requiring no re-open at the same price within 1 s would tighten it (not implemented).
- Reliability needs history: it's `null` until a wall at that price has been hit or pulled near touch at least once this session.
