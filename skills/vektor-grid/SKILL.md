---
name: vektor-grid
description: Vektor grid bots and liquidation shield on Strike Finance -- plan a neutral grid, backtest it on mainnet candles, suggest an ATR range, deploy it through POST /v2/orders/batch with a builder fee, read fills, and drive the 24/7 worker (status, stop, panic). Use when an agent needs to run, size, inspect or stop a Vektor grid, or check whether the Aegis shield has acted on a position.
---

# Vektor grid bots

Vektor is a client-side grid engine on Strike Finance V2 (`https://api.strikefinance.org`). Unlike Strike's native `/v2/grid/bot` it is geometric *or* arithmetic, every rung carries `X-Builder-Fee-Bps`, and the Aegis shield can cancel or trim it from the client. The same engines run in the browser terminal, the headless worker, and this CLI.

All commands: `npx tsx cli/vektor.ts <command> [args] [--json]` from the repo root. `--json` prints machine-readable output — always use it from an agent.

| Command | Needs | Purpose |
|---|---|---|
| `plan <symbol> --lower <p> --upper <p> [--levels 12] [--margin 200] [--leverage 5] [--mode GEOMETRIC\|ARITHMETIC]` | nothing | Rung ladder, spacing, net profit per round trip after maker + builder fees, warnings |
| `backtest <symbol> [--days 7] [--interval 1h] [--lower-pct 6] [--upper-pct 6] [--levels] [--margin] [--leverage] [--mode]` | nothing | Replay the grid over mainnet candles through the real matching engine |
| `smart-range <symbol> [--days 7]` | nothing | `last ± 3×ATR(14)` range and a level count above the fee floor |
| `deploy <symbol> --lower --upper [...] [--save]` | API wallet env | Place every rung in one `/v2/orders/batch` with the builder fee |
| `fills [--symbol X] [--limit 200]` | API wallet env | Vektor-tagged fills from `/v2/history/fill` with reconstructed builder revenue |
| `status` | running worker | Grids, positions, distance-to-liquidation, shield log, telemetry |
| `stop <symbol>` | running worker | Cancel that grid's rungs and drop it |
| `panic` | running worker | Cancel every order, flatten every position |

Environment: `STRIKE_API_URL` (default mainnet), `STRIKE_API_PUBLIC_KEY` / `STRIKE_API_PRIVATE_KEY` (raw 64-hex Ed25519, from https://app.strikefinance.org/api-keys), `BUILDER_FEE_BPS` (default 10, must be ≤ the registered builder fee share and ≤ the account's approved cap), `VEKTOR_WORKER_URL` (default `http://localhost:8787`), `VEKTOR_STATE` (default `worker/state.json`).

## How it works

- **Neutral grid.** Buys rest below the mark, sells above, the level nearest the mark stays empty. `levels − 1` rungs are placed; notional per rung = `margin × leverage / (levels − 1)`. Prices snap to tick (buys down, sells up), sizes to step.
- **Client IDs encode the role**: `vektor-grid-<gridId>-<rung>-<e|x>-<seq>`. `e` = entry, `x` = exit. An entry fill places the exit one rung away for the *filled* quantity; an exit fill books the round trip and re-arms the entry. Cancels/rejects free the rung.
- **Net per round trip** = spacing − 2×maker − 2×builder (percent of notional). Strike itself refuses grids whose spacing is below `mid × (maker + taker)`; `plan` warns when the net is ≤ 0.
- **Backtests use mainnet candles** regardless of `STRIKE_API_URL` (testnet books are empty). Each candle is walked open → low/high (toward the close) → close, so every rung a wick touched fills — optimistic on thin books. The range is scaled to the window's first open so the grid *shape* is tested.
- **Shield** (worker and terminal): Rule A, buffer < 8% → cancel resting buys; Rule B, buffer < 5% → reduce-only market trim of 25%, 15 s cooldown, never while a trim is pending. `status` shows `healths[].distanceToLiqPct` and the shield log.
- **Writes are async.** Strike answers `201 pending` before the engine runs the order. Engine rejections (`order_would_match_immediately`, `insufficient_balance`, ...) arrive on the user stream; the worker's watchdog looks up orders that produce no event within 8 s and frees the rung if the engine never saw them.

## Agent workflow

```bash
# 1. Size a grid above the fee floor
npx tsx cli/vektor.ts smart-range ADA-USD --json
# 2. Check the shape on 7 days of real candles (expect cycles > 0, netUsd > 0, timeInRangePct high)
npx tsx cli/vektor.ts backtest ADA-USD --lower-pct 3 --upper-pct 3 --levels 8 --margin 100 --leverage 3 --json
# 3. Inspect the exact rungs; abort if `warnings` is non-empty
npx tsx cli/vektor.ts plan ADA-USD --lower 0.2096 --upper 0.2209 --levels 8 --margin 100 --leverage 3 --json
# 4. Deploy and hand it to the worker (then start / restart `npm run worker`)
npx tsx cli/vektor.ts deploy ADA-USD --lower 0.2096 --upper 0.2209 --levels 8 --margin 100 --leverage 3 --save --json
# 5. Monitor
npx tsx cli/vektor.ts status --json
npx tsx cli/vektor.ts fills --symbol ADA-USD --json
# 6. Wind down
npx tsx cli/vektor.ts stop ADA-USD
```

Read the JSON, not the prose: `plan` → `{ gridId, rungs[], spacingPct, netCyclePct, warnings[] }`; `backtest` → `{ cycles, netUsd, netPctOnMargin, annualizedPct, maxDrawdownUsd, timeInRangePct, builderFeesUsd, inventory }`; `deploy` → `{ gridId, placed, failed[], saved }`; `status` → `{ grids{symbol: {resting, fills, cycles, realizedUsd, inventory, builderFeesUsd, log[]}}, positions[], healths[], shield{rules, log[]}, telemetry }`.

## Preferred: let the worker own the grid

For anything that should run unattended, put the spec in `worker/grids.json` and run `npm run worker` instead of `deploy`; the worker plans, places, flips, shields, reconciles after restarts and backfills fills from history. `deploy --save` writes the grid into the worker's state file so a *restarted* worker adopts it; a worker that is already running will not see it until restart.

## Gotchas

- `deploy` without `--save` places unmanaged orders: nothing re-places exits on fills. Only do that for a placement test, then `stop` is not available (no worker knows the grid) — cancel with `DELETE /v2/order/cancel-all {"symbol": ...}`.
- The builder code must be registered on the same network as `STRIKE_API_URL`; testnet does not know mainnet codes (`builder code not found`). Mainnet is the default.
- `fills` and `deploy` sign with the API wallet; `plan`, `backtest`, `smart-range` use public endpoints only.
- ADA min notional is $5, BTC $100, ETH/SOL $10 — `plan` warns when a rung is under it; raise `--margin` or lower `--levels`.
- Builder fees are not itemised on fill rows; `fills` reconstructs them with Strike's formula `floor(notional × bps / 10000, 2)`.
- Cancel-all, `/v2/orders/replace` and manual cancels on the symbol hit grid rungs too; the worker reconciles against open orders and drops the lost rungs.
- Max 100 bps builder fee; at 50 bps a round trip pays 1% in builder fees, which eats most tight grids. Default is 10.
