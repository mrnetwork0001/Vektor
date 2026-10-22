# ⚡ Vektor — CLOB Grid Studio, Funding Harvester & Liquidation Shield for Strike Finance V2

Built for the Strike Finance 48-hour hackathon. Three quant engines on top of Strike V2's CLOB, Ed25519 API wallets and Builder Codes, with a demo mode that runs the exact same engines against an in-browser matching engine so judges can watch it work in 30 seconds.

```bash
npm install
npm run dev        # http://localhost:5173 — landing page; "Launch App" opens /app.html in DEMO mode, no wallet needed
npm test           # 29 tests: engines, backtester, simulator, full app smoke test
npm run build      # dist/index.html (landing) + dist/app.html (terminal) — deploy the dist/ folder as-is
```

Switch to **Live** in the sidebar to trade on Strike testnet (`api-v2-testnet.strikefinance.org`, the default in `src/api/config.ts`). Copy `.env.example` to `.env` to point at mainnet or set your builder code.

## The three modules

| Module | What it does | Strike surface |
|---|---|---|
| **Grid Studio** | Visual neutral grid (geometric or arithmetic, 4–60 levels). Buys rest below the mark, sells above, the level nearest the mark stays empty. Every rung is a post-only GTC limit placed in one `POST /v2/orders/batch`. When a rung fills, the counter take-profit is placed one rung away **for the filled quantity**; when the take-profit fills the entry is re-armed. Net profit per round trip is shown after maker fees *and* the builder fee. Whale-wall radar + VWAP slippage probe on the live top-20 book. | `/v2/orders/batch`, `/price/v2/depth` + `@depth` diffs, user stream `ORDER_TRADE_UPDATE` |
| **Funding Harvester** | Ranks every market by annualised funding (`hourly rate × 24 × 365` — Strike funds **hourly**). Sizes a 1:1 perp hedge against spot held in the user's own wallet, estimates the hedge's liquidation price from the market's **margin tiers**, and enters in IOC limit slices that carry the builder fee (Strike's TWAP endpoint drops it). Rule C unwinds the hedge after 3 consecutive adverse funding hours. | `/price/v2/premiumIndex`, `!markPrice@arr`, `/v2/orders/batch` |
| **Aegis Shield** | Computes distance-to-liquidation for every open position from the reference `src/math` formulas. Rule A (< 8%): cancel resting buy rungs to free margin. Rule B (< 5%): reduce-only market trim of 25%, with a per-symbol cooldown and a pending-trim flag so it never fires twice for one episode. Panic button cancels everything and flattens with `close_position` orders. | `/v2/order/cancel`, `/v2/order/cancel-all`, reduce-only `POST /v2/order` |

The header shows builder-code telemetry: volume routed, fills, and cumulative `X-Builder-Fee-Bps` revenue.

## What makes it stand out

- **Backtest before you deploy** — the exact range you drew is replayed over 24h / 7d / 30d of *mainnet* candles through the same matching engine and grid code as the live grid. Net PnL after builder fee, annualised return, max drawdown, time-in-range, equity curve.
- **Smart range** — ATR(14)-based range and a level count that clears Strike's fee floor (`spacing > mid × (maker + taker)`), one click to apply.
- **Reconcile after reload** — live grids persist locally (no secrets) and are rebuilt from `GET /v2/openOrders` by client-ID prefix on reconnect; rungs that filled or were cancelled while away are dropped.
- **Head-to-head vs Strike's native grid bot** — same range, same candles: Vektor (geometric, builder fee) vs `/v2/grid/bot` (arithmetic, no builder code). In live mode you can launch the native bot with the same parameters and watch both.
- **Liquidity heatmap** — Bookmap-style time × price × resting notional from the top-20 book, with the mark overlaid.
- **Browser alerts** — shield warnings/trims and grid round trips notify even when the tab is in the background.
- **Multi-symbol grids** — one grid per market, all shielded, listed in the sidebar with per-grid PnL and builder fees.

