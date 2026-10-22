# Integrating the auto-shift (trailing) grid into `useVektor`

Engine: `src/quant/gridShift.ts` (`shouldShift`, `buildShiftedPlan`). Adapter: optional `replaceAll(symbol, ordersWithoutSymbol)` on `ExecutionAdapter`, implemented by `SimExchange` and `LiveAdapter` (`POST /v2/orders/replace`, builder fee honoured). Tests: `src/quant/__tests__/gridShift.test.ts`.

## State to add in the hook

```ts
const autoShiftRef = useRef<Record<string, boolean>>({});          // symbol → enabled (default false)
const edgeStreakRef = useRef<Record<string, number>>({});           // symbol → consecutive edge ticks
const shiftBusyRef = useRef<Set<string>>(new Set());                // symbols with a replace in flight
const lastFillAtRef = useRef<Record<string, number>>({});           // symbol → ms of last fill (debounce)
```

Expose `setAutoShift(symbol, on)` and `autoShift: autoShiftRef.current` in the return object.

## The evaluation function (one place, called from both modes)

```ts
const maybeShift = useCallback(async (sym: string, mark: number) => {
  const g = gridsRef.current[sym];
  if (!g || !autoShiftRef.current[sym] || !mark || shiftBusyRef.current.has(sym) || !adapter.replaceAll) return;
  if (Date.now() - (lastFillAtRef.current[sym] ?? 0) < 2000) return;        // a fill just landed - let its counter settle
  const d = shouldShift(g, mark, { hysteresisPct: 0.5, edgeTicks: 20, minIntervalMs: 60_000 }, edgeStreakRef.current[sym] ?? 0);
  edgeStreakRef.current[sym] = d.edgeStreak;
  if (!d.shift) return;
  shiftBusyRef.current.add(sym);
  try {
    const r = buildShiftedPlan(g, mark, rulesFor(sym), fees);
    gridsRef.current[sym] = r.newState;                                     // optimistic: new CIDs are what the stream will echo
    const res = await adapter.replaceAll(sym, r.ordersWithoutSymbol);
    telemetryRef.current.ordersPlaced += res.accepted.length;
    if (adapter.mode === "live") for (const cid of res.accepted) pendingRef.current.set(cid, { symbol: sym, t: Date.now() });
    if (res.failed.length) gridLog(sym, "ERROR", `shift: ${res.failed.length} rejected ${res.failed.map((f) => f.error).join(", ")}`);
    gridLog(sym, "DEPLOY", `Auto-shift (${d.reason}) → ${r.ordersWithoutSymbol.length} orders via /v2/orders/replace`);
    if (modeRef.current === "live") notify("Grid shifted", `${sym}: ${d.reason.toLowerCase().replace("_", " ")} → ${r.plan.config.lowerPrice}–${r.plan.config.upperPrice}`);
    edgeStreakRef.current[sym] = 0;
  } catch (e: any) {
    gridsRef.current[sym] = g;                                              // roll back: nothing was applied (replace is all-or-nothing on static errors)
    setError(e.message); gridLog(sym, "ERROR", `shift failed: ${e.message}`);
  } finally { shiftBusyRef.current.delete(sym); persist(); bump(); }
}, [adapter, fees, rulesFor, persist]);
```

In the fill handler (`adapter.onFill`), record `lastFillAtRef.current[f.symbol] = Date.now()` when `f.fillQty > 0`.

## Where to call it

- **Sim tick loop**: after `s.ex.setMark(sym, p)` for every symbol, `void maybeShift(sym, p)`. The loop already runs at 500 ms / speed, so `edgeTicks: 20` ≈ 10 s of dwell at 1×.
- **Live**: in the effect that watches `live.prices` (mark updates every 3 s from `!markPrice@arr`), for each symbol with a grid: `void maybeShift(sym, parseFloat(live.prices[sym].p))`. 20 ticks ≈ 60 s of dwell.
- Do not call it from inside `applyGridFill` handling - the 2 s fill debounce above covers the race where a counter order is being placed while the mark crosses the boundary.

## Fill routing after a shift

`buildShiftedPlan` issues a **new `gridId`**, so `parseRungClientId` → `findGridById` resolves new-ladder fills to the shifted state, and `CANCELED` events for the old ladder's client IDs fall through (no grid with that id) - nothing to change in the fill handler. Late fills on *old* IDs (a rung that filled in the same engine instant as the replace) are likewise ignored by the grid; they still hit telemetry and `/v2/positions`, and the periodic REST re-sync corrects inventory display. If you want them booked, keep the previous `gridId` in `newState.previousGridIds` and let `findGridById` fall back to it.

## Live-mode cautions (from strike-trading docs)

- `/v2/orders/replace` cancels **every** active order on the symbol - including TP/SL legs and native grid-bot orders. Only enable auto-shift on symbols the grid owns outright (the HeadToHead card's native bot would be wiped).
- Static-rule failures (tick, step, min notional, price bound) reject the whole command and apply no cancels; `buildShiftedPlan` snaps through `planGrid` so this should not happen, but the catch block above rolls the state back anyway.
- A margin rejection stops the creates **after** the cancels have applied: the user stream then shows `REJECTED` for the remaining rungs and `applyGridFill` frees them. Watch the log line; the shield's Rule A will have nothing to cancel on those rungs.
- Rate limit is per API wallet; one replace per symbol per minute (`minIntervalMs`) is far below it.

## GridStudio toggle

In the "Running grid" block add:

```tsx
<div className="checkbox-row">
  <input id="autoshift" type="checkbox" checked={!!v.autoShift[symbol]} onChange={(e) => v.setAutoShift(symbol, e.target.checked)} />
  <label htmlFor="autoshift">Auto-shift (trailing) - re-centre via one /v2/orders/replace when price leaves the range</label>
</div>
```

and show `g.shifts ?? 0` as a "Shifts" stat in the stat row. The worker gets the same `maybeShift` in its 2 s tick, reading `autoShift` from `grids.json` per symbol.
