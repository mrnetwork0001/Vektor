# Integrating the regime guard

New files: `src/api/regime.ts`, `src/quant/regime.ts`, `src/hooks/useRegime.ts`, `src/components/quant/RegimePanel.tsx`, tests in `src/quant/__tests__/regime.test.ts`.

## Wire-up (in `App.tsx` / `useVektor.ts`)

```ts
// App.tsx
const fundingBySymbol = Object.fromEntries(v.fundingSnapshots.map((s) => [s.symbol, s.fundingRateHourly]));
const regime = useRegime(v.symbols, fundingBySymbol, v.mode === "live" || true); // public endpoints, works in demo too
const [guardOn, setGuardOn] = useState(true);
// sidebar, under Execution mode:  <RegimePanel regime={regime} symbol={v.symbol} enabled={guardOn} setEnabled={setGuardOn} />
// pass down:  useVektor({ ..., regime: guardOn ? regime.assessments : {} })
```

## What `useVektor` should do with `assessments[symbol].recommendation`

1. **PAUSE** (`level === "EXTREME"`): keep existing rungs resting, but in the fill handler do **not** place the counter order (`r.orders`) — push them to a `heldOrders[symbol]` queue instead and log `SKIP "regime PAUSE — counter held"`. When the level drops below EXTREME, flush `heldOrders[symbol]` through `place()`. Also disable the Deploy button (`GridStudio` can read `assessments[symbol]?.recommendation.action === "PAUSE"`) with the reasons as the tooltip.
2. **WIDEN** (`level === "ELEVATED"`): on `deployGrid`, multiply the range half-widths by `widenFactor`: `lower = mark − (mark − cfg.lowerPrice) × f`, `upper = mark + (cfg.upperPrice − mark) × f`, keep `levels` so spacing widens proportionally (net-per-trip rises, fill rate falls). Show the adjusted range in the preview card ("widened ×1.4 by regime guard").
3. **RUN**: nothing.
4. **Level change** (compare previous `level` per symbol in a ref): append a shield-style log entry and call `notify("Regime " + level, reasons.join("; "), level === "EXTREME" ? "crit" : level === "ELEVATED" ? "warn" : "info")`. Suggested: store the log in `shieldRef.current.log` so it appears in the Aegis tab, or add a `regimeLog` to the hook return.
5. The headless worker (`worker/index.ts`) can import `assessRegime` + the fetchers (`src/api/regime.ts` only depends on `config.ts` for `PRICE_API_URL`; for the worker, fetch `${API}/price/v2/...` directly with the same parsing) and apply rules 1–2 in `onFill` / `ensureGrids`.

## Where to mount

Sidebar (`App.tsx`), directly under the **Execution mode** panel in both modes — it's cross-cutting like the shield, not grid-specific. Optionally a one-line badge in `VektorHeader` next to the Shield tab (`EXTREME` pulses red like the shield's CRITICAL).

## Thresholds (`src/quant/regime.ts` → `THRESHOLDS`)

| Component | Weight | 0 | 100 |
|---|---|---|---|
| Fear & Greed distance from 50 | 0.30 | 50 | 0 or 100 |
| Open interest vs rolling 30-sample baseline | 0.25 | 0% | ±50% |
| 24h range vs per-market floor (`RANGE_FLOOR_PCT`, default 2%) | 0.30 | 0 | 3× floor |
| |hourly funding| | 0.15 | 0 | 0.0001/h (87.6% APR) |

Score < 40 CALM → RUN · 40–70 ELEVATED → WIDEN ×1.25–1.75 · ≥ 70 EXTREME → PAUSE. Overrides: F&G < 25 or > 75 forces at least ELEVATED; 24h range ≥ 3× floor forces EXTREME.

## Observed mainnet shapes (2026-10-22)

- `GET /price/v2/fearGreed` → `{"status":"OK","data":{"value":12,"classification":"Extreme Fear","timestamp":1792662277152,"components":{"momentum":16.11,"breadth":6.25,"volatility":14.43},"marketsCounted":32}}` — mainnet is currently in Extreme Fear, so the guard will show ELEVATED/WIDEN out of the box.
- `GET /price/v2/openInterest` (no symbol) → array of `{"symbol","openInterest","time"}` for all 32 markets (BTC-USD one-sided OI was `0.70415`).
- `GET /price/v2/ticker/24hr` (no symbol) → array of `{symbol, priceChange, priceChangePercent, openPrice, highPrice, lowPrice, lastPrice, volume, quoteVolume, openTime, closeTime}`.
