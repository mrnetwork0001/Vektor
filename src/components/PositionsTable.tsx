import { useState } from "react";
import type { Position } from "../types/position";
import type { Market } from "../types/market";
import type { MarkPriceUpdate } from "../types/ws";
import {
  formatPrice,
  formatCurrency,
  formatSignedCurrency,
  formatSignedPercent,
  formatSize,
} from "../math/formatUtils";
import { ClosePositionModal } from "./ClosePositionModal";
import type { FeeRates } from "../math/fees";

interface Props {
  positions: Position[];
  basePrec?: number;
  markets?: Record<string, Market>;
  prices?: Record<string, MarkPriceUpdate>;
  feeRates: FeeRates;
  builderFeeBps: number;
}

/**
 * Positions table with close position modal.
 *
 * Columns:
 *   Symbol | Side | Leverage | Size | Entry | Mark | Liq. Price | Margin | PnL (ROE%) | Funding | Close
 *
 * Margin: isolated → iso_balance; cross → initial margin (notional / leverage).
 * ROE% is a UI value (uPnL / (entry × size / leverage)); the backend serves no open-position ROE.
 */
export function PositionsTable({
  positions,
  basePrec = 4,
  markets = {},
  prices = {},
  feeRates,
  builderFeeBps,
}: Props) {
  const [closingPosition, setClosingPosition] = useState<Position | null>(null);

  if (positions.length === 0) {
    return (
      <div className="panel">
        <h3>Positions</h3>
        <p className="text-secondary">No open positions</p>
      </div>
    );
  }

  const closingMarket = closingPosition ? markets[closingPosition.symbol] ?? null : null;
  const closingPriceData = closingPosition ? prices[closingPosition.symbol] : null;
  const closingMarkPrice = closingPriceData ? parseFloat(closingPriceData.p) : 0;

  return (
    <div className="panel">
      <h3>Positions ({positions.length})</h3>
      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Side</th>
              <th>Leverage</th>
              <th>Size</th>
              <th>Entry Price</th>
              <th>Mark Price</th>
              <th>Liq. Price</th>
              <th>Margin</th>
              <th>PnL (ROE%)</th>
              <th>Funding</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <PositionRow
                key={`${p.symbol}-${p.positionSide}`}
                position={p}
                basePrec={markets[p.symbol]?.base_prec ?? basePrec}
                onClose={() => setClosingPosition(p)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {closingPosition && (
        <ClosePositionModal
          position={closingPosition}
          market={closingMarket}
          markPrice={closingMarkPrice}
          onClose={() => setClosingPosition(null)}
          feeRates={feeRates}
          builderFeeBps={builderFeeBps}
        />
      )}
    </div>
  );
}

function PositionRow({
  position: p,
  basePrec,
  onClose,
}: {
  position: Position;
  basePrec: number;
  onClose: () => void;
}) {
  const isLong = p.positionSide === "LONG";
  const pnlColor = (p.uPnL ?? 0) >= 0 ? "text-green" : "text-red";
  const fundingColor =
    (p.accumulatedFundingFees ?? 0) > 0
      ? "text-green"
      : (p.accumulatedFundingFees ?? 0) < 0
        ? "text-red"
        : "text-secondary";

  return (
    <tr>
      <td>{p.symbol}</td>
      <td>
        <span className={isLong ? "badge-long" : "badge-short"}>
          {p.positionSide}
        </span>
      </td>
      <td>{Math.round(p.leverage ?? 0)}x</td>
      <td>
        <div>{formatSize(p.size, basePrec)}</div>
        <div className="text-secondary text-xs">
          {formatCurrency(p.notional ?? 0)}
        </div>
      </td>
      <td>{formatPrice(p.entryPrice)}</td>
      <td>
        {p.notional && p.size > 0
          ? formatPrice((p.notional ?? 0) / p.size)
          : "--"}
      </td>
      <td>
        {(p.liquidationPrice ?? 0) > 0
          ? formatPrice(p.liquidationPrice!)
          : "--"}
      </td>
      <td>
        <div>{formatCurrency(p.currentMargin ?? 0)}</div>
        <div className="text-secondary text-xs">
          {p.marginMode === "isolated" ? "Isolated" : "Cross"}
        </div>
      </td>
      <td className={pnlColor}>
        <div>{formatSignedCurrency(p.uPnL ?? 0)}</div>
        <div className="text-xs">
          {formatSignedPercent(p.pnlPercentage ?? 0)}
        </div>
      </td>
      <td className={fundingColor}>
        {formatSignedCurrency(p.accumulatedFundingFees ?? 0)}
      </td>
      <td>
        <button className="btn btn-close-position" onClick={onClose}>
          Close
        </button>
      </td>
    </tr>
  );
}
