/**
 * User WebSocket stream for API wallets: wss://<host>/ws/user-api
 * (services/userstream /ws-api; /ws/user is the Strike app's JWT endpoint).
 *
 * Auth + subscribe flow:
 * 1. Connect (no query params, no headers)
 * 2. session.logon:
 *      message   = "session.logon:{timestamp_ms}:{apiKey}"   (timestamp in MILLISECONDS,
 *                  at most 30s in the future / 3 min old)
 *      signature = hex Ed25519 signature of message with the API wallet private key
 *    SEND    {"id":1,"method":"session.logon","params":{"apiKey","signature","timestamp"}}
 *    RECEIVE {"id":1,"status":200,"result":{"authenticated":true,"account_id":"..."}}
 *    Any logon failure → error frame 401 "Authentication failed" (socket stays open).
 * 3. Subscribe: {"id":2,"method":"subscribe","channel":"userstream"} → {"id":2,"result":null}
 *    (optional "account_id" must equal the logged-on account; "sub_account_id" for owned sub-accounts)
 * 4. Events arrive as { e, E, data }: ORDER_TRADE_UPDATE, ACCOUNT_UPDATE, strategyUpdate, rfqUpdate
 *
 * Errors carry no id: {"e":"error","E":...,"error":{"code":401,"msg":"..."}}.
 * Frames may contain several JSON messages separated by "\n".
 * Keepalive: the server sends WS ping frames every 54s (browsers answer
 * automatically); app-level {"method":"ping"} gets {"method":"pong"} but does
 * not extend the server's pong deadline.
 * No snapshot and no replay: after (re)subscribing, reload REST state.
 */

import { USER_WS_URL } from "../api/config";
import { loadApiWalletKeys, bytesToHex, hexToBytes } from "../api/auth";
import * as ed from "@noble/ed25519";

export type UserStreamCallback = (data: any, envelope: any) => void;

const MAX_RECONNECT_DELAY = 30000;
const LOGON_REQUEST_ID = 1;
const SUBSCRIBE_REQUEST_ID = 2;

export class UserStream {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<UserStreamCallback>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private isAuthenticated = false;
  private active = false;

  connect() {
    this.closeSocket();
    this.active = true;
    this.isAuthenticated = false;

    const keys = loadApiWalletKeys();
    if (!keys) {
      console.error("[UserStream] No API wallet keys - did builder connect complete?");
      return;
    }

    console.log("[UserStream] Connecting to:", USER_WS_URL);
    const ws = new WebSocket(USER_WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.sendLogon(keys.privateKey, keys.publicKey);
    };

    ws.onmessage = (event) => {
      for (const line of String(event.data).split("\n")) {
        if (!line.trim()) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        this.handleMessage(message);
      }
    };

    ws.onerror = (err) => {
      console.error("[UserStream] WebSocket error:", err);
    };

    ws.onclose = (event) => {
      console.log("[UserStream] Disconnected, code:", event.code, "reason:", event.reason);
      this.ws = null;
      this.isAuthenticated = false;
      if (!this.active) return;
      // Retry forever with capped exponential backoff (1s … 30s)
      this.reconnectAttempts++;
      const delay = Math.min(1000 * 2 ** Math.min(this.reconnectAttempts, 5), MAX_RECONNECT_DELAY);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  private handleMessage(message: any) {
    // Error frames have no id
    if (message?.e === "error") {
      const { code, msg } = message.error ?? {};
      console.error(`[UserStream] Error ${code}: ${msg}`);
      if (!this.isAuthenticated && code === 401) {
        // Logon failed (bad signature, revoked/expired wallet, timestamp outside window).
        // The server keeps the socket open; stop here instead of retrying blindly.
        this.active = false;
        this.closeSocket();
      }
      this.emit("error", message, message);
      return;
    }

    // Logon ack
    if (message?.id === LOGON_REQUEST_ID && message?.status === 200) {
      console.log("[UserStream] session.logon OK - account", message.result?.account_id);
      this.isAuthenticated = true;
      this.send({ id: SUBSCRIBE_REQUEST_ID, method: "subscribe", channel: "userstream" });
      return;
    }

    // Subscribe ack → consumers should (re)load REST state now
    if (message?.id === SUBSCRIBE_REQUEST_ID && "result" in message) {
      console.log("[UserStream] Subscribed to userstream");
      this.emit("subscribed", message, message);
      return;
    }

    const eventType: string = message?.e ?? "";
    if (!eventType) return; // other acks / pongs

    // Dispatch the event's `data` payload; listeners also get the envelope
    this.emit(eventType, message.data, message);
    this.emit("*", message.data, message);
  }

  private emit(eventType: string, data: any, envelope: any) {
    const listeners = this.listeners.get(eventType);
    if (!listeners) return;
    for (const cb of listeners) {
      try {
        cb(data, envelope);
      } catch (e) {
        console.error("[UserStream] Listener error:", e);
      }
    }
  }

  /** session.logon - message "session.logon:{timestamp_ms}:{apiKey}", hex Ed25519 signature. */
  private sendLogon(privateKey: string, publicKey: string) {
    const timestamp = Date.now(); // milliseconds
    const message = `session.logon:${timestamp}:${publicKey}`;
    const signature = bytesToHex(ed.sign(new TextEncoder().encode(message), hexToBytes(privateKey)));

    this.send({
      id: LOGON_REQUEST_ID,
      method: "session.logon",
      params: { apiKey: publicKey, signature, timestamp },
    });
  }

  private send(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private closeSocket() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
  }

  disconnect() {
    this.active = false;
    this.isAuthenticated = false;
    this.closeSocket();
  }

  /**
   * @param eventType - "ACCOUNT_UPDATE" | "ORDER_TRADE_UPDATE" | "strategyUpdate" |
   *                    "rfqUpdate" | "subscribed" | "error" | "*"
   */
  on(eventType: string, callback: UserStreamCallback): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(callback);
    return () => this.listeners.get(eventType)?.delete(callback);
  }
}

export const userStream = new UserStream();
