/**
 * Withdrawal Flow:
 *
 * 0. POST /v2/withdraw/estimate (optional) - side-effect-free price preview
 * 1. POST /v2/withdraw/quote               - withdraw_id, fee, message_to_sign
 *                                            (+ tx_cbor for Cardano-wallet Cardano withdrawals)
 * 2. User signs message_to_sign (and tx_cbor when present) with the wallet
 * 3. POST /v2/withdraw                     - confirm with wallet_signature (+ signed_tx_cbor)
 *
 * Destination: by default the signing wallet (wallet_address) on `blockchain`.
 * An optional recipient_address is canonicalized and written into the signed
 * message ("Recipient: ..."), so the wallet owner approves it explicitly.
 *
 * All calls require API wallet auth and are master-account only
 * (sub-account API wallets get 403). Errors: { "error": "...", "code"?: "...",
 * "minimum_usd"?: n } — e.g. code "below_minimum", "insufficient_balance".
 */

import { API_BASE_URL } from "./config";
import { authenticatedFetch } from "./auth";

export type WithdrawChain = "ethereum" | "solana" | "cardano";

async function throwWithdrawError(res: Response, fallback: string): Promise<never> {
  const err = await res.json().catch(() => ({}));
  const msg = err?.error || `${fallback}: ${res.status}`;
  const extra = err?.minimum_usd ? ` (minimum $${err.minimum_usd})` : "";
  throw new Error(msg + extra);
}

// ── Estimate (optional) ──

export interface WithdrawEstimateParams {
  usd_value: string;
  blockchain: string;
  asset?: string;
  source?: "balance" | "staking_reward";
  recipient_address?: string;
}

export interface WithdrawEstimateResponse {
  route: string;
  is_relay: boolean;
  source_blockchain: string;
  source_asset: string;
  source_amount: string; // base units
  source_asset_decimals: number;
  destination_blockchain: string;
  destination_asset: string;
  destination_asset_decimals: number;
  estimated_receive: string; // base units
  estimated_receive_usd: string;
  minimum_receive: string;
  withdraw_fee_usd: string;
  network_cost_usd: string;
  price_impact_percent: string;
  slippage_bps: number;
  eta_seconds: number;
  as_of: number;
  ttl_seconds: number;
}

/** Price preview: creates no quote and needs no signature. Rate-limited per account. */
export async function estimateWithdraw(
  params: WithdrawEstimateParams
): Promise<WithdrawEstimateResponse> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/withdraw/estimate`, "POST", params);
  if (!res.ok) return throwWithdrawError(res, "Withdraw estimate failed");
  return res.json();
}

// ── Step 1: Get Withdraw Quote ──

export interface WithdrawQuoteParams {
  usd_value: string; // USD amount to debit (fee included), ≥ the deployment minimum
  blockchain: WithdrawChain; // destination chain
  // Destination asset. Required for Cardano (e.g. "USDM", "ADA"). "USDC" on
  // solana/ethereum uses the direct vault route; other assets/chains are
  // routed via Relay from USDC.
  asset: string;
  source?: "balance" | "staking_reward"; // default "balance"
  // The signing wallet (the account's registered address on `blockchain`).
  // Send it: without it the quote only works when the account has exactly one
  // wallet on that chain (else 403), and Cardano addresses that share a payment
  // credential but differ in stake credential must match the CIP-30 signer exactly.
  wallet_address?: string;
  recipient_address?: string; // optional destination override (shown in message_to_sign)
}

export interface WithdrawQuoteResponse {
  withdraw_id: string;
  fee: string; // withdrawal fee in USD
  // Plain text for Ethereum/Solana wallets. For Cardano wallets this is ALREADY
  // hex-encoded: pass it to CIP-30 signData as-is (do not hex-encode again).
  message_to_sign: string;
  tx_cbor?: string; // Cardano-wallet Cardano withdrawals: unsigned min-ADA funding tx
  validator_address?: string; // set with tx_cbor; informational
  route?: string;
  source_blockchain?: string;
  source_asset?: string;
  source_amount?: string;
  destination_asset?: string;
  estimated_receive?: string;
  minimum_receive?: string;
}

/**
 * Step 1: Get a withdrawal quote.
 *
 * @example
 *   const quote = await getWithdrawQuote({ usd_value: "500", blockchain: "solana", asset: "USDC" });
 *   // quote.message_to_sign = "Authorize withdrawal from Strike Perpetuals.\n\nWallet: ...\nChain: solana\n
 *   //   Amount: 500 USD\nFee: 1 USD\nTimestamp: 2026-04-01 12:00:00 UTC\nWithdraw ID: ..."
 */
export async function getWithdrawQuote(
  params: WithdrawQuoteParams
): Promise<WithdrawQuoteResponse> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/withdraw/quote`, "POST", params);
  if (!res.ok) return throwWithdrawError(res, "Withdraw quote failed");
  return res.json();
}

// ── Step 2: Confirm Withdrawal ──

export interface WithdrawConfirmParams {
  withdraw_id: string;
  wallet_signature: string; // signature over message_to_sign
  signed_tx_cbor?: string; // REQUIRED when the quote returned tx_cbor (CIP-30 signTx(tx_cbor, true))
}

export interface WithdrawConfirmResponse {
  request_id: string; // = withdraw_id
  status: "pending";
  sequence_id: number;
  message_id: string;
}

/**
 * Step 2: Confirm the withdrawal (HTTP 201). Settlement is asynchronous; watch
 * ACCOUNT_UPDATE (WITHDRAWAL_SETTLED / WITHDRAWAL_FAILED) on the user stream.
 *
 * wallet_signature format by chain:
 *   ethereum: hex EIP-191 personal_sign
 *   solana:   base58 Ed25519 signature
 *   cardano:  CIP-30 "coseSign1Hex:coseKeyHex" (or JSON {"signature","key"})
 */
export async function confirmWithdraw(
  params: WithdrawConfirmParams
): Promise<WithdrawConfirmResponse> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/withdraw`, "POST", params);
  if (!res.ok) return throwWithdrawError(res, "Withdraw confirm failed");
  return res.json();
}
