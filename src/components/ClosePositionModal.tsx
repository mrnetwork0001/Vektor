import { useState, useMemo } from "react";
import { toast } from "react-toastify";
import type { Position } from "../types/position";
import type { Market } from "../types/market";
import type { CreateOrderRequest } from "../types/order";
import { placeOrder } from "../api/orders";
import { formatPrice, formatCurrency, formatSignedCurrency, formatSizeForApi, snapToStep, decimalPlaces } from "../math/formatUtils";
import { estimateCommission, estimateBuilderFee, type FeeRates } from "../math/fees";

interface Props {
  position: Position;
  market: Market | null;
  markPrice: number;
  onClose: () => void;
  feeRates: FeeRates;
  builderFeeBps: number;
}

/**
 * Close position modal - supports market and limit close, partial or full.
 *
 * Close position = regular /v2/order with reduce_only: true.
 * Side is opposite of position (LONG → sell, SHORT → buy).
 * close_position: true for full close (server closes exact remaining size).
 */
export function ClosePositionModal({ position, market, markPrice, onClose, feeRates, builderFeeBps }: Props) {
  const [closeType, setCloseType] = useState<"market" | "limit">("market");
  const [sizePercent, setSizePercent] = useState(100);
  const [limitPrice, setLimitPrice] = useState("");
  const [loading, setLoading] = useState(false);

  const isLong = position.positionSide === "LONG";
  const closeSide = isLong ? "sell" : "buy";
  const basePrec = market?.base_prec ?? 4;
  // Grids are anchored at the market minimum: value = min + k × step
  const isLimit = closeType === "limit";
  const stepSize = parseFloat((isLimit ? market?.order_limit_step_size : market?.order_market_step_size) ?? "0");
  const minSize = parseFloat((isLimit ? market?.order_limit_min_size : market?.order_market_min_size) ?? "0");
  const tickSize = parseFloat(market?.order_tick_price ?? "0");
  const minPrice = parseFloat(market?.order_min_price ?? "0");
  const pricePrec = decimalPlaces(market?.order_tick_price);
  const baseAsset = market?.base_asset ?? position.symbol.split("-")[0];

  // Size from slider
  const closeSize = useMemo(() => {
    if (sizePercent >= 100) return position.size;
    const raw = position.size * (sizePercent / 100);
    return snapToStep(raw, stepSize, basePrec, minSize);
  }, [sizePercent, position.size, stepSize, basePrec, minSize]);

  const isFullClose = closeSize >= position.size;

  // Estimated PnL for the close size
  const estPnL = useMemo(() => {
    if (!markPrice) return 0;
    const effectivePrice = closeType === "limit" && parseFloat(limitPrice) > 0
      ? parseFloat(limitPrice)
      : markPrice;
    const diff = effectivePrice - position.entryPrice;
    return isLong ? diff * closeSize : -diff * closeSize;
  }, [markPrice, closeType, limitPrice, position.entryPrice, isLong, closeSize]);

  // Estimated fee: commission (taker for market, maker for resting limit) + builder fee
  const feeRate = closeType === "market" ? feeRates.takerRate : feeRates.makerRate;
  const effectivePrice = closeType === "limit" && parseFloat(limitPrice) > 0
    ? parseFloat(limitPrice) : markPrice;
  const closeNotional = closeSize * effectivePrice;
  const estFee =
    estimateCommission(closeNotional, feeRate, market?.quote_prec ?? 8) +
    estimateBuilderFee(closeNotional, builderFeeBps);

  const handleSubmit = async () => {
    if (closeSize <= 0) return;
    setLoading(true);

    try {
      const request: CreateOrderRequest = {
        symbol: position.symbol,
        side: closeSide,
        type: closeType,
        size: formatSizeForApi(closeSize, basePrec),
        reduce_only: true,
      };

      // Full close: let server handle exact remaining size
      if (isFullClose) {
        request.close_position = true;
      }

      if (closeType === "limit") {
        const price = parseFloat(limitPrice);
        if (!price || price <= 0) {
          toast.error("Enter a limit price");
          setLoading(false);
          return;
        }
        request.price = snapToStep(price, tickSize, pricePrec, minPrice).toString();
        request.time_in_force = "GTC";
      }

      await placeOrder(request, builderFeeBps);
      toast.success(
        isFullClose
          ? `Closing ${position.symbol} ${position.positionSide}`
          : `Closing ${closeSize} ${baseAsset} of ${position.symbol}`
      );
      onClose();
    } catch (e: any) {
      toast.error(e.message || "Close position failed");
    } finally {
      setLoading(false);
    }
  };

  const pnlColor = estPnL >= 0 ? "text-green" : "text-red";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content close-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Close Position</h3>
        <p className="text-secondary text-sm">
          {position.symbol} {position.positionSide} {position.size} {baseAsset}
        </p>

        {/* Close type tabs */}
        <div className="order-type-tabs" style={{ marginTop: 12 }}>
          <button
            className={`order-type-tab ${closeType === "market" ? "active" : ""}`}
            onClick={() => setCloseType("market")}
          >
            Market
          </button>
          <button
            className={`order-type-tab ${closeType === "limit" ? "active" : ""}`}
            onClick={() => setCloseType("limit")}
          >
            Limit
          </button>
        </div>

        {/* Limit price input */}
        {closeType === "limit" && (
          <div className="form-group">
            <label>Limit Price</label>
            <input
              type="number"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              placeholder={formatPrice(markPrice)}
            />
          </div>
        )}

        {/* Size slider */}
        <div className="form-group">
          <label>
            Close Size: {closeSize} {baseAsset}
            <span className="text-secondary"> ({sizePercent}%)</span>
          </label>
          <input
            type="range"
            min={0}
            max={100}
            value={sizePercent}
            onChange={(e) => setSizePercent(Number(e.target.value))}
            className="leverage-slider"
          />
          <div className="leverage-presets">
            {[25, 50, 75, 100].map((pct) => (
              <button
                key={pct}
                className={`preset-btn ${sizePercent === pct ? "active" : ""}`}
                onClick={() => setSizePercent(pct)}
              >
                {pct}%
              </button>
            ))}
          </div>
        </div>

        {/* Details */}
        <div className="order-details">
          <div className="detail-row">
            <span>Entry Price</span>
            <span>{formatPrice(position.entryPrice)}</span>
          </div>
          <div className="detail-row">
            <span>Mark Price</span>
            <span>{formatPrice(markPrice)}</span>
          </div>
          {closeType === "market" && (
            <div className="detail-row">
              <span>Est. Close Price</span>
              <span>{formatPrice(markPrice)}</span>
            </div>
          )}
          <div className="detail-row">
            <span>Est. PnL</span>
            <span className={pnlColor}>{formatSignedCurrency(estPnL)}</span>
          </div>
          <div className="detail-row">
            <span>Est. Fee ({(feeRate * 100).toFixed(4)}%)</span>
            <span>{formatCurrency(estFee)}</span>
          </div>
        </div>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={loading || closeSize <= 0}
          className={`btn btn-submit ${isLong ? "btn-short" : "btn-long"}`}
          style={{ marginTop: 12, width: "100%" }}
        >
          {loading
            ? "Closing..."
            : isFullClose
              ? `Close ${position.positionSide}`
              : `Close ${sizePercent}%`}
        </button>

        <button
          onClick={onClose}
          className="btn"
          style={{ marginTop: 8, width: "100%", background: "transparent", border: "1px solid var(--border)" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
