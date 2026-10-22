# Vektor - CLOB Grid Studio, Funding Harvester & Liquidation Shield for Strike Finance V2

Built for the Strike Finance 48-hour hackathon (Oct 21-23, 2026). Vektor is a quantitative execution terminal on Strike's central limit order book: a builder-fee grid studio with real-candle backtesting, a delta-neutral funding harvester, and a 24/7 liquidation shield - plus a headless worker, a CLI and AI-agent skill, and a public proof page so anyone can verify every fill against Strike's own API.

- **Live:** https://tryvektor.vercel.app · terminal https://tryvektor.vercel.app/app.html · docs https://tryvektor.vercel.app/docs
- Landing page: `/` · Terminal: `/app.html` · Proof: `/proof.html?account=<id>`
- Builder code: `vektor` (registered on mainnet, 10 bps)
- Repo: https://github.com/mrnetwork0001/Vektor

```bash
npm install
npm run dev          # http://localhost:5173 - landing; Launch App opens the terminal in Demo mode (no wallet needed)
npm test             # 78 tests: engines, backtester, simulator, CLI, full app render
npm run build        # dist/index.html + dist/app.html + dist/proof.html - deploy dist/ as static files
npm run worker       # headless 24/7 engine (needs STRIKE_API_* keys in the environment)
npm run cli -- plan ADA-USD --lower 0.21 --upper 0.235 --levels 12 --margin 200 --leverage 5
```

Copy `.env.example` to `.env`. Defaults point at **mainnet** (`api.strikefinance.org`) because builder codes live there; testnet has no builder codes and mostly empty books.

---

## Contents

