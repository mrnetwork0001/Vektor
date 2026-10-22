# Running Vektor as a Strike vault / copy-trading lead

Research notes from `vendor/strike-finance-skills/skills/strike-vaults` and `strike-copy-trading`, cross-checked against mainnet public endpoints on 2026-10-22. Items marked **verified** were observed live; everything else is from the skill docs (Strike's own, generated from their backend) and marked **doc**.

## TL;DR — feasible in 48h: **YES for vaults, NO (as a product feature) for copy trading**

- **Vaults**: a vault is just another trading account. The leader trades it by adding `"vault_id": "<uuid>"` to the exact order bodies Vektor already sends. No new order model, no new auth. Create + trade + public performance reads are all available to an API wallet. The one hard constraint is money: `initial_deposit ≥ $100` from the leader's withdrawable balance.
- **Copy trading**: there is nothing for a *lead* to do — any non-vault account can be copied, there is no opt-in, and the lead API surface is read-only stats. Followers mirror the lead's **fills** as market IOC orders (not resting orders), so a grid lead's followers would buy every dip and sell every rip at market with taker fees and no builder code. It works, but it is a worse product than the vault and gives us no API to build against. Recommendation: expose "copy me" as a link to Strike's copy page + the lead stats card, nothing more.

Live proof that the pattern is real: mainnet vault `MARKET WIZARDS` (`536b4d72-…`) currently has **432 open orders tagged `grid-vault_536b4d72-WTI-USD-…`** — a Strike native grid bot running inside a user vault (**verified** via `GET /v2/openOrders?vault_id=…`).

## Vaults

### Concepts (doc)
- `account_id` of a vault = `vault_` + first 8 chars of `vault_id` (e.g. `vault_536b4d72`). Use it for the user-stream subscription, **not** as a REST `account_id` selector — REST wants the UUID via `vault_id=`.
- Types: `user` (anyone creates one, becomes leader; default 10% Leader Fee; leader must keep ≥ 5% of shares) and `protocol` (Strike-run, e.g. SLP).
- Share price = `(wallet balance + uPnL) / total_shares`; starts at 1. Deposits mint shares at current price; withdrawals are deferred `lockup_days × 24h` and execute at the *then* share price.
- Status `active | paused | closed`. Only `active` accepts new orders and deposits.
- Amounts are **JSON strings** on create/deposit/withdraw. Writes are **async**: `200` = queued; outcome arrives as wrapped `ACCOUNT_UPDATE` `VAULT_*` events. Nothing is idempotent.

### Can an API wallet create a vault? **Yes (doc)**
`POST /v2/vault/create` is "Trading + masterOnly": API wallet or JWT, must be the master account (sub-account-bound API wallets get `403 not available to sub-account API keys`). One active user vault per account (`409 user can only create one vault at a time`).

```json
POST /v2/vault/create
{ "name": "Vektor Grid Vault", "description": "...", "initial_deposit": "100",
  "leader_commission_bps": 1000, "lockup_days": 1, "min_deposit": "50", "allow_proportional_close": true }
→ 200 { "success": true, "request_id": "uuid", "message": "vault creation request submitted" }
```
- `initial_deposit` ≥ `"100"` (API) and ≥ `min_deposit` (engine), taken from the leader's **withdrawable** balance.
- `leader_commission_bps` 0–5000; **`0` is replaced with 1000 by the engine** (lowest effective is 1 bps).
- The new `vault_id` is **not returned** → poll `GET /v2/vaults?leader_account_id=<my account_id>` (public). Failures come as `VAULT_CREATE_FAILED` (e.g. `insufficient_balance`).
- `allow_proportional_close: true` matters for a grid: withdrawals then shrink every position proportionally instead of chopping 10% of the largest position per round.

### Trading the vault (doc; selector semantics verified on reads)
Add `"vault_id": "<uuid>"` to: `POST /v2/order`, **`/v2/orders/batch`** (top-level field, also accepted per item), `/v2/orders/replace`, `/v2/order/replace`, `/v2/order/replace-batch`, `/v2/order/strategy`, `DELETE /v2/order/cancel`, `/v2/order/cancel-all`, `/v2/leverage`, `/v2/marginMode`, `POST /v2/algo/twap`, `POST /v2/grid/bot`. Reads take `?vault_id=` (`/v2/account`, `/v2/positions`, `/v2/openOrders`, `/v2/history/*`).
- Only the leader: `403 only vault leader can trade on vault account`.
- Paused vault: `/v2/orders/batch` returns `200` with each item in `failed[]` as `vault trading is paused`; cancels still work (so the Shield's Rule A keeps working while paused, Rule B's trim does not).
- `vault_id` and `sub_account_id` are mutually exclusive.

### Does the builder fee survive on vault orders? **Yes (doc, two independent statements)**
- strike-vaults: "Builder-fee approval is checked on the leader's account, not the vault."
- strike-trading: "Approval is looked up on the calling account … never on a vault (vault trades use the leader's approval)." `/v2/orders/batch` honours `X-Builder-Fee-Bps`.
So Vektor's grid in a vault = depositors' capital, leader earns Leader Fee on their profit, **and** every fill still pays builder code `vektor`. Not verified with a live order (needs a funded vault).

### Economics (doc)
- Leader Fee = `commission_bps/10000 × max(0, exec_share_price − depositor avg_entry) × shares`, charged at withdrawal, paid to the leader as **new shares**. No fee on the leader's own withdrawals.
- Withdrawal unwind: if the vault is short of cash, Strike cancels vault orders (farthest from mark first), runs an RFQ, then reduce-only IOC closes tagged `client_order_id: "vault_wd_<order_id>"` with `act: vault_withdrawal`. **Vektor's reconcile must treat `vault_withdrawal` cancels as "rung gone, don't re-place"** and must not re-arm rungs that a withdrawal unwind closed — see INTEGRATION-vault.md.
- Recovery max margin ratio (`PATCH /v2/vault/:id/recovery-settings`, range (0, 0.5]) caps how much cash a withdrawal may take; default 0.5.

### Public reads (all **verified** on mainnet, no auth)
| Endpoint | Verified shape |
|---|---|
| `GET /v2/vaults?type=user&limit=3` | `{count: 4, vaults: [{vault_id, type, name, account_id: "vault_536b4d72", leader_account_id, leader_commission_bps: 500, total_shares, share_price, equity, wallet_balance, lockup_days, min_deposit, status, apr, all_time_pnl, return_24h, period_return, depositors: 5, fee_earned, sharpe_ratio}]}` |
| `GET /v2/vaults?type=protocol` | SLP vault: TVL ≈ $1.03M, `is_verified: true`, commission 0 |
| `GET /v2/vault/:id/portfolio?period=7d` | `total_value_locked, apr, all_time_pnl, return_24h, volume, all_time_volume, depositors, fee, commission_bps, fee_earned, pending_fees_*, sharpe_ratio, max_drawdown, total_maker_rebates, vault_history[[ts,tvl,pnl,fees,depositors,share_price]]` |
| `GET /v2/vault/:id/depositors?limit=2` | `{count, depositors: [{address, nickname, deposited, total_deposited, total_withdrawn, current_equity, share_percentage, pnl, deposited_since}]}` — exposes wallet addresses |
| `GET /v2/openOrders?vault_id=<uuid>` | `{count: 432, orders: [...]}` — the vault's live book, public |
| `GET /v2/vaults?leader_account_id=<uuid>` | documented; same list shape (not exercised — we have no vault yet) |

Gotchas (doc): `GET /v2/vault/:id` does not compute `apr`/returns/`depositors` (use `/portfolio` or the list); invalid `period` is `500` on the list and `404` on portfolio; `period_start_timestamp` is **seconds**.

### Watching a vault (doc)
Public user-stream subscription, no logon: `{"method":"subscribe","channel":"userstream","vault_id":"<uuid>","id":1}` → the vault's `ORDER_TRADE_UPDATE`s, positions, balances. This is how a **public proof page** for a vault-run grid can show live fills to judges without any credentials.

## Copy trading

### Becoming a lead (doc)
- No opt-in. "Any non-vault Strike account can be copied; there is no lead opt-in." Vaults **cannot** be copied or copy (`cannot follow a vault account`).
- Lead-side API: `GET /v2/copy/lead/stats` (auth; copiers, volume, profit share), public `GET /v2/copy/copiers?lead_account_id=`, `GET /v2/copy/leaderboard`, `GET /v2/copy/lead-traders` (**verified**: 16-follower Strike lead and Hyperliquid leads with `copy_score`, `style`, `bias`).
- Lead earns `profit_share_rate` (currently `"0.1"`) of a follower's positive `closed_pnl` when the follower stops.

### What followers mirror (doc)
- **Fills only**, as market IOC (same side; reduce-only for reductions). "Resting lead orders and lead cancels are not mirrored." Copies carry `client_order_id: copy:<subscription_id>:<lead_order_id>`; the lead's own client ids do **not** propagate to followers. Lead orders that are TWAP (`twap-`) or native grid (`grid-`, `:grid-`) are **not copied** — Vektor's `vektor-grid-…` ids are not on that exclusion list, so they *would* be copied.
- Copied orders carry **no builder code** and no builder fee.
- Consequence for a grid lead: followers pay taker fees chasing every rung fill with ~seconds of lag, get no take-profit limit (the exit is only placed when the lead's exit *fills*), and the lead gets 10% of whatever profit survives that. Expect followers to underperform the vault badly in a ranging market. This is the opposite of the vault, where depositors own the actual resting grid.

### Verdict
Vault: build it. Copy: surface the public stats (`/v2/copy/copiers`, `/v2/copy/lead/stats`) and a "Copy this account on Strike" link; do not build sizing logic around it.

## What was NOT verified
- Any vault write (`create`, `deposit`, `withdraw`, `pause`) — needs a funded mainnet account; the endpoints and bodies are from the skill docs.
- A grid order with `vault_id` reaching the engine, and the builder fee being charged on it — doc-backed only.
- `VAULT_*` event payloads — doc-backed only; `useUserStream` already routes wrapped `event_type` events, so wiring `VAULT_CREATE_FAILED`/`VAULT_DEPOSIT_FAILED` toasts is a one-liner.
