/**
 * Client for the Vektor Autopilot server (server/index.ts). Requests are
 * signed with this session's API wallet key - no passwords.
 */

import * as ed from "@noble/ed25519";
import { bytesToHex, hexToBytes, loadApiWalletKeys } from "./auth";

export const AUTOPILOT_URL: string = (import.meta.env.VITE_AUTOPILOT_URL ?? "").replace(/\/$/, "");
export const autopilotAvailable = () => !!AUTOPILOT_URL;

async function sha256hex(s: string) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

async function signed<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const keys = loadApiWalletKeys();
  if (!keys) throw new Error("Sign in first");
  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  const ts = Date.now();
  const msg = `vektor-autopilot:${method}:${path}:${ts}:${await sha256hex(bodyStr)}`;
  const sig = bytesToHex(ed.sign(new TextEncoder().encode(msg), hexToBytes(keys.privateKey)));
  const res = await fetch(`${AUTOPILOT_URL}${path}`, {
    method, body: bodyStr || undefined,
    headers: { "Content-Type": "application/json", "X-Vektor-Key": keys.publicKey, "X-Vektor-Ts": String(ts), "X-Vektor-Sig": sig },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error ?? `autopilot ${res.status}`), { status: res.status });
  return json;
}

export async function enrollAutopilot(builderCode?: string, feeShareBps?: number) {
  const keys = loadApiWalletKeys();
  if (!keys) throw new Error("Sign in first");
  const ts = Date.now();
  const sig = bytesToHex(ed.sign(new TextEncoder().encode(`vektor-autopilot:enroll:${ts}:${keys.publicKey}`), hexToBytes(keys.privateKey)));
  const res = await fetch(`${AUTOPILOT_URL}/v1/enroll`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: keys.publicKey, privateKey: keys.privateKey, ts, sig, builderCode, feeShareBps }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `enroll ${res.status}`);
  return json as { ok: true; accountId: string };
}

export const autopilotHealth = async () => { const r = await fetch(`${AUTOPILOT_URL}/health`); if (!r.ok) throw new Error(`health ${r.status}`); return r.json(); };
export const autopilotStatus = () => signed("GET", "/v1/status");
export const autopilotDeploy = (grid: Record<string, unknown>) => signed("POST", "/v1/grids", grid);
export const autopilotStop = (symbol: string) => signed("DELETE", `/v1/grids/${symbol}`);
export const autopilotPanic = () => signed("POST", "/v1/panic", {});
export const autopilotDisable = () => signed("DELETE", "/v1/enroll", {});
