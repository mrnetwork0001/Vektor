/**
 * Autopilot authentication: no passwords. A tenant is identified by its Strike
 * API-wallet public key and proves possession of the private key by signing.
 *
 *   enroll:  sig over `vektor-autopilot:enroll:${ts}:${publicKey}`
 *   request: sig over `vektor-autopilot:${METHOD}:${PATH}:${ts}:${sha256hex(body)}`
 *
 * `ts` is Unix milliseconds; anything older/newer than 120 s is rejected, and a
 * signature can be used once (replay cache sized to the freshness window).
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { createHash } from "node:crypto";

ed.etc.sha512Sync = (...m: Uint8Array[]) => { const h = sha512.create(); for (const x of m) h.update(x); return h.digest(); };

export const MAX_SKEW_MS = 120_000;
const isHex = (s: unknown, len?: number) => typeof s === "string" && /^[0-9a-f]+$/i.test(s) && (len === undefined || s.length === len);
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

export const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
export const enrollMessage = (ts: number, publicKey: string) => `vektor-autopilot:enroll:${ts}:${publicKey}`;
export const requestMessage = (method: string, path: string, ts: number, body: string) => `vektor-autopilot:${method.toUpperCase()}:${path}:${ts}:${sha256hex(body)}`;

export function verifySig(publicKey: string, message: string, sigHex: string): boolean {
  if (!isHex(publicKey, 64) || !isHex(sigHex, 128)) return false;
  try { return ed.verify(unhex(sigHex), new TextEncoder().encode(message), unhex(publicKey)); } catch { return false; }
}

/** Public key derived from a 64-hex private key (to check an enroll's key pair matches). */
export function publicKeyOf(privateKeyHex: string): string {
  return Buffer.from(ed.getPublicKey(unhex(privateKeyHex.slice(0, 64)))).toString("hex");
}

export function signMessage(privateKeyHex: string, message: string): string {
  return Buffer.from(ed.sign(new TextEncoder().encode(message), unhex(privateKeyHex.slice(0, 64)))).toString("hex");
}

/** Freshness + one-time-use check for signatures. */
export class ReplayGuard {
  private seen = new Map<string, number>();
  constructor(private windowMs = MAX_SKEW_MS) {}
  check(sig: string, ts: number, now = Date.now()): string | null {
    if (!Number.isFinite(ts) || Math.abs(now - ts) > this.windowMs) return "stale or future timestamp";
    for (const [k, t] of this.seen) if (now - t > this.windowMs * 2) this.seen.delete(k);
    if (this.seen.has(sig)) return "replayed signature";
    this.seen.set(sig, now);
    return null;
  }
}
