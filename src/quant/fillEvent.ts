// Maps a user-stream ORDER_TRADE_UPDATE to the engine's FillEvent. No browser deps - shared by the terminal and the worker.

import type { OrderTradeUpdateData } from "../types/ws";
import type { FillEvent } from "./types";

const num = (v: unknown) => { const n = parseFloat(String(v ?? "")); return Number.isFinite(n) ? n : 0; };

export function toFillEvent(d: OrderTradeUpdateData): FillEvent {
  const isFill = d.t > 0;
  const cum = num(d.z);
  const qty = num(d.q);
  const X = String(d.X ?? "").toUpperCase();
  let status: FillEvent["status"];
  if (isFill) status = cum >= qty - 1e-12 ? "FILLED" : "PARTIALLY_FILLED";
  else if (X === "FILLED") status = "FILLED";
  else if (X === "CANCELED" || X === "REJECTED" || X === "EXPIRED") status = X;
  else status = "OPEN";
  return {
    symbol: d.s, clientOrderId: d.c, orderId: d.i, side: d.S,
    fillQty: isFill ? num(d.l) : 0, fillPrice: num(d.L), cumFilled: cum, orderQty: qty,
    isMaker: !!d.m, commission: isFill ? num(d.n) : 0, builderFee: isFill ? num(d.builder_fee) : 0,
    timestamp: d.E, status, closeReason: d.cr || undefined,
  };
}
