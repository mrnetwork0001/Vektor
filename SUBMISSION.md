# Vektor - Strike Hackathon submission

**One line:** An autonomous quant terminal for Strike V2 - a builder-fee grid studio with real-candle backtesting, a delta-neutral funding harvester, and a 24/7 liquidation shield - plus a headless worker, a CLI/agent skill, and a public proof page so judges can verify every fill against Strike's own API.

- Live app: `<VERCEL URL>` (opens in Demo mode; **▶ Judge tour** in the header runs a 45-second guided demo)
- Proof page: `<VERCEL URL>/proof.html?account=<ACCOUNT_ID>&bps=10`
- Repo: `<GITHUB URL>`
- Demo video: `<VIDEO URL>`
- Builder code: `vektor` (registered on mainnet, 10 bps)

## How it maps to the five criteria

### 1. Innovation and creativity
- **Funding-aware grid skew** - the grid tilts rung sizes so the inventory it accumulates sits on the side that *receives* Strike's hourly funding. Spread capture and funding carry from one ladder; we have not seen this on any venue.
- **L3 spoof & iceberg radar** on Strike's order-level feed (`/ws/l3`) - flags walls that get pulled before touch and refilling icebergs, with a per-price reliability score.
- **Backtest-before-deploy** that replays the exact range you drew through the same matching-engine code the live grid uses.
- **Public proof page** - not a screenshot: the viewer's browser re-reads the account's fills from Strike's public history selectors and prints the curl commands.

### 2. Integration with Strike
Uses the CLOB, Ed25519 API wallets, Builder Codes, and 20+ endpoints across market data, trading, history, vaults and the L3 feed:
`/v2/orders/batch` · `/v2/order/strategy` (bracket legs) · `/v2/orders/replace` (auto-shift) · `/v2/order/cancel[-all]` · `/v2/history/fill|funding` · `/v2/openOrders` · `/v2/positions` · `/v2/markets` (margin tiers) · `/v2/fee-tiers` · `/v2/grid/bot` (head-to-head) · `/v2/vaults` · `/price/v2/depth|markPrice|premiumIndex|klines|fearGreed|openInterest|ticker/24hr` · `/v2/l3/snapshot` · WebSockets `/ws/price`, `/ws/user-api`, `/ws/l3`.
Every order the grid places carries `X-Builder-Fee-Bps`. We mapped which Strike order paths honour the builder fee and built around them (native grid bot and TWAP don't; batch, strategy and replace do). Formulas (liquidation, margin tiers, fees, funding) mirror Strike's engine spec from `strike-builder-reference`.

### 3. Utility and impact
- For traders: ranging markets become yield (grid), trending/high-funding markets become delta-neutral carry (harvester), and the shield trims before the engine liquidates.
- For Strike: continuous post-only maker flow on the CLOB; every fill attributed to a builder code. A 12-rung grid is 12 attributed orders and every flip is one more.
- For builders: the same engines run headless (`npm run worker`), from a CLI, and from an AI agent via `skills/vektor-grid`.

### 4. Technical execution
- Pure, unit-tested engines (78 tests: grid lifecycle, skew, brackets, auto-shift, backtest, shield cooldowns, L3 heuristics, regime scoring, reconcile/backfill, CLI, full app render).
- One `ExecutionAdapter` seam: Demo mode is the real engines on an in-memory matching engine with post-only rejects, reduce-only clamps and isolated liquidations - not a mock UI.
- Built for Strike's async engine: client-ID-encoded order roles, watchdog for silently-dropped `201`s, reconcile against `/v2/openOrders` + backfill from `/v2/history/fill` after a reload, per-symbol shield cooldown and pending-trim flag.
- Headless worker with Dockerfile / fly.toml, state persistence, status + panic endpoints.

### 5. Future potential - roadmap

Vektor is a business, not a hackathon demo: its revenue is the builder fee on every fill, and every feature below multiplies attributed fills on Strike's book.

**Weeks 1–2 - Vektor Grid Vault (depositor product).** `vault_id` is already on every order and the create/trade/read flows are documented and verified against mainnet (`docs/VAULTS.md`; a live vault already runs a grid). Remaining work is the vault's own user-stream socket for fills and `vault_withdrawal` handling. Result: anyone deposits USD, the worker runs skewed, shielded grids across the top markets, the leader takes the vault profit share, and **every vault fill still pays the builder code**. This is the TVL play.

**Weeks 2–4 - worker parity + hosted operation.** Brackets, auto-shift and the regime guard move from the browser hook into the worker; Fly deploy with per-user sub-accounts (`/v2/sub-accounts`) so each strategy's margin is isolated. Strike's DMA endpoint for the hot path once provisioned.

**Month 2 - STRIKE flywheel.** Builder revenue is on-chain-verifiable (proof page). We route a fixed share of it into STRIKE staking: staking lowers our users' fee tier (`staking_fee_discount_rate`), which widens the net-per-cycle on every grid, which generates more attributed volume. Revenue-share tiers for users who stake STRIKE through Vektor.

**Month 2 - social layer.** Public strategy pages (the proof page already is one): share a grid config, see its verified history, one-click clone into your own sub-account. Strike's leaderboard + referral codes attached to builder connect.

**Month 3 - multi-venue funding carry.** The harvester compares Strike's hourly funding to other venues per asset and routes the perp leg to the best rate while keeping spot in the user's wallet - Strike's hourly cadence is a structural edge here.

**Ongoing - agent-native.** The CLI and `skills/vektor-grid` already let Claude/Cursor agents plan, backtest and deploy. Next: MCP server so any agent can operate a Vektor account with scoped API wallets.

What is prototype today, honestly: the vault deploy path is wired but vault fills are not yet consumed; the worker runs plain grids + shield; copy-trading was evaluated and deliberately not built (followers would mirror at taker fees with no builder code).

## Honest status
- Verified on mainnet: every read endpoint, all three WebSockets, builder connect with `vektor`, CLI, worker boot, proof selectors.
- First real grid placed on mainnet 2026-10-22: 3 rungs on ADA-USD via `/v2/orders/batch`; first fill buy 66 ADA @ 0.21175 (maker, `client_order_id vektor-grid-mvju3867-0-e-0`), counter sell placed within the same second; verifiable at `https://api.strikefinance.org/v2/history/fill?account_id=01a162e1-f0fb-77f4-8958-8adaf4b9a2b9`. A second account (`01a164cf-36b1-7387-aa2f-199cc57f8c3f`) Builder-Connected to `vektor` then deployed a grid whose resting orders Strike records with `Builder: {"Code":"vektor","FeeBps":10}` (`/v2/openOrders?account_id=…`) - builder attribution verified on mainnet.
- Not finished: vault fill stream (prototype only), worker lacks brackets/auto-shift/regime (browser hook has them).
