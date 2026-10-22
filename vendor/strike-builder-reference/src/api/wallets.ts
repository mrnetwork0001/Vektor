/**
 * Wallet extension detection, connection, and signing for all chains.
 *
 * Cardano: CIP-30 wallets (Gero, Eternl, Nami, Vespr, Lace, etc.)
 * Solana:  Phantom, Solflare
 * EVM:     MetaMask, Rabby, Brave, Phantom, Coinbase
 *
 * What the backend verifies (services/api/auth/*.go):
 *   ethereum: EIP-191 personal_sign over the message text; hex signature
 *             (0x optional). EOAs and ERC-1271 contract wallets.
 *   solana:   Ed25519 over the UTF-8 message bytes; base58 address (32 bytes)
 *             and base58 signature (64 bytes).
 *   cardano:  CIP-30 signData (COSE_Sign1) sent as "coseSign1Hex:coseKeyHex"
 *             (or JSON {"signature","key"}). The address MUST be bech32
 *             (addr1... / addr_test1...). The payload is hex: plain-text
 *             challenges (builder connect) are hex-encoded by the client,
 *             while withdraw message_to_sign is already hex for Cardano.
 */

import { API_BASE_URL } from "./config";

// ── Types ──

export type SupportedChain = "cardano" | "solana" | "ethereum";

export interface WalletInfo {
  id: string;
  name: string;
  chain: SupportedChain;
  icon?: string;
  installed: boolean;
}

export interface ConnectedWallet {
  chain: SupportedChain;
  walletId: string;
  address: string;
  api: any; // chain-specific wallet API
}

// ── Wallet detection ──

/**
 * Detect all installed wallet extensions across all chains.
 * Returns a flat list sorted by chain.
 */
export function detectInstalledWallets(): WalletInfo[] {
  const wallets: WalletInfo[] = [];

  console.log("[Wallet] Detecting wallets...");
  console.log("[Wallet] window.cardano keys:", Object.keys((window as any).cardano || {}));
  console.log("[Wallet] window.phantom:", !!(window as any).phantom);
  console.log("[Wallet] window.ethereum:", !!(window as any).ethereum);

  // Cardano CIP-30 wallets
  const cardanoIds = [
    "eternl",
    "lace",
    "nami",
    "gerowallet",
    "vespr",
    "yoroi",
    "tokeo",
    "nufi",
    "begin",
    "ctrl",
    "okxwallet",
  ];
  for (const id of cardanoIds) {
    const ns = (window as any).cardano?.[id];
    if (ns?.enable) {
      wallets.push({
        id,
        name: ns.name || id,
        chain: "cardano",
        icon: ns.icon,
        installed: true,
      });
    }
  }

  // Solana wallets
  if ((window as any).phantom?.solana) {
    wallets.push({
      id: "phantom",
      name: "Phantom",
      chain: "solana",
      installed: true,
    });
  }
  if ((window as any).solflare) {
    wallets.push({
      id: "solflare",
      name: "Solflare",
      chain: "solana",
      installed: true,
    });
  }

  // EVM wallets
  const eth = (window as any).ethereum;
  if (eth) {
    // Check for specific wallets in providers array
    const providers: any[] = eth.providers || [eth];

    for (const p of providers) {
      if (p.isMetaMask && !p.isBraveWallet && !p.isRabby && !p.isCoinbaseWallet) {
        if (!wallets.find((w) => w.id === "metamask"))
          wallets.push({ id: "metamask", name: "MetaMask", chain: "ethereum", installed: true });
      }
      if (p.isRabby) {
        if (!wallets.find((w) => w.id === "rabby"))
          wallets.push({ id: "rabby", name: "Rabby", chain: "ethereum", installed: true });
      }
      if (p.isCoinbaseWallet) {
        if (!wallets.find((w) => w.id === "coinbase"))
          wallets.push({ id: "coinbase", name: "Coinbase", chain: "ethereum", installed: true });
      }
    }

    // Phantom EVM
    if ((window as any).phantom?.ethereum) {
      if (!wallets.find((w) => w.id === "phantom-evm"))
        wallets.push({ id: "phantom-evm", name: "Phantom (EVM)", chain: "ethereum", installed: true });
    }

    // Brave wallet
    if (eth.isBraveWallet) {
      if (!wallets.find((w) => w.id === "brave"))
        wallets.push({ id: "brave", name: "Brave", chain: "ethereum", installed: true });
    }

    // Fallback: if ethereum exists but no specific wallet matched
    if (wallets.filter((w) => w.chain === "ethereum").length === 0) {
      wallets.push({ id: "injected", name: "Browser Wallet", chain: "ethereum", installed: true });
    }
  }

  return wallets;
}

