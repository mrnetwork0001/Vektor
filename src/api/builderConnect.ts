/**
 * Builder Connect Flow (2 public calls, no auth headers):
 *
 * 1. POST /auth/builder/request-signature
 *    - Send: address, chain, code, fee_share_bps (required, 0..100), public_key,
 *      optional referral_code (must belong to the builder-code owner).
 *      Body is decoded strictly: unknown fields are rejected with 400.
 *    - Receive: nonce, message_to_sign (also mirrored as "message"),
 *      referral_code (only when one was bound). Challenge expires in 5 minutes.
 *
 * 2. POST /auth/builder/verify-signature
 *    - Send: nonce, wallet_signature (the challenge carries address/chain)
 *    - Receive: account_id, builder_code, fee_share_bps, api_wallet_id,
 *      api_wallet_public_key, api_wallet_expired_at, referral, ...
 *
 * Wallet signature over message_to_sign (plain text):
 *   ethereum: EIP-191 personal_sign, hex (0x optional); ERC-1271 contract wallets supported
 *   solana:   Ed25519 over the UTF-8 bytes, base58 signature
 *   cardano:  CIP-30 signData over hex(UTF-8 message) → "coseSign1Hex:coseKeyHex"
 *             (or JSON {"signature","key"}); address must be bech32
 *
 * On success the backend creates the account if needed, revokes any previous
 * API wallets for this account + builder code, creates the new API wallet, and
 * approves the builder with the signed fee cap.
 */

import { API_BASE_URL } from "./config";
import type { BuilderConnectResult } from "../types/account";

export type ConnectChain = "ethereum" | "solana" | "cardano";

export interface RequestSignatureParams {
  address: string;
  chain: ConnectChain;
  publicKey: string; // 64 hex chars (Ed25519)
  builderCode: string; // your builder code
  feeShareBps: number; // user's approved max builder fee, 0..100 bps (required)
  referralCode?: string; // optional, must be the builder owner's referral code
}

export interface RequestSignatureResult {
  nonce: string;
  message_to_sign: string;
  message: string; // same as message_to_sign
  referral_code?: string;
}

/**
 * Step 1: Request a signature challenge.
 *
 * @example
 *   const { nonce, message_to_sign } = await requestSignature({
 *     address: "addr1qx2fxv2...",
 *     chain: "cardano",
 *     publicKey: "a1b2c3d4...",
 *     builderCode: "mybuilder",
 *     feeShareBps: 10,
 *   });
 *   // User signs message_to_sign with their wallet
 */
export async function requestSignature(
  params: RequestSignatureParams
): Promise<RequestSignatureResult> {
  const body: Record<string, unknown> = {
    address: params.address,
    chain: params.chain,
    code: params.builderCode,
    fee_share_bps: params.feeShareBps,
    public_key: params.publicKey,
  };
  if (params.referralCode) body.referral_code = params.referralCode;

  const res = await fetch(`${API_BASE_URL}/auth/builder/request-signature`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Request signature failed: ${res.status}`);
  }

  return res.json();
}

export interface VerifySignatureParams {
  nonce: string;
  walletSignature: string;
}

/**
 * Step 2: Verify the wallet signature and complete the connect flow.
 *
 * @example
 *   const result = await verifySignature({
 *     nonce: "019d4a2b-...",
 *     walletSignature: "845846a2...:a401012006...",
 *   });
 *   // result.account_id = "a1b2c3d4-..."
 *   // result.api_wallet_public_key === the publicKey sent in step 1
 */
export async function verifySignature(
  params: VerifySignatureParams
): Promise<BuilderConnectResult> {
  const res = await fetch(`${API_BASE_URL}/auth/builder/verify-signature`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nonce: params.nonce,
      wallet_signature: params.walletSignature,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Verify signature failed: ${res.status}`);
  }

  return res.json();
}
