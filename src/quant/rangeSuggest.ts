// ── Smart range from realised volatility ──
//
// Range = last close ± k × ATR(14). Level count is chosen so the spacing is
// at least `minSpacingMultiple` × the fee floor (maker+taker+2×builder) —
// the same rule Strike's own grid service enforces — capped at 40 levels.

import type { Candle } from "./backtest";
import type { FeeContext } from "./types";
import { fix } from "./types";

export interface RangeSuggestion {
  lower: number;
  upper: number;
  levels: number;
  atr: number;
  atrPct: number;
  spacingPct: number;
  feeFloorPct: number;
  basis: string;
}

export function atr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const n = Math.min(period, trs.length);
  return trs.slice(-n).reduce((a, b) => a + b, 0) / n;
}

export function suggestRange(candles: Candle[], fees: FeeContext, k = 3, minSpacingMultiple = 3, maxLevels = 40): RangeSuggestion | null {
  if (candles.length < 15) return null;
  const last = candles[candles.length - 1].c;
  const a = atr(candles);
  if (!(a > 0)) return null;
  const lower = last - k * a;
  const upper = last + k * a;
  if (lower <= 0) return null;
  const feeFloorPct = (fees.makerRate * 2 + fees.takerRate * 0 + (fees.builderFeeBps / 10000) * 2) * 100 + (fees.makerRate + fees.takerRate) * 100;
  const minSpacingPct = Math.max(feeFloorPct * minSpacingMultiple, 0.15);
  const rangePct = ((upper - lower) / last) * 100;
  const levels = Math.max(4, Math.min(maxLevels, Math.floor(rangePct / minSpacingPct) + 1));
  return {
    lower: fix(lower, 8), upper: fix(upper, 8), levels, atr: fix(a, 8), atrPct: fix((a / last) * 100, 3),
    spacingPct: fix(rangePct / (levels - 1), 3), feeFloorPct: fix(feeFloorPct, 4),
    basis: `last ± ${k}×ATR(14) on ${candles.length} candles`,
  };
}