// ── Cardano Connection ──

/**
 * Connect a Cardano CIP-30 wallet.
 *
 * @example
 *   const wallet = await connectCardano("gerowallet");
 *   // wallet.address = "addr1qx2fxv2..."
 *   // wallet.api = CIP-30 API with signData, getChangeAddress, etc.
 */
export async function connectCardano(walletId: string): Promise<ConnectedWallet> {
  console.log("[Wallet] Connecting Cardano wallet:", walletId);
  const ns = (window as any).cardano?.[walletId];
  if (!ns?.enable) {
    console.error("[Wallet] window.cardano." + walletId + " not found. Available:", Object.keys((window as any).cardano || {}));
    throw new Error(`${walletId} wallet not found. Please install the extension.`);
  }

  console.log("[Wallet] Calling enable()...");
  const api = await ns.enable();
  if (!api?.getChangeAddress) {
    throw new Error("Wallet API incomplete — missing getChangeAddress");
  }

  const addressHex = await api.getChangeAddress();
  const networkId = await api.getNetworkId();
  console.log("[Wallet] addressHex:", addressHex);
  console.log("[Wallet] networkId:", networkId);

  // The backend decodes Cardano addresses as bech32 only.
  const address = encodeCardanoAddress(addressHex, networkId);
  console.log("[Wallet] bech32 address:", address);

  // Network check: testnet (preprod) = 0, mainnet = 1
  const isTestnet = API_BASE_URL.includes("testnet");
  console.log("[Wallet] isTestnet:", isTestnet, "networkId:", networkId);
  if (isTestnet && networkId !== 0) {
    throw new Error("Please switch your wallet to Preprod/Testnet network");
  } else if (!isTestnet && networkId !== 1) {
    throw new Error("Please switch your wallet to Mainnet network");
  }

  return { chain: "cardano", walletId, address, api };
}

/**
 * Sign a message with a Cardano CIP-30 wallet (signData).
 * Returns signature in "coseSign1Hex:coseKeyHex" format.
 *
 * @param message      - text to sign
 * @param payloadIsHex - true when `message` is ALREADY hex (Cardano withdraw
 *                       message_to_sign); false for plain text (builder connect),
 *                       which is hex-encoded here exactly like the backend does.
 *
 * @example
 *   const sig = await signCardano(api, "addr1...", "Connect to Strike...");
 *   // sig = "845846a201....:a401012006..."
 */
export async function signCardano(
  api: any,
  address: string,
  message: string,
  payloadIsHex: boolean = false
): Promise<string> {
  if (!api.signData) {
    throw new Error("Wallet does not support CIP-30 signData");
  }

  // CIP-30 signData takes the address as hex bytes
  const signAddress = cardanoAddressToHex(address);
  const payloadHex = payloadIsHex ? message : stringToHex(message);

  const { signature, key } = await api.signData(signAddress, payloadHex);
  return `${signature}:${key}`;
}

/** CIP-30 getUtxos() — hex CBOR UTxOs, required by POST /v2/deposit/build-tx on Cardano. */
export async function getCardanoUtxos(api: any): Promise<string[]> {
  const utxos = await api.getUtxos();
  if (!Array.isArray(utxos) || utxos.length === 0) {
    throw new Error("Cardano wallet returned no UTxOs");
  }
  return utxos;
}

/**
 * CIP-30 signTx(txCbor, partialSign=true) — used for the Cardano withdraw
 * funding tx (quote.tx_cbor). Send the result as signed_tx_cbor to
 * POST /v2/withdraw; the backend submits it (do not submit it yourself).
 */
export async function signCardanoTx(api: any, txCbor: string): Promise<string> {
  if (!api.signTx) throw new Error("Wallet does not support CIP-30 signTx");
  return api.signTx(txCbor, true);
}

