# Strike Builder Reference

A standalone React + TypeScript reference app for integrating with Strike Finance via the **Builder Codes API**.

Demonstrates the complete integration flow:
- Builder connect (wallet signature + client-generated Ed25519 API wallet)
- Deposits (quote -> build-tx -> user signs/submits -> confirm)
- Withdrawals (quote -> user signs message (+ Cardano funding tx) -> confirm)
- Order placement (market, limit, strategy with TP/SL) with a per-order builder fee
- Real-time WebSocket data (order book, mark prices, klines, positions, orders, balance)
- Trading math mirrored from the Strike engine (uPnL, IM/MM, margin tiers, liquidation price, balances, order margin, fees)

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:5173

## Configuration

Defaults point at **testnet** (`api-v2-testnet.strikefinance.org`). For mainnet, create a `.env` file:

```env
VITE_API_URL=https://api.strikefinance.org
VITE_PRICE_URL=https://api.strikefinance.org/price
VITE_PRICE_WS_URL=wss://api.strikefinance.org/ws/price
VITE_USER_WS_URL=wss://api.strikefinance.org/ws/user-api
VITE_STATS_URL=https://api.strikefinance.org/stat
VITE_BUILDER_CODE=your-builder-code
VITE_BUILDER_FEE_BPS=10
```

| Variable | Purpose |
|----------|---------|
| `VITE_API_URL` | Main API (`/v2/...`, `/auth/...`). Origin only — signatures cover the exact request path. |
| `VITE_PRICE_URL` | Price service REST (`/price/v2/depth`, `/price/v2/markPrice`, `/price/v2/klines`, ...) |
| `VITE_PRICE_WS_URL` | Public market-data WebSocket (`/ws/price`) |
| `VITE_USER_WS_URL` | User WebSocket for API wallets (`/ws/user-api`). `/ws/user` is the Strike app's JWT endpoint. |
| `VITE_STATS_URL` | Stats service (`/stat/v1/...`, e.g. leaderboard, dashboard) — not used by the UI |
| `VITE_BUILDER_CODE` | Your registered builder code |
| `VITE_BUILDER_FEE_BPS` | Builder fee in bps (0–100). Requested as the user's approval cap at connect and sent per order as `X-Builder-Fee-Bps`. |

## Project Structure

```
src/
  types/           TypeScript interfaces matching the backend JSON
  math/            Pure calculation functions (no React dependencies)
    positionCalculations.ts   uPnL, IM/MM, liquidation/bankruptcy price, margin ratio
    marginTiers.ts            Tier lookups (by notional / by leverage), MMR, MA, max leverage
    balanceCalculations.ts    Order margin (TotalOrderCost), available, withdrawable, margin balance
    fees.ts                   Effective fee rates, commission, builder fee
    orderBookUtils.ts         Depth diff merge, VWAP market fill estimation, grouping
    formatUtils.ts            Formatting, step snapping, half-even rounding
  api/             REST API integration
    auth.ts                   Ed25519 keypair + API wallet request signing
    builderConnect.ts         Builder connect flow (2 calls)
    wallets.ts                Wallet detection, connection and per-chain signing
    deposit.ts                Deposit flow (quote, build-tx, confirm)
    withdraw.ts               Withdrawal flow (estimate, quote, confirm)
    orders.ts                 Orders, strategy (TP/SL), cancel, replace, leverage, margin mode
    account.ts                Account, symbols, positions, open orders, markets, depth, klines, fees
  ws/              WebSocket connections
    priceStream.ts            Public: markPrice, depth, bookTicker, trade, kline, miniTicker
    userStream.ts             Authenticated (session.logon): ACCOUNT_UPDATE, ORDER_TRADE_UPDATE
  hooks/           React hooks
    useMarkets.ts             Fetch market config
    usePriceStream.ts         Live mark prices + locally maintained order book
    useUserStream.ts          REST state + live positions, orders, balance
    usePositions.ts           Enrich positions with derived fields
    useKlineData.ts           Chart history + live mark-price candles
    useOrderValidation.ts     Pre-trade checks mirroring engine admission
  components/      UI components
```

## API Authentication

Authenticated REST requests use **API wallet headers** (not JWT):

```
X-API-Wallet-Public-Key: <64 hex chars, Ed25519 public key>
X-API-Wallet-Signature:  <128 hex chars, Ed25519 signature>
X-API-Wallet-Timestamp:  <unix seconds; not in the future, at most 3 minutes old>
X-API-Wallet-Nonce:      <16..128 chars, single use per key, e.g. a UUID>
X-Builder-Fee-Bps:       <optional, orders only, not signed>
```

Signature message:
```
{METHOD}:{PATH}:{TIMESTAMP}:{NONCE}:{BODY_HASH}
```
- `PATH` is the URL path plus `?` + raw query when present (e.g. `/v2/positions?symbol=BTC-USD`).
- `BODY_HASH` is hex SHA-256 of the raw body bytes; an empty body hashes to
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- If the client clock drifts, use `GET /v2/time` (`{"serverTime": ms}`) to compute an offset.

