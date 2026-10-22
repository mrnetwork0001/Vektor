# Integration notes: funding-aware skew (#3) and per-rung brackets (#7)

Engine-only changes in `src/quant/gridEngine.ts`, `src/quant/types.ts`, `src/sim/simExchange.ts`, `src/api/liveAdapter.ts`. Nothing in `useVektor.ts` / `GridStudio.tsx` was touched; this is what they need to do.

## 1. GridConfig additions

```ts
skew?: { mode: "NONE" | "FUNDING"; fundingRateHourly?: number; maxSkew?: number }  // default NONE
stopLossPct?: number                                                                 // default none
```

### Skew formula (planGrid)
```
raw      = clamp(fundingRateHourly / SKEW_REF_RATE, −1, 1)    SKEW_REF_RATE = 0.00003 /h
sellMult = 1 + maxSkew × raw      buyMult = 1 − maxSkew × raw    (maxSkew default 0.5)
k        = (nBuy + nSell) / (nBuy × buyMult + nSell × sellMult)  ← keeps Σ notional = margin × leverage
size     = notionalPerRung × mult(side) × k / price             (then snapped to step)
```
Positive rate → longs pay shorts → sell rungs grow → accumulated inventory is short and *receives* funding.
Plan exposes `skewApplied` (−1..1, >0 favours SELL) and `expectedFundingUsdPerDay` = Σ notional of receiving-side rungs × |rate| × 24.

**UI (GridStudio design card):** a toggle "Funding skew" + read-only line `skew −1..1 · est. $X/day funding at full inventory`. Pass `skew: { mode: "FUNDING", fundingRateHourly: <rate> }` where `<rate>` = `v.fundingSnapshots.find(s => s.symbol === symbol)?.fundingRateHourly` (live `markPriceUpdate.r`, hourly). Optional slider for `maxSkew` 0–1.

### Stop-loss
`stopPriceFor(entry, side, pct, rules)`: BUY → entry × (1 − pct/100) snapped down; SELL → entry × (1 + pct/100) snapped up. `planGrid` warns if `stopLossPct <= spacingPct`.

## 2. Deploy path with brackets

```ts
const plan  = planGrid({ ...cfg, stopLossPct }, rules, fees);
const state = initGridState(plan, Date.now(), rules);           // ← pass rules when stopLossPct is set
if (plan.config.stopLossPct) {
  const { strategies } = buildDeployStrategies(plan, rules);     // one CreateStrategyOrderRequest per entry rung
  for (const s of strategies) await adapter.placeStrategy!(s);   // POST /v2/order/strategy, builder fee on all legs
} else {
  await adapter.placeBatch(buildDeployOrders(plan).orders);      // unchanged
}
```
`initGridState` with rules registers two resting entries per rung: role `e` (entry) and role `s` (its stop leg, `stopFor = entry cid`). `restingBuyIds` excludes `s`; `restingIds` includes them (so `stopGrid` cancels armed stops too - cancelling an unarmed one is a harmless no-op / 404).

`ExecutionAdapter.placeStrategy?` is optional. `LiveAdapter` and `SimExchange` implement it. The worker (`worker/index.ts`) does not yet - add the same branch there if brackets should run headless.

## 3. Fill routing - `applyGridFill` now returns `GridFillResult`

```ts
const r = applyGridFill(state, fill, now, rules);   // ← pass rules when stopLossPct is set
r.orders      // plain limits (exits; re-armed entries when no brackets)  → adapter.placeBatch
r.strategies  // re-armed entries WITH brackets                           → adapter.placeStrategy each
r.cancel      // client ids to cancel                                      → adapter.cancel(symbol, id) each
```
`cancel` is non-empty when (a) an exit fully fills → the entry's now-orphaned stop leg, or (b) a stop leg fills → the orphaned exit that would otherwise open a fresh position. **Existing callers that ignore `strategies`/`cancel` keep working for non-bracket grids but will leak orders for bracket grids - wire all three in `useVektor` (fill handler + reconcile backfill) and in `worker/index.ts`.**

Role `s` in `parseRungClientId` (`...-<rung>-s-<seq>`): a fill books `pnl = (fill − entry) × qty` (sign by side), increments `state.stops`, sets `rung.retired = true` (never re-armed; a later exit fill logs `SKIP … stopped out`), and emits a `STOP` log entry (new `GridLogEntry.kind`; add `.log-stop` CSS if the log colours by kind).

`reconcileGrid`: an unarmed stop (not on `/v2/openOrders` until its entry fills) is kept as long as its entry is still resting.

## 4. Backfill / history
`backfill.ts` calls `applyGridFill` without rules → re-armed entries come back as plain limits even for bracket grids. Pass `rules` there too (signature-compatible, 4th arg) once the hook has them.

## 5. Trade-offs
- Strike applies builder fee to all strategy legs, so the stop fill pays builder fee too (already counted via `builder_fee` on the fill).
- A stop leg is `reduce_only`; with several grids/positions on one symbol the engine may cancel it (`no_open_position`) - the CANCELED event frees the `s` entry correctly.
- Skew changes rung sizes, not counts; a 1.5× sell rung must still clear min notional (existing warning covers it).
- `k` renormalisation keeps the *planned* notional constant; after step-size rounding the realised total can differ by a few dollars on cheap assets.
