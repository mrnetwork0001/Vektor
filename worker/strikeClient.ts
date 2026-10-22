/**
 * Minimal Node client for Strike V2: Ed25519 request signing, authenticated
 * fetch, user stream (session.logon) and public price stream. No browser
 * globals — Node 22+ has fetch, crypto.subtle and WebSocket built in.
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { createHash, randomUUID } from "node:crypto";

ed.etc.sha512Sync = (...m: Uint8Array[]) => { const h = sha512.create(); for (const x of m) h.update(x); return h.digest(); };

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

export interface ClientConfig {
  apiUrl: string;
  priceUrl: string;
  userWsUrl: string;
  priceWsUrl: string;
  publicKey: string;
  privateKey: string;
  builderFeeBps: number;
}

export class StrikeClient {
  constructor(public cfg: ClientConfig) {}

  signHeaders(method: string, path: string, body: string): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID();
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const msg = `${method.toUpperCase()}:${path}:${timestamp}:${nonce}:${bodyHash}`;
    const sig = ed.sign(new TextEncoder().encode(msg), unhex(this.cfg.privateKey));
    return { "X-API-Wallet-Public-Key": this.cfg.publicKey, "X-API-Wallet-Signature": hex(sig), "X-API-Wallet-Timestamp": timestamp, "X-API-Wallet-Nonce": nonce };
  }

  async call<T = any>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: T }> {
    const bodyStr = body !== undefined ? JSON.stringify(body) : "";
    const headers: Record<string, string> = { ...this.signHeaders(method, path, bodyStr), ...extra };
    if (bodyStr) headers["Content-Type"] = "application/json";
    const res = await fetch(`${this.cfg.apiUrl}${path}`, { method, headers, body: bodyStr || undefined });
    const text = await res.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text }; }
    if (!res.ok && res.status !== 404) throw new Error(`${method} ${path} → ${res.status} ${json.error ?? text}`);
    return { status: res.status, json };
  }

  async public<T = any>(path: string): Promise<T> {
    const res = await fetch(`${this.cfg.priceUrl}${path}`);
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json();
  }

  builderHeaders(): Record<string, string> {
    return this.cfg.builderFeeBps > 0 ? { "X-Builder-Fee-Bps": String(Math.floor(this.cfg.builderFeeBps)) } : {};
  }

  /** Authenticated user stream. Reconnects forever; `onSubscribed` fires after every (re)subscribe. */
  userStream(handlers: { onEvent: (e: string, data: any) => void; onSubscribed: () => void; log: (m: string) => void }) {
    let ws: WebSocket | null = null;
    let attempts = 0;
    const connect = () => {
      ws = new WebSocket(this.cfg.userWsUrl);
      ws.onopen = () => {
        attempts = 0;
        const timestamp = Date.now();
        const sig = hex(ed.sign(new TextEncoder().encode(`session.logon:${timestamp}:${this.cfg.publicKey}`), unhex(this.cfg.privateKey)));
        ws!.send(JSON.stringify({ id: 1, method: "session.logon", params: { apiKey: this.cfg.publicKey, signature: sig, timestamp } }));
      };
      ws.onmessage = (ev) => {
        for (const line of String(ev.data).split("\n")) {
          if (!line.trim()) continue;
          let m: any; try { m = JSON.parse(line); } catch { continue; }
          if (m.e === "error") { handlers.log(`userstream error ${m.error?.code} ${m.error?.msg}`); continue; }
          if (m.id === 1 && m.status === 200) { ws!.send(JSON.stringify({ id: 2, method: "subscribe", channel: "userstream" })); continue; }
          if (m.id === 2 && "result" in m) { handlers.onSubscribed(); continue; }
          if (m.e) handlers.onEvent(m.e, m.data);
        }
      };
      ws.onclose = () => { attempts++; const d = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5)); handlers.log(`userstream closed, retry in ${d}ms`); setTimeout(connect, d); };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => ws?.close();
  }

  /** Public price stream: all-symbol mark prices (every 3 s). */
  priceStream(onMark: (m: { s: string; p: string; i: string; r: string; T: number; E: number }) => void, log: (m: string) => void) {
    let ws: WebSocket | null = null;
    const connect = () => {
      ws = new WebSocket(this.cfg.priceWsUrl);
      ws.onopen = () => ws!.send(JSON.stringify({ id: 1, method: "subscribe", channel: "!markPrice@arr" }));
      ws.onmessage = (ev) => {
        for (const line of String(ev.data).split("\n")) {
          if (!line.trim()) continue;
          let m: any; try { m = JSON.parse(line); } catch { continue; }
          for (const x of Array.isArray(m) ? m : [m]) if (x?.e === "markPriceUpdate") onMark(x);
        }
      };
      ws.onclose = () => { log("pricestream closed, retry in 3s"); setTimeout(connect, 3000); };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => ws?.close();
  }
}