## Why not just use Strike's native grid bot?

`POST /v2/grid/bot` exists and is used for comparison, but it **ignores `X-Builder-Fee-Bps`** (grid orders carry no builder code), is arithmetic-only, and can't be shielded from the client. Vektor's grid runs through the batch endpoint so every fill is attributed and paid to the builder — that's the business model.

## Architecture

```
src/
  quant/                  pure engines, no React, fully unit-tested
    gridEngine.ts         planGrid · applyGridFill · restingBuyIds (roles encoded in client_order_id: vektor-grid-<id>-<rung>-<e|x>-<seq>)
    fundingHarvester.ts   rankFundingOpportunities · buildHedgePlan (tier-based liq) · buildHedgeSliceOrder · fundingFlipped
    liquidationShield.ts  assessPosition · evaluateShield (Rules A/B, cooldown) · buildFlattenOrders
    whaleRadar.ts         analyzeDepth · slippageForSize
    backtest.ts           runGridBacktest (candles → SimExchange + gridEngine) · parseKlines
    rangeSuggest.ts       atr · suggestRange
    types.ts              ExecutionAdapter — the seam between engines and the exchange
  sim/                    demo mode
    simExchange.ts        in-memory matching engine implementing ExecutionAdapter (post-only rejects, reduce-only clamps, fees, isolated liquidations)
    priceSim.ts           deterministic price process + scenarios (flash crash, squeeze, trends) + synthetic book with whale walls
  api/
    liveAdapter.ts        ExecutionAdapter over /v2/orders/batch + user-stream fills
    vektor.ts             batch orders, premiumIndex, native grid bot
    auth.ts …             from strike-builder-reference (Ed25519 signing, connect, deposit, withdraw)
  hooks/useVektor.ts      owns adapter + engine state; runs the demo tick loop or wires the live streams
  components/quant/       GridStudio · GridLadder (SVG) · DepthHeatmap (canvas) · BacktestCard · HeadToHead · ActiveGrids · FundingHarvester · ShieldPanel · VektorHeader · SimControls
  lib/notify.ts           toasts + Notification API
vendor/                   upstream strike-builder-reference and strike-finance-skills, for reference
```

## Facts verified against the Strike docs (`vendor/strike-finance-skills`)

- Symbols are `BTC-USD` style; REST enums are lowercase (`buy`, `limit`); sizes are `size`, decimals are strings.
- Funding is **hourly** at HH:00 UTC; `r` on `markPriceUpdate` is the hourly rate. Positive = longs pay shorts.
- Signature message `{METHOD}:{PATH}:{TIMESTAMP}:{NONCE}:{BODY_HASH}`; an empty body still hashes (`e3b0c4…`).
- `/v2/orders/batch`, `/v2/order/strategy`, `/v2/orders/replace` honour `X-Builder-Fee-Bps`; `/v2/order/replace`, TWAP, grid bot and copy-trading do not.
- Writes are async: `201 pending` means sequenced, not filled. Rejections (e.g. `order_would_match_immediately`) arrive on the user stream — the grid engine handles `CANCELED`/`REJECTED`/`EXPIRED` by freeing the rung.
- Testnet tier-0 fees: maker 0, taker 0.05%.

## Verify it yourself

`/proof.html?account=<strike account_id>&bps=10` re-reads the account's fills, funding and positions from Strike's **public** history selectors (`account_id` / `blockchain_address`, no auth) in the viewer's browser, attributes them by Vektor's client-ID prefixes, reconstructs builder revenue, and prints the exact curl commands used. The header's **Proof ↗** button opens it for the connected account.

## Second wave (built by parallel agents, all tested)