// ── Solana Connection ──

/**
 * Connect a Solana wallet (Phantom, Solflare).
 *
 * @example
 *   const wallet = await connectSolana("phantom");
 *   // wallet.address = "9WzDXwBhzVFT..."
 */
export async function connectSolana(walletId: string): Promise<ConnectedWallet> {
  let provider: any;

  switch (walletId) {
    case "phantom":
      provider = (window as any).phantom?.solana || (window as any).solana;
      break;
    case "solflare":
      provider = (window as any).solflare;
      break;
    default:
      provider = (window as any).solana;
  }

  if (!provider) {
    throw new Error(`${walletId} wallet not found. Please install the extension.`);
  }

  const resp = await provider.connect();
  // Phantom returns { publicKey }; Solflare sets provider.publicKey
  const publicKey = resp?.publicKey ?? provider.publicKey;
  if (!publicKey) throw new Error("Solana wallet did not return a public key");
  const address = publicKey.toString(); // base58

  return { chain: "solana", walletId, address, api: provider };
}

/**
 * Sign a message with a Solana wallet.
 * Returns base58-encoded signature.
 *
 * @example
 *   const sig = await signSolana(provider, "Connect to Strike...");
 *   // sig = "5Kd8Cj..." (base58)
 */
export async function signSolana(api: any, message: string): Promise<string> {
  if (!api.signMessage) {
    throw new Error("Wallet does not support signMessage");
  }

  const encoded = new TextEncoder().encode(message);
  const result = await api.signMessage(encoded, "utf8");

  // Extract signature bytes — different wallets return different formats
  let sigBytes: Uint8Array;
  if (result instanceof Uint8Array) {
    sigBytes = result;
  } else if (result?.signature instanceof Uint8Array) {
    sigBytes = result.signature;
  } else if (result?.signature) {
    sigBytes = new Uint8Array(Object.values(result.signature));
  } else if (typeof result === "object" && result.length) {
    sigBytes = new Uint8Array(result);
  } else {
    // Already a string (base58)
    return String(result);
  }

  return base58Encode(sigBytes);
}

// ── EVM Connection ──

/**
 * Connect an EVM wallet (MetaMask, Rabby, etc.).
 *
 * @example
 *   const wallet = await connectEvm("metamask");
 *   // wallet.address = "0x742d35Cc6634C0532925a3b844Bc9e7595f..."
 */
export async function connectEvm(walletId: string): Promise<ConnectedWallet> {
  let provider: any;

  const eth = (window as any).ethereum;
  if (!eth) throw new Error("No Ethereum provider found. Please install a wallet.");

  const providers: any[] = eth.providers || [eth];

  switch (walletId) {
    case "metamask":
      provider = providers.find(
        (p) => p.isMetaMask && !p.isBraveWallet && !p.isRabby && !p.isCoinbaseWallet
      ) || eth;
      break;
    case "rabby":
      provider = providers.find((p) => p.isRabby) || eth;
      break;
    case "coinbase":
      provider = providers.find((p) => p.isCoinbaseWallet) || (window as any).coinbaseWalletExtension || eth;
      break;
    case "phantom-evm":
      provider = (window as any).phantom?.ethereum || eth;
      break;
    case "brave":
      provider = providers.find((p) => p.isBraveWallet) || eth;
      break;
    default:
      provider = eth;
  }

  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!accounts?.length) throw new Error("No accounts returned from wallet");

  return {
    chain: "ethereum",
    walletId,
    address: accounts[0],
    api: provider,
  };
}

/**
 * Sign a message with an EVM wallet (EIP-191 personal_sign).
 * Returns hex-encoded signature.
 *
 * @example
 *   const sig = await signEvm(provider, address, "Connect to Strike...");
 *   // sig = "0xabc123..."
 */
export async function signEvm(
  api: any,
  address: string,
  message: string
): Promise<string> {
  if (!api?.request) {
    throw new Error("Wallet does not support request method");
  }

  const signature = await api.request({
    method: "personal_sign",
    params: [message, address],
  });

  return signature;
}

// ── Unified connect + sign ──

