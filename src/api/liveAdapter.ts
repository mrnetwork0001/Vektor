/**
 * ExecutionAdapter over the live Strike API: batch placement through
 * /v2/orders/batch with the builder fee header, cancels through
 * /v2/order/cancel, fills from ORDER_TRADE_UPDATE on the user stream.
 */

import { placeBatchOrders, replaceAllOrders } from "./vektor";
import { cancelOrder, cancelAllOrders, placeStrategyOrder } from "./orders";
import { userStream } from "../ws/userStream";
import type { CreateOrderRequest, CreateStrategyOrderRequest } from "../types/order";
import type { OrderTradeUpdateData } from "../types/ws";
import type { ExecutionAdapter, FillEvent } from "../quant/types";
import { toFillEvent } from "../quant/fillEvent";
export { toFillEvent };

export class LiveAdapter implements ExecutionAdapter {
  readonly mode = "live" as const;
  constructor(private builderFeeBps: number) {}
  setBuilderFee(bps: number) { this.builderFeeBps = bps; }

  async placeBatch(orders: CreateOrderRequest[]) {
    if (!orders.length) return { accepted: [], failed: [] };
    const res = await placeBatchOrders(orders, this.builderFeeBps);
    const failedIdx = new Set((res.failed ?? []).map((f) => f.index));
    return {
      accepted: orders.filter((_, i) => !failedIdx.has(i)).map((o) => o.client_order_id!),
      failed: res.failed ?? [],
    };
  }

  /** Bracket entry + SL leg; X-Builder-Fee-Bps applies to every leg on /v2/order/strategy. */
  async placeStrategy(req: CreateStrategyOrderRequest) {
    await placeStrategyOrder(req, this.builderFeeBps);
  }

  async cancel(symbol: string, clientOrderId: string) {
    await cancelOrder({ symbol, client_order_id: clientOrderId });
  }

  async cancelAll(symbol?: string) {
    await cancelAllOrders(symbol);
  }

  /** One engine command: cancel all on the symbol, then place. Command-level errors throw; engine rejections arrive on the user stream. */
  async replaceAll(symbol: string, orders: Omit<CreateOrderRequest, "symbol">[]) {
    if (!orders.length) { await cancelAllOrders(symbol); return { accepted: [], failed: [] }; }
    await replaceAllOrders(symbol, orders, this.builderFeeBps);
    return { accepted: orders.map((o) => o.client_order_id!), failed: [] };
  }

  onFill(cb: (f: FillEvent) => void) {
    return userStream.on("ORDER_TRADE_UPDATE", (data: OrderTradeUpdateData) => {
      if (!data) return;
      // A fill (t > 0) is followed by an order update with the new X; the engine
      // ignores zero-qty FILLED updates so nothing is double counted.
      cb(toFillEvent(data));
    });
  }
}
