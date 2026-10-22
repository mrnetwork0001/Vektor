import { useState, useEffect } from "react";
import { formatPrice } from "../math/formatUtils";

interface Props {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
  nextFundingTime: number;
}

/**
 * Price bar showing mark price, index price, funding rate, and countdown.
 *
 * Funding is paid HOURLY at HH:00 UTC; `r` on markPriceUpdate is the live
 * hourly rate (the capped 8h rate / 8).
 *   fundingRatePercent = rate * 100          (e.g. 0.0000125 -> 0.00125% per hour)
 *   annualized         = rate * 100 * 24 * 365
 *   payment per position = -signedSize * mark * rate  (positive rate: longs pay)
 *
 * Countdown: nextFundingTime - Date.now() formatted as HH:MM:SS
 */
export function PriceBar({
  symbol,
  markPrice,
  indexPrice,
  fundingRate,
  nextFundingTime,
}: Props) {
  const [countdown, setCountdown] = useState("");

  useEffect(() => {
    if (!nextFundingTime) return;

    const update = () => {
      const diff = nextFundingTime - Date.now();
      if (diff <= 0) {
        setCountdown("00:00:00");
        return;
      }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setCountdown(
        `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      );
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [nextFundingTime]);

  const fundingPercent = (fundingRate * 100).toFixed(4);
  const annualized = (fundingRate * 100 * 24 * 365).toFixed(2);
  const fundingColor = fundingRate >= 0 ? "text-green" : "text-red";

  return (
    <div className="price-bar">
      <div className="price-item">
        <span className="label">{symbol}</span>
        <span className="value price-main">{formatPrice(markPrice)}</span>
      </div>
      <div className="price-item">
        <span className="label">Mark</span>
        <span className="value">{formatPrice(markPrice)}</span>
      </div>
      <div className="price-item">
        <span className="label">Index</span>
        <span className="value">{formatPrice(indexPrice)}</span>
      </div>
      <div className="price-item">
        <span className="label">Funding / 1h</span>
        <span className={`value ${fundingColor}`}>{fundingPercent}%</span>
      </div>
      <div className="price-item">
        <span className="label">Annualized</span>
        <span className={`value ${fundingColor}`}>{annualized}%</span>
      </div>
      <div className="price-item">
        <span className="label">Countdown</span>
        <span className="value">{countdown}</span>
      </div>
    </div>
  );
}