1. [What it does](#1-what-it-does)
2. [How we built it](#2-how-we-built-it)
3. [Architecture](#3-architecture)
4. [Strike integration - every endpoint we use](#4-strike-integration)
5. [Verification and proof](#5-verification-and-proof) · [5b. Mainnet verification log](#5b-mainnet-verification-log-2026-10-22)
6. [Running it: terminal, worker, CLI, agent skill](#6-running-it)
7. [Testing](#7-testing)
8. [Known limits](#8-known-limits)
9. [Roadmap](#9-roadmap)
10. [Judging criteria mapping](#10-judging-criteria)

---

## 1. What it does

### Three engines

| Engine | What it does | Strike surface |
|---|---|---|
| **CLOB Grid Studio** | Neutral grid (geometric or arithmetic, 4-60 levels): buys rest below the mark, sells above, the level nearest the mark stays empty so the sides never collide. Every rung is a post-only GTC limit placed in one `POST /v2/orders/batch` with `X-Builder-Fee-Bps`. A fill places its counter one rung away **for the filled quantity**; an exit fill books the round trip and re-arms the entry. Net per round trip is shown after maker fees *and* the builder fee. | `/v2/orders/batch`, `/price/v2/depth` + `@depth` diffs, user stream `ORDER_TRADE_UPDATE` |
| **Funding Harvester** | Strike funds **hourly**. Ranks every market by `hourly rate × 24 × 365`, sizes a 1:1 perp hedge against spot the user holds (read from the wallet), estimates the hedge's liquidation from the market's real margin tiers, enters in sliced IOC limits that keep the builder fee (Strike's TWAP drops it). Rule C unwinds after 3 adverse funding hours; funding collected is read from `/v2/history/funding`. | `/price/v2/premiumIndex`, `!markPrice@arr`, `/v2/history/funding` |
| **Aegis Liquidation Shield** | Distance-to-liquidation per position from the reference engine formulas. Rule A (< 8% buffer): cancel resting buy rungs. Rule B (< 5%): reduce-only market trim of 25%, with per-symbol cooldown and a pending-trim flag so it never double-fires. PANIC cancels everything and flattens with `close_position`. | `/v2/order/cancel[-all]`, reduce-only `POST /v2/order`, `ACCOUNT_UPDATE` |

### Around the engines

- **Backtest before you deploy** - the exact range you drew, replayed over 24h / 7d / 30d of mainnet candles through the same matching engine and grid code as the live grid. Net after builder fee, annualised, max drawdown, time-in-range, equity curve.
- **Smart range** - `last ± 3×ATR(14)`, level count sized to clear Strike's fee floor.
- **Funding-aware skew** - rung sizes tilt toward the side that *receives* funding; total notional preserved. Spread capture and carry from one ladder.
- **Per-rung brackets** - each entry can be a `POST /v2/order/strategy` with a stop leg; builder fee on both legs; a stop fill retires the rung.
- **Auto-shift (trailing)** - breakout or edge-dwell re-centres the ladder in one `POST /v2/orders/replace`; inventory is carried as exit rungs, never orphaned.
- **Head-to-head vs Strike's native grid bot** - same range, same candles: builder revenue $X vs **$0** (native grid orders carry no builder code). In Live mode, launch the real native bot beside yours.
- **L3 spoof & iceberg radar** - order-level feed (`/ws/l3`, verified on ADA, BTC and SOL): large walls pulled before touch, levels that refill after fills, per-price wall reliability.
- **Regime guard** - Fear & Greed, open-interest shock, 24h range and funding → RUN / WIDEN / PAUSE. Counters are held while paused and flushed on recovery.
- **Liquidity heatmap** - time × price × resting notional from the top-20 book.
- **Reconcile + backfill** - grids persist locally; on reconnect, fills from `/v2/history/fill` are replayed, resting rungs reconciled against `/v2/openOrders`, builder telemetry rebuilt from real history.
- **Watchdog** - a `201` with no user-stream event within 8 s is checked with `GET /v2/order`; a 404 means Strike silently dropped it and the rung is freed.
- **Run as vault** - `vault_id` threaded through every grid order; vault list/create/performance panel (prototype, see limits).
- **Multi-symbol grids, browser alerts, 45-second Judge tour, themed confirm dialogs, mobile layout with a left drawer.**
- **In-app deposits on all three chains** - Ethereum (auto-switch to mainnet, ERC-20 approve then deposit), Solana (`signAndSendTransaction`), Cardano (CIP-30 `signTx`, witness set merged into the unsigned CBOR without touching the body, `submitTx`); amount typed in plain units, live wallet balance + gas check, hash registered with Strike automatically. All three chains exercised on mainnet: Ethereum (16 USDC via Rabby, tx `0x5000652a…`), Solana (5 USDC via Phantom, tx `3Gf7Bvva…`), Cardano (95 ADA ≈ $19.74 via Lace, tx `aaf4deb1…` - CIP-30 `signTx`, witness set merged client-side, `submitTx`). Each shows as `completed` / `pending_settlement` in Strike's ledger. Public Solana RPCs refuse browser origins, so reads go through a same-origin relay (`vite.config.ts` proxy in dev, `api/rpc.ts` serverless function on Vercel).
- **API-wallet sign-in** for the builder's own account (Strike won't Builder-Connect an account to its own code), "remember on this device" for both sign-in modes, first-run walkthrough with a `?` replay button.

---

## 2. How we built it

Timeline (all within the 48-hour window):

1. **Read the real API first.** Cloned `strike-builder-reference` and `strike-finance-skills` into `vendor/` and corrected the original brief against them: funding is hourly (not 8h), symbols are `BTC-USD`, enums are lowercase, `/v2/orders/batch` honours the builder fee while TWAP, the native grid bot and `/v2/order/replace` do not. Those facts shaped every design decision.
2. **Engines as pure modules.** `src/quant/*` has no React and no network; each function takes market rules + fees and returns orders. 22 unit tests before any UI existed.
3. **One adapter seam, two backends.** `ExecutionAdapter` (`placeBatch`, `cancel`, `cancelAll`, `onFill`, optional `placeStrategy`, `replaceAll`) is implemented by `SimExchange` (in-memory matching: post-only rejects, reduce-only clamps, brackets, isolated liquidations) and `LiveAdapter` (Strike REST + user stream). Demo mode is the real engines, not a mock UI.
4. **Terminal UI** on top of the reference app's auth, wallets, deposit/withdraw and math, with a central `useVektor` hook owning grids per symbol, shield, hedge, auto-shift, regime, watchdog and persistence.
5. **Headless worker, CLI and agent skill** reusing the same engines (no browser globals), so "24/7" and "agent-native" are literal.
6. **Second wave with seven parallel agents** - proof page, CLI/skill, skew + brackets, L3 radar, auto-shift, regime guard, vaults - each on disjoint files with an integration note, then wired into the shared hook/App by hand.
7. **Live verification on mainnet** - every read endpoint, all three WebSockets, Builder Connect with `vektor`, CLI, worker boot, proof selectors. Landing page, mobile layout and theme passes last.

Decisions worth knowing:
- **10 bps default builder fee**, not 50: at 50 bps a round trip pays 1% in builder fees alone, which eats most grid spreads. The design card shows net-per-cycle after fees so the break-even is visible.
- **Order roles live in the client ID** (`vektor-grid-<id>-<rung>-<e|x|s>-<seq>`) so fills route correctly after reconnects and reloads, and the proof page can attribute them without any server of ours.
- **Copy-trading was evaluated and deliberately not built**: followers mirror fills as taker IOC with no builder code; a grid leader's followers would chase every rung at taker fees.

---

## 3. Architecture

```
src/
  quant/                  pure engines (no React, no network) - all unit-tested
    gridEngine.ts         planGrid · applyGridFill · reconcileGrid · skew · brackets
    gridShift.ts          shouldShift · buildShiftedPlan (auto-shift via /v2/orders/replace)
    fundingHarvester.ts   rankFundingOpportunities · buildHedgePlan · buildHedgeSliceOrder · fundingFlipped
    liquidationShield.ts  assessPosition · evaluateShield (Rules A/B, cooldown) · buildFlattenOrders
    whaleRadar.ts         analyzeDepth · slippageForSize
    l3Radar.ts            spoof / iceberg detection, wall reliability
    regime.ts             assessRegime (F&G, OI shock, 24h range, funding)
    backtest.ts           runGridBacktest (candles → SimExchange + gridEngine) · parseKlines
    rangeSuggest.ts       atr · suggestRange
    backfill.ts           backfillGrid · telemetryFromFills · fundingCollected
    fillEvent.ts          ORDER_TRADE_UPDATE → FillEvent (shared with the worker)
    types.ts              ExecutionAdapter - the seam between engines and the exchange
  sim/                    demo mode: simExchange · priceSim (scenarios) · demoMarkets
  api/                    auth (Ed25519) · builderConnect · wallets · orders · account · deposit · withdraw (reference)
                          vektor (batch, replace-all, premium index, native bot) · liveAdapter · history · vaults
                          regime · publicHistory (proof page) · spotBalance
  ws/                     priceStream · userStream · l3Stream
  hooks/                  useVektor (the engine hook) · useRegime · useL3 · reference hooks
  components/quant/       GridStudio · GridLadder · DepthHeatmap · BacktestCard · HeadToHead · L3Radar
                          FundingHarvester · ShieldPanel · RegimePanel · VaultPanel · ActiveGrids
                          VektorHeader · SimControls · JudgeTour · ConfirmDialog
  proof/                  public proof page (own Vite entry)
  styles/                 index.css (reference) · vektor.css (layout, mobile) · theme.css (visual system)
worker/                   headless engine: strikeClient (Node signing/WS) · index.ts · Dockerfile · fly.toml
cli/                      vektor CLI · lib (pure parsing/formatting)
skills/vektor-grid/       SKILL.md for Claude Code / Cursor / Codex agents
docs/VAULTS.md            vault & copy-trading research with verified endpoint shapes
vendor/                   upstream strike-builder-reference and strike-finance-skills (reference only)
```

Data flow in Live mode: `priceStream` (marks, depth) and `userStream` (fills, positions) feed `useVektor`; engines produce orders; `LiveAdapter` signs and sends them; fills come back on the user stream and are routed by client ID. The worker runs the same loop in Node with `worker/strikeClient.ts`.

---

## 4. Strike integration

Everything below is exercised by the app; the read endpoints and WebSockets were verified live on mainnet on 2026-10-22.

**Trading (API wallet auth, builder fee honoured):** `POST /v2/orders/batch` · `POST /v2/order/strategy` · `POST /v2/orders/replace` · `POST /v2/order` (reduce-only trims, flatten) · `DELETE /v2/order/cancel` · `DELETE /v2/order/cancel-all`
**Account & history:** `/v2/account` · `/v2/positions` · `/v2/openOrders` · `/v2/symbols` · `/v2/portfolio` · `/v2/history/fill` · `/v2/history/funding` · `/v2/order` (watchdog)
**Markets & public data:** `/v2/markets` (margin tiers, tick/step/min notional) · `/v2/fee-tiers` · `/v2/grid/bot` (head-to-head) · `/v2/vaults`, `/v2/vault/:id/*` · `/price/v2/depth` · `markPrice` · `premiumIndex` · `klines` · `fearGreed` · `openInterest` · `ticker/24hr` · `/v2/l3/snapshot`
**WebSockets:** `/ws/price` (`!markPrice@arr`, `@depth`) · `/ws/user-api` (`session.logon`, `ORDER_TRADE_UPDATE`, `ACCOUNT_UPDATE`) · `/ws/l3`
**Auth:** Ed25519 API wallets (`{METHOD}:{PATH}:{TIMESTAMP}:{NONCE}:{BODY_HASH}`), Builder Connect, `X-Builder-Fee-Bps` on every attributed order.

Facts the build depends on (all from the official skills): funding is hourly at HH:00 UTC; writes are async (`201 pending` = sequenced, not filled); engine rejections arrive on the user stream; the native grid bot, TWAP and `/v2/order/replace` carry no builder code; empty history lists are `null`.

---

## 5. Verification and proof

- **Proof page** `/proof.html?account=<strike account_id>&bps=10` re-reads the account's fills, funding and positions from Strike's **public** history selectors in the viewer's browser, attributes them by Vektor's client-ID prefixes, reconstructs builder revenue with Strike's own formula (`floor(notional × bps / 10000, 2)`), and prints every curl it ran. The header's **Proof ↗** button opens it for the connected account.
- **Judge tour** (header button): a 45-second captioned auto-demo - deploy, fills, flash crash, shield cancel + trim, harvester, telemetry.
- **Audit script** (`scratchpad`, reproducible with the commands in SUBMISSION.md): 14 REST endpoints and 3 WebSockets checked live; CLI `plan`/`backtest`/`smart-range` run against mainnet.

---

### Live proof (mainnet, 2026-10-22)

First real grid placed by Vektor on Strike mainnet, account `01a162e1-f0fb-77f4-8958-8adaf4b9a2b9` (API-wallet session, so no builder fee on this account - Strike does not let a builder's own account approve its own code; a second wallet will show the fee).

- Deploy: 3 rungs on ADA-USD via one `POST /v2/orders/batch`; engine acks for `vektor-grid-mvju3867-0-e-0`, `-2-e-0`, `-3-e-0`.
- First fill (17:59:01Z): **buy 66 ADA @ 0.21175, maker, fee −$0.0007 (rebate)** - `/v2/history/fill` row with `client_order_id = vektor-grid-mvju3867-0-e-0`.
- Counter placed within the same second: `sell 66 @ 0.21232` (`vektor-grid-mvju3867-1-x-941905`) resting beside the two sell entries at 0.21290 / 0.21347.
- Position: long 66 ADA, entry 0.21175, cross.


**Builder-attributed run (second wallet, 2026-10-22 ~18:30Z)** - account `01a164cf-36b1-7387-aa2f-199cc57f8c3f` Builder-Connected to `vektor` (10 bps), funded $16 USDC through Vektor's in-app deposit flow (tx `0x5000652a…abd7e8`, credited after 13 confirmations). Grid of 3 rungs deployed; Strike's open-order records show every rung stamped `Builder: {"Code":"vektor","FeeBps":10}`:

```bash
curl "https://api.strikefinance.org/v2/openOrders?account_id=01a164cf-36b1-7387-aa2f-199cc57f8c3f"
```

First fill on that account (18:33:53Z): **sell 65 ADA @ 0.21237, maker** - counter buy placed at 0.21179 in the same second; position SHORT at 3x (Deploy now sets the symbol leverage). Strike delivered `builder_fee = 0.01` on the user-stream fill event (exactly `floor(13.80 × 10 bps, 2 dp)`), and Vektor's header telemetry showed **vol $13.80 · fills 1 · builder fees $0.01**. The public fill row itemises only the commission; the builder fee lives on the fill event and in the Builder Codes dashboard.

Verify yourself (public selectors, no auth):

```bash
curl "https://api.strikefinance.org/v2/history/fill?account_id=01a162e1-f0fb-77f4-8958-8adaf4b9a2b9&limit=10"
curl "https://api.strikefinance.org/v2/openOrders?account_id=01a162e1-f0fb-77f4-8958-8adaf4b9a2b9"
curl "https://api.strikefinance.org/v2/positions?account_id=01a162e1-f0fb-77f4-8958-8adaf4b9a2b9"
```
or open `/proof.html?account=01a162e1-f0fb-77f4-8958-8adaf4b9a2b9`.

Found and fixed on the way (all in the repo history): mainnet ADA min notional is $10 (testnet $5) and undersized rungs are silently dropped by the engine, so Deploy now blocks below the minimum; restore raced the open-orders fetch and could wipe the saved grid - now gated, and orphaned `vektor-grid-` orders on the book are adopted; Deploy now sets the symbol leverage on Strike.

## 5b. Mainnet verification log (2026-10-22)

Everything below ran against `api.strikefinance.org` with real funds during the hackathon window. Public selectors (`account_id` / `blockchain_address`, no auth) reproduce each line.

| What | Result | Verify |
|---|---|---|
| Builder code | `vektor` registered, 10 bps, Active (owner account `01a162e1-f0fb-77f4-8958-8adaf4b9a2b9`) | app.strikefinance.org/builder-codes |
| API-wallet sign-in | Owner account signed in with keys from app.strikefinance.org/api-keys (Strike refuses to Builder-Connect an account to its own code) | - |
| Ethereum deposit (in-app) | 16 USDC via Rabby: auto network switch, ERC-20 approve, deposit, auto-register; credited after 13 confirmations | `/v2/history/transaction?blockchain_address=0xEbB92c8f27368222E4B722FB386DbC6Fe80CC426` · tx `0x5000652a…` |
| Solana deposit (in-app) | 5 USDC via Phantom (`signAndSendTransaction`), status completed | `…?blockchain_address=GnX9xu9UZgtjNXREKebPRSQLA4FeAgBiXwp5LPY3FHHy&blockchain=solana` · tx `3Gf7Bvva…` |
| Cardano deposit (in-app) | 95 ADA (≈ $19.74) via Lace: CIP-30 `signTx`, witness merged client-side, `submitTx` | `…?blockchain_address=addr1q8evmul…&blockchain=cardano` · tx `aaf4deb1…` |
| Grid deploy (no builder) | 3 rungs on ADA-USD via one `POST /v2/orders/batch`, engine acks on the user stream | account `01a162e1…` |
| First fill + counter | buy 66 ADA @ 0.21175 (maker, rebate) → exit sell placed in the same second | `/v2/history/fill?account_id=01a162e1-f0fb-77f4-8958-8adaf4b9a2b9` |
| Builder-attributed grid | Second wallet Builder-Connected; every resting order recorded with `Builder: {"Code":"vektor","FeeBps":10}` | `/v2/openOrders?account_id=01a164cf-36b1-7387-aa2f-199cc57f8c3f` |
| **Builder fee charged** | sell 65 ADA @ 0.21237 (maker) → `builder_fee = 0.01` on the user-stream fill; header showed vol $13.80 · fills 1 · builder fees $0.01 | fill event (public rows itemise commission only) |
| Leverage sync | Deploy sets symbol leverage via `POST /v2/leverage` - position opened at 3x as configured | `/v2/positions?account_id=01a164cf…` |
| Reconcile / adopt | After a reload the app rebuilt the running grid from `/v2/openOrders` by client-ID prefix ("Grid adopted · 3 resting rungs") | - |
| Stop / flatten | Stop grid cancelled resting rungs; reduce-only market close ran on the owner account | `/v2/history/transaction?account_id=01a162e1…` |
| Hedge launch → shield → unwind | Cardano account: IOC sell 50 ADA @ 0.21248 (filled 50/50, tick-snapped price, builder code attached); Shield read SAFE 184% to liquidation; Unwind bought 50 @ 0.21254 reduce-only, position closed | `/v2/history/fill?account_id=01a16503-d2a3-74ad-855e-2362748ad8bb` |
| **Autopilot (server-run)** | Cardano account enrolled from the browser (signed enroll, key encrypted at rest on the VPS); server deployed 3 rungs on ADA-USD at 19:53Z, each stamped `Builder {vektor, 10}`. At 19:59:56Z, with the browser closed, the server-run grid **bought 65 ADA @ 0.21247 (maker) and placed its exit sell 65 @ 0.21304 itself** | `https://vektor.38-49-213-208.sslip.io/health` · `/v2/openOrders?account_id=01a16503-d2a3-74ad-855e-2362748ad8bb` |
| Withdraw | Owner account withdrew $21.06 through the Strike app (API wallets cannot withdraw by design) | same ledger, type `withdraw` |

Found and fixed during the run: mainnet ADA min notional is $10 (testnet $5) and undersized batch items are silently dropped - Deploy now blocks below the minimum and the Prove-it preset sizes from the live rules; restore raced the open-orders fetch and could wipe the saved grid - now gated on first load, orphaned `vektor-grid-` orders are adopted; public Solana RPCs 403 browser origins - reads go through a same-origin relay; the sidebar clipped under the taller header; leverage was not being set on Strike.

Not exercised on mainnet (verified in the simulator and tests): Shield Rule B trim (needs a position within 5% of liquidation), auto-shift `/v2/orders/replace`, brackets `/v2/order/strategy`, vault execution.

## 5c. Autopilot - grids that keep running after you close the tab

**Live:** https://vektor.38-49-213-208.sslip.io/health · verified on mainnet 2026-10-22 (see §5b).

Any user of the public app can hand their grid to the Autopilot server and close the browser. Nobody at Vektor trades; the server runs *each user's own* account.

**How it works**
1. You connect your wallet (Builder Connect) and design a grid as usual.
2. You tick **Keep running when I close this tab (Autopilot)** and press Deploy.
3. The browser **enrolls** your session's Strike API wallet with the server: the request is signed with that key (Ed25519), the server checks the signature and timestamp, validates the key against Strike (`GET /v2/account`), and stores it **encrypted (AES-256-GCM)** with a master key that never leaves the server.
4. The server deploys the grid and runs, 24/7 and per account: counter orders on every fill, trade-ID de-duplication, reconcile/backfill on restart, the Aegis shield every 2 s, regime guard and auto-shift. Every order carries `X-Builder-Fee-Bps`, so builder attribution is unchanged.
5. The browser becomes a **read-only mirror** (badge "Autopilot · server-run", polled every 5 s) and stops placing orders for that market, so orders are never doubled. Stop and PANIC go to the server.
6. **Disable Autopilot** stops your server grids and wipes your stored key. A new Builder Connect on Strike also revokes it.

**Why it's safe enough to offer**
- The stored key is a Strike API wallet: it can **trade and cancel, never withdraw**.
- Every control call (`status`, `grids`, `panic`, `disable`) must be signed by that same key with a fresh timestamp; replays are rejected. There are no passwords and no shared admin token.
- The server binds to `127.0.0.1` behind nginx/TLS; CORS is limited to the app's origin; private keys are never logged.

**Endpoints** - `GET /health` · `POST/DELETE /v1/enroll` · `GET /v1/status` · `POST /v1/grids` · `DELETE /v1/grids/:symbol` · `POST /v1/panic`. Run it with `npm run autopilot`; deployment notes (pm2, nginx, env) in [server/README.md](server/README.md). The app shows the toggle only when `VITE_AUTOPILOT_URL` is set.

**Honest status** - enroll, server-side deploy and builder-stamped resting orders are verified on mainnet. A server-handled fill with the tab closed is verified too (19:59:56Z, exit placed by the server). Server auto-shift and the regime-held queue are covered by tests with a fake Strike client, not yet observed live.

## 6. Running it

**Terminal** - `npm run dev`, open `/app.html`. Demo mode needs nothing. Live mode: connect a wallet (Cardano / Solana / EVM), Builder Connect approves `vektor`, deposit USDC, deploy. "Prove-it preset" sets a tight micro-grid that fills within minutes on a liquid book; "Copy proof summary" copies a markdown block for submissions.

**Worker** - `npm run worker` with `STRIKE_API_PUBLIC_KEY` / `STRIKE_API_PRIVATE_KEY` from https://app.strikefinance.org/api-keys. State in `worker/state.json`, grids in `worker/grids.json`, status at `GET :8787/`, `POST /stop/<symbol>`, `POST /panic`. Deploy with `docker compose up -d worker` or `worker/fly.toml`. See [worker/README.md](worker/README.md).

**CLI** - `npm run cli -- <plan|backtest|smart-range|deploy|fills|status|stop|panic> [--json]`. Public commands need no keys.

**Agent skill** - [skills/vektor-grid/SKILL.md](skills/vektor-grid/SKILL.md): install into `.claude/skills/` (or Cursor/Codex equivalents) and an agent can plan, backtest and deploy grids and read the shield through the CLI and worker.

---

## 7. Testing

`npm test` - 78 tests across 15 files: grid lifecycle (fills, partials, cancels, reconcile), skew and brackets, auto-shift (hysteresis, carry-forward, end-to-end sim), funding maths, shield cooldown/pending-trim, whale radar, L3 heuristics, regime scoring, backtester and range suggestion, backfill/telemetry, simulator (post-only rejects, reduce-only clamps, bracket legs), spot-balance CBOR, vault helpers, CLI parsing, and a full jsdom render of the app that deploys, crashes the market, checks the shield log, runs the tour and panics.

`npx tsc --noEmit` is clean; `npm run build` emits all three pages.

---

## 8. Known limits

- **Builder-fee attribution on a live fill** is still to be shown: the funded account owns the builder code and Strike refuses to approve an account for its own builder, so the fee-bearing run needs a second wallet (live placement itself is proven - see Live proof).
- **Vault execution** is a prototype: `vault_id` is on every order and reads are verified, but fills for a vault arrive on the vault's own user-stream socket, which is not subscribed yet. Do not route real money through a vault until that lands.
- **Worker parity**: the worker runs plain grids + shield; brackets, auto-shift and the regime guard live in the browser hook today.
- Backtests use mainnet "last" candles and fill every rung a wick touched - optimistic on thin books, and the UI says so. L3 spoof thresholds are hand-tuned.
- Builder fees are not itemised on fill-history rows; backfilled builder revenue is reconstructed with Strike's formula.

---

## 9. Roadmap

Vektor's revenue is the builder fee on every fill; each milestone multiplies attributed fills on Strike's book.

| When | What | Why it matters |
|---|---|---|
| Weeks 1-2 | **Vektor Grid Vault** - subscribe the vault user stream, handle `vault_withdrawal` closes, open a depositor product running skewed, shielded grids | TVL; every vault fill still pays the builder code (approval is checked on the leader) |
| Weeks 2-4 | **Worker parity + hosting** - brackets, auto-shift, regime guard headless; sub-account per strategy; Strike DMA endpoint for the hot path | Unattended operation that matches the terminal |
| Month 2 | **STRIKE flywheel** - route a share of builder revenue into STRIKE staking; staking lowers users' fee tier (`staking_fee_discount_rate`) → wider net-per-cycle → more volume; revenue share for stakers | Aligns Vektor, users and the token |
| Month 2 | **Social layer** - public strategy pages (the proof page is the seed), one-click clone into a sub-account, leaderboard and referral codes on Builder Connect | Distribution without a sales team |
| Month 3 | **Multi-venue funding carry** - compare Strike's hourly funding to other venues per asset, route the perp leg to the best rate, spot stays in the wallet | Strike's hourly cadence is a structural edge |
| Ongoing | **Agent-native** - MCP server over the CLI so any agent operates a scoped Vektor account | Strike is already courting agent traders with `strike-finance-skills` |

---

## 10. Judging criteria

| Criterion | Where Vektor answers it |
|---|---|
| Innovation | Funding-aware skew, L3 spoof/iceberg radar, backtest-before-deploy on the real engine, verifiable proof page |
| Integration with Strike | 20+ endpoints, 3 WebSockets, builder-fee mapping of every order path, engine-spec formulas, vaults and L3 |
| Utility & impact | Ranging markets become yield, high funding becomes carry, the shield trims before the engine liquidates; continuous attributed maker flow for Strike |
| Technical execution | Pure engines, one adapter seam, 78 tests, reconcile/backfill/watchdog built for an async engine, headless worker |
| Future potential | Roadmap above; `vault_id` already threaded; CLI + agent skill shipped |

See [SUBMISSION.md](SUBMISSION.md) for the submission text and [DEMO-SCRIPT.md](DEMO-SCRIPT.md) for the video shot list.