/**
 * Connect any wallet by chain and walletId.
 */
export async function connectWallet(
  chain: SupportedChain,
  walletId: string
): Promise<ConnectedWallet> {
  switch (chain) {
    case "cardano":
      return connectCardano(walletId);
    case "solana":
      return connectSolana(walletId);
    case "ethereum":
      return connectEvm(walletId);
  }
}

/**
 * Sign a message with any connected wallet.
 *
 * @param cardanoPayloadIsHex - pass true for withdraw message_to_sign on
 *   Cardano (already hex-encoded by the backend). Ignored for other chains.
 */
export async function signMessage(
  wallet: ConnectedWallet,
  message: string,
  cardanoPayloadIsHex: boolean = false
): Promise<string> {
  switch (wallet.chain) {
    case "cardano":
      return signCardano(wallet.api, wallet.address, message, cardanoPayloadIsHex);
    case "solana":
      return signSolana(wallet.api, message);
    case "ethereum":
      return signEvm(wallet.api, wallet.address, message);
  }
}

// ── Helpers ──

/**
 * Encode a CIP-30 hex address as bech32 ("addr" mainnet / "addr_test" testnet).
 * Shelley base/enterprise addresses only (stake addresses use "stake").
 */
function encodeCardanoAddress(hex: string, networkId: number): string {
  const bytes = hexToBytes(hex);
  const prefix = networkId === 1 ? "addr" : "addr_test";
  return bech32Encode(prefix, bytes);
}

/** Convert bech32/hex Cardano address to hex bytes for signData */
function cardanoAddressToHex(address: string): string {
  if (address.startsWith("addr") || address.startsWith("addr_test")) {
    try {
      const decoded = bech32Decode(address);
      return bytesToHex(decoded);
    } catch {
      return address;
    }
  }
  return address.replace(/^0x/i, "").toLowerCase();
}

function stringToHex(str: string): string {
  return Array.from(new TextEncoder().encode(str))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Minimal bech32 encode/decode ──
// (Just enough for Cardano address handling without external deps)

const BECH32_ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

function bech32CreateChecksum(hrp: string, data: number[], isBech32m: boolean): number[] {
  const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const CONST = isBech32m ? 0x2bc830a3 : 1;
  const polymod = bech32Polymod(values) ^ CONST;
  const ret: number[] = [];
  for (let i = 0; i < 6; i++) ret.push((polymod >> (5 * (5 - i))) & 31);
  return ret;
}

function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  return ret;
}

function bech32Encode(hrp: string, data: Uint8Array): string {
  // Cardano uses bech32 (not bech32m) for Shelley addresses
  const isBech32m = false;
  const words = convertBits(data, 8, 5, true);
  const checksum = bech32CreateChecksum(hrp, words, isBech32m);
  const combined = words.concat(checksum);
  let ret = hrp + "1";
  for (const w of combined) ret += BECH32_ALPHABET[w];
  return ret;
}

function bech32Decode(str: string): Uint8Array {
  const pos = str.lastIndexOf("1");
  if (pos < 1) throw new Error("Invalid bech32 string");
  const data: number[] = [];
  for (let i = pos + 1; i < str.length; i++) {
    const idx = BECH32_ALPHABET.indexOf(str[i]);
    if (idx === -1) throw new Error("Invalid bech32 character");
    data.push(idx);
  }
  // Strip 6-byte checksum
  const words = data.slice(0, -6);
  const result = convertBits(new Uint8Array(words), 5, 8, false);
  return new Uint8Array(result);
}

// ── Minimal Base58 encode ──

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  // Count leading zeros
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Convert to base58
  const b58 = new Uint8Array(bytes.length * 2);
  let length = 0;

  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    let j = 0;
    for (let k = b58.length - 1; k >= 0; k--, j++) {
      if (carry === 0 && j >= length) break;
      carry += 256 * b58[k];
      b58[k] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    length = j;
  }

  // Skip leading zeros in base58 result
  let start = b58.length - length;
  while (start < b58.length && b58[start] === 0) start++;

  let result = "1".repeat(zeros);
  for (let i = start; i < b58.length; i++) {
    result += BASE58_ALPHABET[b58[i]];
  }

  return result;
}
