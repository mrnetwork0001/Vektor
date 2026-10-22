// ── API Configuration ──
// Defaults to testnet (api-v2-testnet.strikefinance.org).
// Mainnet uses the same paths on api.strikefinance.org.

// Main API (/v2/..., /auth/...) - trading, account, orders, deposits, withdrawals.
// Must be an ORIGIN only (no path prefix): API wallet signatures cover the
// request path exactly as the server sees it.
export const API_BASE_URL =
  import.meta.env.VITE_API_URL ?? "https://api-v2-testnet.strikefinance.org";

// Price service REST (/price/v2/depth, /price/v2/markPrice, /price/v2/klines, ...)
export const PRICE_API_URL =
  import.meta.env.VITE_PRICE_URL ?? "https://api-v2-testnet.strikefinance.org/price";

// Public price WebSocket (markPrice, depth, bookTicker, trade, kline, miniTicker)
export const PRICE_WS_URL =
  import.meta.env.VITE_PRICE_WS_URL ?? "wss://api-v2-testnet.strikefinance.org/ws/price";

// User WebSocket for API wallets (session.logon auth) - builders/bots use this.
// wss://<host>/ws/user is the JWT endpoint for the Strike app - do NOT use it.
export const USER_WS_URL =
  import.meta.env.VITE_USER_WS_URL ?? "wss://api-v2-testnet.strikefinance.org/ws/user-api";

// Stats service (e.g. /stat/v1/stats/leaderboard, /stat/v1/dashboard/summary)
export const STATS_API_URL =
  import.meta.env.VITE_STATS_URL ?? "https://api-v2-testnet.strikefinance.org/stat";

// Builder code for your integration
export const BUILDER_CODE =
  import.meta.env.VITE_BUILDER_CODE ?? "your-builder-code";

// Builder fee in basis points (100 = 1%).
// - Requested as the user's approval cap (fee_share_bps) during builder connect.
// - Sent per order as X-Builder-Fee-Bps. Must be ≤ the user's approved cap and
//   ≤ your builder's registered fee_share_bps (deployment max 100). 0 = no fee.
export const BUILDER_FEE_BPS = Number(import.meta.env.VITE_BUILDER_FEE_BPS ?? "0");