The user WebSocket authenticates with `session.logon` instead: sign
`session.logon:{timestamp_ms}:{apiKey}` (milliseconds; 30 s future .. 3 min past).

See `src/api/auth.ts` and `src/ws/userStream.ts`.

## Key Formulas

All formulas are in `src/math/` and mirror the engine (`pkg/models` in the Strike backend; spec: `docs/CALCULATION_SPECS.md`). Decimals are strings in the API; derived values are rounded half-to-even to the market's `quote_prec`. Margin tiers come from `GET /v2/markets` → `margin_tiers`.

**Position (signed size: + long, − short):**
```
notional = mark × |size|
uPnL     = (mark − entry) × size
IM       = notional / leverage
MM       = notional × MMR − MA        (tier: first with notional ≤ max_notional, else last)
```

**Liquidation Price** (`dir` = +1 long / −1 short; MMR, MA from the position's tier):
```
LP = (EP − (W + TU − TM + MA) / size) / (1 − dir × MMR)

Isolated: W = iso_balance, TU = TM = 0
Cross:    W = wallet − Σ(isolated) iso_balance
          TU / TM = Σ uPnL / Σ MM of the OTHER cross positions
LP ≤ 0 means no liquidation price.
```

**Balances:**
```
BaseBalance   = wallet − Σ order cost − Σ(isolated) iso_balance
Available     = BaseBalance − Σ(cross) IM + Σ(cross) uPnL
Withdrawable  = max(0, BaseBalance − max(Σ(cross) IM − Σ(cross) uPnL, Σ(cross) MM))
MarginBalance = wallet − Σ(isolated) iso_balance + Σ(cross) uPnL     (cross margin balance)
Margin ratio  = MM / MarginBalance of the profile (liquidation at ≥ 100%)
```

**Order cost** (per symbol, pending/open LIMIT + MARKET orders):
```
f = max(bid, ask − 2 × notional)   long or flat
f = max(ask, bid − 2 × notional)   short
cost = f / symbolLeverage   (+ opening-fee reserve for isolated symbols)
```

**Fees and funding:**
```
commission  = round(notional × rate, quote_prec)   (rate: fee tier, maker override, discounts)
builder fee = floor(notional × bps / 10000, 2 decimals)
funding     = −size × mark × hourlyRate     (hourly at HH:00 UTC; positive rate: longs pay)
```

## Builder Codes API Flow

### Connect (public, no auth headers)
1. Generate a fresh Ed25519 keypair client-side
2. `POST /auth/builder/request-signature` `{address, chain, code, fee_share_bps, public_key, referral_code?}`
   -> `{nonce, message_to_sign, message, referral_code?}` (unknown fields are rejected; challenge valid 5 min)
3. User signs `message_to_sign` with their wallet (Cardano: CIP-30 signData over the hex-encoded message)
4. `POST /auth/builder/verify-signature` `{nonce, wallet_signature}`
   -> `{account_id, builder_code, fee_share_bps, api_wallet_id, api_wallet_public_key, api_wallet_expired_at, referral, ...}`

### Deposit (API wallet auth)
1. `POST /v2/deposit/quote` `{blockchain, asset_symbol, asset_amount}` -> `{request_id, quote, signature, deposit_address, confirmations_required}`
2. `POST /v2/deposit/build-tx` `{request_id, user_address, utxos?}` (utxos required on Cardano)
   -> `{blockchain, unsigned_tx, format, expires_at?, approval_tx?}` (`evm_tx_params` / `solana_base64` / `cardano_cbor`)
3. User signs + submits on-chain
4. `POST /v2/deposit` `{request_id, tx_hash}` -> `{request_id, status: "pending", tx_hash, message}`

### Withdraw (API wallet auth)
1. Optional: `POST /v2/withdraw/estimate` — price preview, no quote created
2. `POST /v2/withdraw/quote` `{usd_value, blockchain, asset, wallet_address?, source?, recipient_address?}` (send the signing wallet as `wallet_address`)
   -> `{withdraw_id, fee, message_to_sign, tx_cbor?, validator_address?, route?, ...}`
3. User signs `message_to_sign` (already hex for Cardano wallets) and, when present, `tx_cbor` (CIP-30 `signTx`)
4. `POST /v2/withdraw` `{withdraw_id, wallet_signature, signed_tx_cbor?}` -> 201 `{request_id, status: "pending", sequence_id, message_id}`

### Trade (API wallet auth; async — results arrive on the user stream)
```
POST   /v2/order              place order (201, status "pending")
POST   /v2/order/strategy     primary order + tp_order / sl_order
POST   /v2/order/replace      cancel + create (ignores X-Builder-Fee-Bps)
DELETE /v2/order/cancel       cancel by order_id or client_order_id (JSON body)
DELETE /v2/order/cancel-all   JSON body required ({} or {"symbol"})
POST   /v2/leverage           {symbol, leverage}
POST   /v2/marginMode         {symbol, marginMode}
GET    /v2/symbols            effective margin mode + leverage per market
```
