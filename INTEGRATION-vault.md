# Integrating "Run as vault" into useVektor / App

What exists after this prototype (nothing below touches `useVektor.ts`, `App.tsx`, `GridStudio.tsx`):

| File | What |
|---|---|
| `src/api/vaults.ts` | Typed public reads (`listVaults`, `listMyVaults`, `getVault`, `getVaultPortfolio`, `getVaultDepositors`), leader writes (`createVault`, `pauseVault`, `resumeVault`, `depositToVault`, `withdrawFromVault`), pure helpers (`toShares8`, `withVault`, `vaultIdFromAccountId`, `pendingLeaderFee`, `summarizeVault`) |
| `src/quant/gridEngine.ts` | `GridConfig.vaultId?: string`; every order the engine builds (deploy + counters) carries `vault_id` when set. Additive only. |
| `src/components/quant/VaultPanel.tsx` | Props `{ accountId, vaultId, setVaultId }`. Lists the vaults the account leads, create form if none, public performance card, pause/resume. |
| `src/api/__tests__/vaults.test.ts` | Helpers, mocked reads, and "grid orders carry vault_id". |
| `docs/VAULTS.md` | Research + verified endpoint shapes. |

## Wiring (≈ 40 lines)

### 1. App.tsx - own the selection, render the panel
```tsx
const [vaultId, setVaultId] = useState<string | null>(null);
// sidebar, Live mode, after ConnectPanel:
<VaultPanel accountId={accountId} vaultId={vaultId} setVaultId={setVaultId} />
// pass down:
const v = useVektor({ ...liveInputs, vaultId });
```
Clear `vaultId` on disconnect (`strike:session-expired` handler) and when switching to Demo.

### 2. useVektor.ts - thread it into the engine and the adapter
- `LiveInputs.vaultId?: string | null`.
- `deployGrid`: `planGrid({ ...cfg, symbol, markPrice: mark, vaultId: mode === "live" ? live.vaultId ?? undefined : undefined }, …)`. That is the only place it needs to enter the grid: counters, backfill replays and reconcile all read `state.plan.config.vaultId`, and the persisted `GridState` already contains it, so a reload restores the right account.
- **Cancels and cancel-all must carry the vault too.** `ExecutionAdapter.cancel/cancelAll` take only `symbol`/`clientOrderId`; add an optional trailing `vaultId?: string` to both and to `replaceAll`, and in `LiveAdapter` pass it as `vault_id` in the body (`cancelOrder({ symbol, client_order_id, vault_id })`, `cancelAllOrders` needs a small extension in `src/api/orders.ts` to accept `{ symbol?, vault_id? }`; `replaceAllOrders` needs a top-level `vault_id`). Call sites in `useVektor` (`stopGrid`, Rule A cancel loop, `panic`) pass `g.plan.config.vaultId`. `SimExchange` ignores the extra arg.
- `place()` for shield trims and hedge slices: wrap with `withVault(order, live.vaultId)` so a trim on a vault position hits the vault, not the leader's own account. Rule B's `buildFlattenOrders`/trim payloads currently have no `vault_id`.
- Positions: when a vault is selected the shield must watch **the vault's** positions. Either (a) pass `?vault_id=` to `getPositions`/`getOpenOrders`/`getAccount` in `useUserStream` (one `vaultId` param; the stream itself is the leader's, so position pushes for the vault do **not** arrive there - subscribe a second socket with `{"method":"subscribe","channel":"userstream","vault_id":…}` (public, no logon) and merge its `ORDER_TRADE_UPDATE`/`ACCOUNT_UPDATE` into the same handlers), or (b) poll `GET /v2/positions?vault_id=` every 5 s for the shield. (b) is the 20-minute version; (a) is correct.
- Fill routing: fills on the vault arrive on the **vault's** stream, not the leader's. `LiveAdapter.onFill` must also listen on that second socket, otherwise the grid never sees its own fills. Client-id parsing is unchanged (`vektor-grid-…` ids are preserved on vault orders).
- Reconcile/backfill: `getFillHistory({ vault_id })` / `getOpenOrders(vault_id)` - add the selector to `src/api/history.ts` and `account.ts`. Treat fills with `auto_close_type: "vault_withdrawal"` and cancels with `cr: "vault_withdrawal"` as terminal for that rung (free it, do **not** re-place a counter): Strike closed inventory to pay a depositor.

### 3. Header / telemetry
- Show the execution account next to the mode pill: `vektor @ 10 bps · vault_536b4d72`.
- Builder fees are still attributed to the leader's builder code (doc: approval is checked on the leader), so the existing telemetry needs no change; the `builder_fee` field on vault-stream fills populates it.

### 4. Events (optional, 5 lines)
`useUserStream` already routes wrapped `event_type` events; add toasts for `VAULT_CREATE_FAILED`, `VAULT_DEPOSIT_FAILED`, `VAULT_LEADER_FEE_EARNED`, `VAULT_WITHDRAWAL_REQUESTED` (the last one is the signal that an unwind may hit the grid).

### 5. Worker
`worker/grids.json` entries get `"vaultId": "<uuid>"`; `worker/index.ts` passes it through `planGrid` and adds `vault_id` to its cancel bodies and `?vault_id=` to `loadRest()`, plus the second (public) vault-stream subscription for fills. Same three changes as the hook.

## Order of work
1. Adapter + orders.ts `vault_id` on cancel/cancel-all/replace (no UI change, no risk).
2. `deployGrid` plumbing + App state + panel in sidebar.
3. Vault user-stream socket for fills/positions.
4. Reconcile handling of `vault_withdrawal`.
5. Events/toasts, worker.

Steps 1–2 are enough to demo "deploy grid into vault" once the account has $100 withdrawable to create one; without step 3 the grid will place rungs but never flip, so ship 3 before any real money.
