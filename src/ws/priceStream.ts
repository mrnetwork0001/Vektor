/**
 * Price WebSocket stream (public, no auth).
 * Connects to wss://<host>/ws/price (price service /ws).
 *
 * Subscribe (per symbol):  {"id":1,"method":"subscribe","channel":"<channel>","symbol":"BTC-USD"}
 *   → server stream "<lowercase symbol>@<channel>" (channel lowercased except kline_*)
 *   ack: {"id":1,"result":null}
 * Global channels (no symbol, name starts with "!"): "!markPrice@arr", "!miniTicker@arr"
 * Binance style also works: {"method":"SUBSCRIBE","params":["btc-usd@depth"],"id":1}
 * Unsubscribe: same body with "method":"unsubscribe".
 * Ping: {"method":"ping","id":5} → {"id":5,"method":"pong"}
 * Errors (no id): {"e":"error","E":...,"error":{"code":400,"msg":"..."}}
 *
 * Channels → event:
 *   markPrice          markPriceUpdate every 3s      markPrice@1s   markPriceUpdate ~1s
 *   depth              depthUpdate (top-20 diffs)    bookTicker     bookTicker (best bid/ask)
 *   trade              trade                         miniTicker     24hrMiniTicker
 *   kline_<i>          kline (last price)            kline_<i>_mark / kline_<i>_index
 *   !markPrice@arr     array of markPriceUpdate      !miniTicker@arr array of 24hrMiniTicker
 *
 * A frame may contain several JSON messages separated by "\n".
 */

import { PRICE_WS_URL } from "../api/config";

export type PriceStreamCallback = (event: any) => void;

interface Sub {
  channel: string;
  symbol?: string;
}

export class PriceStream {
  private ws: WebSocket | null = null;
  private subscriptions = new Map<string, Sub>();
  private listeners = new Map<string, Set<PriceStreamCallback>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private nextId = 1;
  private pendingAcks = new Map<number, string>(); // request id → subscription key

  connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return; // CONNECTING or OPEN

    this.ws = new WebSocket(PRICE_WS_URL);

    this.ws.onopen = () => {
      console.log("[PriceStream] Connected");
      this.reconnectAttempts = 0;
      this.pendingAcks.clear();
      // Re-subscribe on (re)connect - the server keeps no state across sockets.
      // Each ack emits "subscribed:<channel>|<symbol>" so consumers (e.g. the
      // order book) can re-sync from REST.
      for (const sub of this.subscriptions.values()) this._send("subscribe", sub);
    };

    this.ws.onmessage = (event) => {
      for (const line of String(event.data).split("\n")) {
        if (!line.trim()) continue;
        let data: any;
        try {
          data = JSON.parse(line);
        } catch {
          continue;
        }
        this._dispatch(data);
      }
    };

    this.ws.onclose = () => {
      console.log("[PriceStream] Disconnected");
      this._scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
    this.ws = null;
  }

  /**
   * Subscribe to a channel for a symbol (omit symbol for "!...@arr" channels).
   * @example
   *   priceStream.subscribe("markPrice", "BTC-USD");
   *   priceStream.subscribe("depth", "BTC-USD");
   *   priceStream.subscribe("kline_1m_mark", "BTC-USD");
   *   priceStream.subscribe("!markPrice@arr");
   */
  subscribe(channel: string, symbol?: string) {
    const key = symbol ? `${channel}|${symbol}` : channel;
    if (this.subscriptions.has(key)) return;
    const sub = { channel, symbol };
    this.subscriptions.set(key, sub);
    this._send("subscribe", sub);
  }

  unsubscribe(channel: string, symbol?: string) {
    const key = symbol ? `${channel}|${symbol}` : channel;
    if (!this.subscriptions.delete(key)) return;
    this._send("unsubscribe", { channel, symbol });
  }

  /**
   * Listen for events.
   * @param key - Event type (e.g. "markPriceUpdate"), "eventType:SYMBOL"
   *              (e.g. "depthUpdate:BTC-USD"), or "subscribed:channel|SYMBOL"
   *              (fires on every subscribe ack, including after reconnects)
   * @returns Unsubscribe function
   */
  on(key: string, callback: PriceStreamCallback): () => void {
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key)!.add(callback);
    return () => this.listeners.get(key)?.delete(callback);
  }

  private _dispatch(data: any) {
    // Subscribe ack: {"id":N,"result":null}
    if (data && !Array.isArray(data) && data.id !== undefined && "result" in data) {
      const key = this.pendingAcks.get(data.id);
      if (key) {
        this.pendingAcks.delete(data.id);
        this.listeners.get(`subscribed:${key}`)?.forEach((cb) => cb(data));
      }
      return;
    }

    // Array payloads: !markPrice@arr, !miniTicker@arr
    const messages = Array.isArray(data) ? data : [data];

    for (const msg of messages) {
      if (msg?.e === "error") {
        console.error("[PriceStream] Error:", msg.error?.code, msg.error?.msg);
        continue;
      }
      const eventType = msg?.e;
      if (!eventType) continue; // acks ({id, result:null}) and pongs

      this.listeners.get(eventType)?.forEach((cb) => cb(msg));

      // Kline events carry the symbol at both s and k.s
      const symbol = msg.s || msg.k?.s;
      if (symbol) {
        this.listeners.get(`${eventType}:${symbol}`)?.forEach((cb) => cb(msg));
      }
    }
  }

  private _send(method: "subscribe" | "unsubscribe", sub: Sub) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const id = this.nextId++;
    if (method === "subscribe") {
      this.pendingAcks.set(id, sub.symbol ? `${sub.channel}|${sub.symbol}` : sub.channel);
    }
    const msg: Record<string, unknown> = { id, method, channel: sub.channel };
    if (sub.symbol) msg.symbol = sub.symbol;
    this.ws.send(JSON.stringify(msg));
  }

  // Retry forever with capped exponential backoff (1s … 30s)
  private _scheduleReconnect() {
    this.reconnectAttempts++;
    const delay = Math.min(1000 * 2 ** Math.min(this.reconnectAttempts, 5), 30000);
    this.reconnectTimer = setTimeout(() => {
      this.ws = null;
      this.connect();
    }, delay);
  }
}

// Singleton instance
export const priceStream = new PriceStream();
