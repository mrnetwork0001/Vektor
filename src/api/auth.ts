/**
 * API Wallet Authentication for Builder Codes.
 *
 * Every authenticated request carries 4 headers:
 *   X-API-Wallet-Public-Key: <64 hex chars, Ed25519 public key>
 *   X-API-Wallet-Signature:  <128 hex chars, Ed25519 signature of message>
 *   X-API-Wallet-Timestamp:  <unix SECONDS>
 *   X-API-Wallet-Nonce:      <16..128 chars, single use per key, e.g. a UUID>
 *
 * Optional (orders only, NOT signed): X-Builder-Fee-Bps: <0..100>
 *
 * Signature message format (services/api/middleware/api_wallet.go):
 *   {METHOD}:{PATH}:{TIMESTAMP}:{NONCE}:{BODY_HASH}
 *   - PATH is the URL path PLUS "?" + raw query when a query string exists,
 *     e.g. "/v2/positions?symbol=BTC-USD".
 *   - BODY_HASH is hex SHA-256 of the raw request body bytes. An empty body
 *     (GET) hashes to sha256("") = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".
 *   - TIMESTAMP must not be in the future and at most 3 minutes old. If the
 *     client clock drifts, compute an offset from GET /v2/time ({"serverTime": ms}).
 *
 * The Ed25519 keypair is generated client-side during the connect flow.
 * The private key signs all subsequent API requests.
 */

import * as ed from "@noble/ed25519";

// @noble/ed25519 v2 requires sha512 configured for sync operations.
import { sha512 } from "@noble/hashes/sha2.js";
if (ed.etc) {
  ed.etc.sha512Sync = (...m: Uint8Array[]) => {
    const h = sha512.create();
    for (const msg of m) h.update(msg);
    return h.digest();
  };
}

// ── Key Management ──

export interface ApiWalletKeys {
  publicKey: string; // 64 hex chars (lowercase)
  privateKey: string; // 64 hex chars
}

/**
 * Generate a new Ed25519 keypair for API wallet authentication.
 * Call this once during the builder connect flow.
 */
export function generateApiWalletKeys(): ApiWalletKeys {
  const privateKeyBytes = ed.utils.randomPrivateKey();
  const publicKeyBytes = ed.getPublicKey(privateKeyBytes);

  return {
    privateKey: bytesToHex(privateKeyBytes),
    publicKey: bytesToHex(publicKeyBytes),
  };
}

// ── In-memory key storage (no localStorage) ──

let _currentKeys: ApiWalletKeys | null = null;

export function storeApiWalletKeys(keys: ApiWalletKeys): void {
  _currentKeys = keys;
}

export function loadApiWalletKeys(): ApiWalletKeys | null {
  return _currentKeys;
}

export function clearApiWalletKeys(): void {
  _currentKeys = null;
}

// ── Request Signing ──

/**
 * Build the 4 authentication headers for an API request.
 *
 * @param method     - HTTP method (GET, POST, PUT, PATCH, DELETE)
 * @param path       - URL path including "?query" if any (e.g. "/v2/positions?symbol=BTC-USD")
 * @param body       - Exact request body string ("" when there is no body)
 * @param privateKey - Ed25519 private key (64 hex chars)
 * @param publicKey  - Ed25519 public key (64 hex chars)
 *
 * @example
 *   const headers = await signRequest("POST", "/v2/deposit/quote", '{"blockchain":"solana"}', privKey, pubKey);
 *   // headers = {
 *   //   "X-API-Wallet-Public-Key": "a1b2c3...",
 *   //   "X-API-Wallet-Signature": "def456...",
 *   //   "X-API-Wallet-Timestamp": "1700000000",
 *   //   "X-API-Wallet-Nonce": "550e8400-e29b-41d4-a716-446655440000"
 *   // }
 */
export async function signRequest(
  method: string,
  path: string,
  body: string,
  privateKey: string,
  publicKey: string
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID(); // 36 chars, within the 16..128 limit

  // SHA-256 of the raw body bytes (always hashed, even when empty)
  const bodyBytes = new TextEncoder().encode(body);
  const bodyHash = bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bodyBytes))
  );

  // Message: {METHOD}:{PATH}:{TIMESTAMP}:{NONCE}:{BODY_HASH}
  const message = `${method.toUpperCase()}:${path}:${timestamp}:${nonce}:${bodyHash}`;

  const signature = ed.sign(new TextEncoder().encode(message), hexToBytes(privateKey));

  console.debug("[Auth] Signed:", message);

  return {
    "X-API-Wallet-Public-Key": publicKey,
    "X-API-Wallet-Signature": bytesToHex(signature),
    "X-API-Wallet-Timestamp": timestamp,
    "X-API-Wallet-Nonce": nonce,
  };
}

/**
 * Make an authenticated API request using API wallet headers.
 *
 * @param url          - Full URL (API_BASE_URL + path [+ ?query])
 * @param method       - HTTP method
 * @param body         - JSON body (omitted for GET)
 * @param extraHeaders - e.g. { "X-Builder-Fee-Bps": "10" } (not covered by the signature)
 *
 * The middleware answers 401 "authentication failed" both for an unknown
 * wallet and for a bad request signature, so that error is retried once with a
 * fresh timestamp/nonce (nothing ran server-side); the session is cleared only
 * if the retry fails the same way, or on "wallet expired or revoked". Other
 * 401s (e.g. "wallet signature verification failed" on withdraw confirm,
 * "signature expired or invalid timestamp") do not end the session.
 */
export async function authenticatedFetch(
  url: string,
  method: string,
  body?: object,
  extraHeaders?: Record<string, string>,
  attempt: number = 0
): Promise<Response> {
  const keys = loadApiWalletKeys();
  if (!keys) throw new Error("No API wallet keys found. Connect first.");

  const parsedUrl = new URL(url);
  const path = parsedUrl.pathname + parsedUrl.search; // search includes the "?"
  const isGet = method.toUpperCase() === "GET";
  const bodyStr = !isGet && body !== undefined ? JSON.stringify(body) : "";

  const authHeaders = await signRequest(method, path, bodyStr, keys.privateKey, keys.publicKey);

  const headers: Record<string, string> = { ...authHeaders, ...extraHeaders };
  if (bodyStr) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: bodyStr || undefined,
  });

  if (!res.ok) {
    const errBody = await res.clone().text().catch(() => "");
    console.error(`[Auth] ${res.status} ${res.statusText} - ${method} ${path}`, errBody);

    if (res.status === 401) {
      let msg = "";
      try {
        msg = String(JSON.parse(errBody)?.error ?? "");
      } catch {
        /* non-JSON body */
      }
      if (msg === "authentication failed" && attempt === 0) {
        return authenticatedFetch(url, method, body, extraHeaders, 1);
      }
      if (msg === "authentication failed" || msg === "wallet expired or revoked") {
        console.error("[Auth] API wallet rejected - clearing session.");
        clearApiWalletKeys();
        window.dispatchEvent(new Event("strike:session-expired"));
      }
    }
  }

  return res;
}

/** Throw the backend error message ({"error": "..."}) for a non-2xx response. */
export async function throwApiError(res: Response, fallback: string): Promise<never> {
  const err = await res.json().catch(() => ({}));
  throw new Error(err?.error || `${fallback}: ${res.status}`);
}

// ── Hex utilities ──

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
