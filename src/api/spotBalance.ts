/**
 * Read the connected wallet's native-asset balance so the hedge sizer uses
 * what the user actually holds instead of a typed number.
 *   ethereum → eth_getBalance via the injected provider (ETH)
 *   solana   → getBalance via public RPC (SOL)
 *   cardano  → CIP-30 getBalance (CBOR Value → lovelace) (ADA)
 */

import type { ConnectedWallet } from "./wallets";

// Solana's official RPC returns 403 to browser origins; try CORS-friendly public endpoints in order.
// "/rpc/solana" is a same-origin proxy (vite.config.ts in dev, vercel.json in production) - browsers block most public Solana RPCs.
export const SOLANA_RPCS = ["/rpc/solana", "https://solana-rpc.publicnode.com", "https://solana.drpc.org", "https://api.mainnet-beta.solana.com"];
export const SOLANA_RPC = SOLANA_RPCS[0];

/** JSON-RPC call with endpoint fallback; throws with every endpoint's failure if all fail. */
export async function solanaRpc<T = any>(method: string, params: unknown[]): Promise<T> {
  const errors: string[] = [];
  for (const url of SOLANA_RPCS) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (!res.ok) { errors.push(`${url.startsWith("/") ? url : new URL(url).host} ${res.status}`); continue; }
      const j = await res.json();
      if (j.error) { errors.push(`${url.startsWith("/") ? url : new URL(url).host} ${j.error.message}`); continue; }
      return j.result as T;
    } catch (e: any) { errors.push(`${url.startsWith("/") ? url : new URL(url).host} ${e?.message ?? "network"}`); }
  }
  throw new Error(`Solana RPC unavailable (${errors.join("; ")})`);
}

export interface SpotBalance { asset: string; qty: number; source: string }

const NATIVE: Record<ConnectedWallet["chain"], string> = { ethereum: "ETH", solana: "SOL", cardano: "ADA" };

export const nativeAssetFor = (chain: ConnectedWallet["chain"]) => NATIVE[chain];

/** Minimal CBOR reader: returns the coin from a CIP-30 Value (uint, or [coin, multiasset]). */
export function lovelaceFromCborValue(hex: string): number {
  const b = Uint8Array.from(hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  let i = 0;
  const readUint = (): number => {
    const ib = b[i++], major = ib >> 5, info = ib & 0x1f;
    if (major !== 0) throw new Error(`expected uint, got major ${major}`);
    if (info < 24) return info;
    const len = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 8;
    let v = 0n;
    for (let k = 0; k < len; k++) v = (v << 8n) | BigInt(b[i++]);
    return Number(v);
  };
  const major = b[0] >> 5;
  if (major === 4) { i = 1; return readUint(); } // array: first element is the coin
  return readUint();
}

export async function getSpotBalance(w: ConnectedWallet): Promise<SpotBalance> {
  switch (w.chain) {
    case "ethereum": {
      const hex: string = await w.api.request({ method: "eth_getBalance", params: [w.address, "latest"] });
      return { asset: "ETH", qty: Number(BigInt(hex)) / 1e18, source: `${w.walletId} eth_getBalance` };
    }
    case "solana": {
      const r = await solanaRpc<{ value: number }>("getBalance", [w.address]);
      return { asset: "SOL", qty: Number(r?.value ?? 0) / 1e9, source: "solana rpc getBalance" };
    }
    case "cardano": {
      const cbor: string = await w.api.getBalance();
      return { asset: "ADA", qty: lovelaceFromCborValue(cbor) / 1e6, source: `${w.walletId} CIP-30 getBalance` };
    }
  }
}