| Feature | Where | Status |
|---|---|---|
| **Funding-aware skew** — rung sizes tilt so accumulated inventory sits on the side that *receives* hourly funding; Σ notional preserved | Grid card toggle · `gridEngine.ts` | engine + sim + live |
| **Per-rung brackets** — each entry is a `POST /v2/order/strategy` with a stop leg; builder fee on both legs; stop fill retires the rung | Grid card slider | engine + sim + live |
| **Auto-shift (trailing)** — breakout or edge-dwell → re-centre in one `POST /v2/orders/replace`; inventory carried as exit rungs | "Running grid" toggle | engine + sim + live |
| **L3 spoof & iceberg radar** — order-level feed (`/ws/l3`, verified ADA + BTC on mainnet), spoof/iceberg signals, wall reliability | Grid tab (Live) | live only |
| **Regime guard** — Fear & Greed + OI shock + 24h range + funding → RUN / WIDEN / PAUSE; counters held while PAUSE | Sidebar panel | both modes |
| **Run as vault** — `vault_id` on every grid order; vault list/create/perf panel; builder fee is checked on the leader | Live sidebar · `docs/VAULTS.md` | prototype: deploy path wired, vault user-stream fills **not** yet (see INTEGRATION-vault.md) |
| **Agent skill + CLI** — `skills/vektor-grid/SKILL.md`, `npm run cli -- plan|backtest|smart-range|deploy|status|stop|panic|fills` | `cli/` | verified vs mainnet |
| **Public proof page** | `/proof.html` | verified vs mainnet |

Not yet in the headless worker: brackets (`placeStrategy`), auto-shift, regime guard — the hook has them, the worker runs plain grids + shield.

## Roadmap

1. **Vektor Grid Vault** (weeks 1–2): `vault_id` already on every order; add the vault user-stream + withdrawal handling → a depositor product where every fill still pays the builder code.
2. **Worker parity + hosting** (weeks 2–4): brackets, auto-shift, regime guard headless; sub-account per strategy; DMA hot path.
3. **STRIKE flywheel** (month 2): builder revenue → STRIKE staking → lower fee tier → wider net-per-cycle → more attributed volume; revenue-share for stakers.
4. **Social layer** (month 2): public strategy pages (the proof page is the seed), one-click clone, leaderboard + referral codes.
5. **Multi-venue funding carry** (month 3): route the perp leg to the best hourly rate, spot stays in the wallet.
6. **Agent-native**: MCP server over the CLI so any agent operates a scoped Vektor account.

Full version with the honest prototype list: [SUBMISSION.md](SUBMISSION.md).

## For judges: the 45-second tour

Click **▶ Judge tour** in the header. It switches to Demo, deploys a 12-level grid, lets it fill, triggers a −12% flash crash, shows Aegis cancel the buys and trim the long, tours the Funding Harvester, and ends on the builder-fee telemetry — with captions. Then switch to **Live**, connect a wallet, and the same engines run on Strike mainnet with builder code `vektor`.

## Headless 24/7: the worker

`npm run worker` runs the same grid + shield engines in Node with the API wallet key in the environment, state in a JSON file, fill backfill from `/v2/history/fill` on start, a watchdog for silently-dropped orders, and a status endpoint (`GET :8787/`, `POST /panic`, `POST /stop/<symbol>`). Deploy with `docker compose up -d worker` or the included [worker/fly.toml](worker/fly.toml). See [worker/README.md](worker/README.md). Builder codes and API wallets are self-service at `app.strikefinance.org/builder-codes` and `/api-keys`.

## Known limits (honest list for judges)

- The browser terminal runs its loops while the tab is open; use the worker for 24/7. Both persist grids and reconcile + backfill after a restart.
- Live order placement with a real API wallet has not yet been exercised end-to-end (needs a registered builder code and testnet margin); every other live read is real.
- Builder fees are not itemised on `/v2/history/fill` rows, so backfilled builder revenue is reconstructed with Strike's own formula `floor(notional × bps / 10000, 2)`.
- Backtests use mainnet "last" candles (testnet has no trades); wicks fill every rung they touch, which is optimistic for thin books.
- Funding "collected" in the demo accrues at ~1 minute per tick so the tracker visibly moves.
