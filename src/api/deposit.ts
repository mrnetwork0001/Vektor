/**
 * Deposit Flow (3 steps):
 *
 * 1. POST /v2/deposit/quote      - Quote with USD value and Strike's vault address
 * 2. POST /v2/deposit/build-tx   - Unsigned transaction for the user's wallet
 *    (user signs + submits on-chain)
 * 3. POST /v2/deposit            - Confirm with the on-chain tx hash
 *
 * All steps require API wallet authentication (master account only - an API
 * wallet bound to a sub-account gets 403 "not available to sub-account API keys").
 * Errors: { "error": "..." }.
 */

import { API_BASE_URL } from "./config";
import { authenticatedFetch, throwApiError } from "./auth";

export type DepositChain = "ethereum" | "solana" | "cardano";

// ── Step 1: Get Deposit Quote ──

export interface DepositQuoteParams {
  blockchain: DepositChain;
  asset_symbol: string; // must be configured for the chain (e.g. "USDC" on solana)
  asset_amount: string; // integer string in the asset's smallest unit (lamports, lovelace, wei, 1e-6 USDC)
  mode?: "balance" | "collateral"; // default "balance"
}

export interface DepositQuote {
  account_id: string;
  request_id: string;
  blockchain: string;
  asset_symbol: string;
  asset_amount: string;
  usd_value: string;
  exchange_rate: string;
  confirmations: number;
  timestamp: number; // unix ms
  expiration_at: number; // unix ms
}

export interface DepositQuoteResponse {
  request_id: string;
  quote: DepositQuote;
  signature: string; // Strike's signature over the quote
  deposit_address: string; // Strike's vault address (server config, not caller-specified)
  confirmations_required: number;
}

/**
 * Step 1: Get a deposit quote.
 *
 * @example
 *   const quote = await getDepositQuote({
 *     blockchain: "solana",
 *     asset_symbol: "USDC",
 *     asset_amount: "1000000000",  // 1000 USDC (6 decimals)
 *   });
 *   // quote.request_id = "abc-123"
 *   // quote.quote.usd_value = "1000"
 */
export async function getDepositQuote(
  params: DepositQuoteParams
): Promise<DepositQuoteResponse> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/deposit/quote`, "POST", params);
  if (!res.ok) return throwApiError(res, "Deposit quote failed");
  return res.json();
}

// ── Step 2: Build Unsigned Transaction ──

export interface BuildTxParams {
  request_id: string; // from quote response
  user_address: string; // must be the account's registered wallet on the quote's chain (else 403)
  utxos?: string[]; // REQUIRED for Cardano: CIP-30 getUtxos() hex CBOR strings
}

export interface EvmTxParams {
  from: string;
  to: string;
  data: string; // 0x calldata
  value: string; // 0x hex wei
  gas: string; // 0x hex
}

export interface BuildTxResponseEVM {
  blockchain: "ethereum";
  unsigned_tx: EvmTxParams; // pass to eth_sendTransaction
  format: "evm_tx_params";
  // Present when the ERC-20 allowance is insufficient: send this approve() first.
  approval_tx?: EvmTxParams;
}

export interface BuildTxResponseSolana {
  blockchain: "solana";
  unsigned_tx: string; // base64-encoded transaction (user is fee payer)
  format: "solana_base64";
  expires_at: number; // unix SECONDS (~60s, blockhash lifetime)
}

export interface BuildTxResponseCardano {
  blockchain: "cardano";
  unsigned_tx: string; // CBOR hex - sign with CIP-30 signTx, then submit
  format: "cardano_cbor";
  expires_at: number; // unix ms (tx validity upper bound)
}

export type BuildTxResponse =
  | BuildTxResponseEVM
  | BuildTxResponseSolana
  | BuildTxResponseCardano;

/**
 * Step 2: Build an unsigned transaction.
 * The user's wallet signs this, then submits it to the blockchain.
 *
 * @example
 *   const tx = await buildDepositTx({
 *     request_id: "abc-123",
 *     user_address: "9WzDXwBhzVFT...",
 *   });
 *   if (tx.format === "evm_tx_params") {
 *     if (tx.approval_tx) await provider.request({ method: "eth_sendTransaction", params: [tx.approval_tx] });
 *     const txHash = await provider.request({ method: "eth_sendTransaction", params: [tx.unsigned_tx] });
 *   }
 */
export async function buildDepositTx(params: BuildTxParams): Promise<BuildTxResponse> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/deposit/build-tx`, "POST", params);
  if (!res.ok) return throwApiError(res, "Build TX failed");
  return res.json();
}

// ── Step 3: Confirm Deposit ──

export interface DepositConfirmParams {
  request_id: string;
  tx_hash: string; // on-chain transaction hash (≥ 10 chars)
}

export interface DepositConfirmResponse {
  request_id: string;
  status: "pending";
  tx_hash: string;
  message: string;
}

/**
 * Step 3: Confirm the deposit with the on-chain tx hash.
 * The backend then watches the chain and credits the account after the
 * required confirmations (ACCOUNT_UPDATE on the user stream). A 409 means the
 * quote was already submitted; that error body also carries the stored tx_hash.
 *
 * @example
 *   const result = await confirmDeposit({ request_id: "abc-123", tx_hash: "5abc123def..." });
 *   // result.status = "pending"
 */
export async function confirmDeposit(
  params: DepositConfirmParams
): Promise<DepositConfirmResponse> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/deposit`, "POST", params);
  if (!res.ok) return throwApiError(res, "Deposit confirm failed");
  return res.json();
}
