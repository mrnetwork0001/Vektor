# 🛠️ Vektor — Quantitative Engines & Implementation Guide

This guide provides the complete, copy-paste-ready TypeScript engines for **Vektor** (`gridEngine.ts`, `fundingHarvester.ts`, `liquidationShield.ts`, and `whaleRadar.ts`) designed to plug directly into [`strike-finance/strike-builder-reference`](https://github.com/strike-finance/strike-builder-reference) and [`strike-finance/strike-finance-skills`](https://github.com/strike-finance/strike-finance-skills).

---

## 1. Automated Batch Grid Engine (`src/quant/gridEngine.ts`)

Computes arithmetic or geometric price rungs across a user-selected price range, constructs the Strike V2 batch limit order payloads with `X-Builder-Fee-Bps`, and computes the exact counter-order when a rung fills on `wss://v2.strikefinance.org/ws`:

```typescript
// src/quant/gridEngine.ts
export type GridMode = 'ARITHMETIC' | 'GEOMETRIC';

export interface GridConfig {
  symbol: string;          // e.g., "ADA-USDT", "BTC-USDT", "SOL-USDT"
  lowerPrice: number;      // e.g., 0.3800
  upperPrice: number;      // e.g., 0.4600
  currentMarkPrice: number;
  levels: number;          // e.g., 12 (between 4 and 40)
  totalMarginUsdt: number; // e.g., 500 USDT
  leverage: number;        // e.g., 3x
  mode: GridMode;
  priceDecimals: number;   // e.g., 4 for ADA, 2 for BTC
  qtyDecimals: number;
}

export interface GridRung {
  index: number;
  price: number;
  side: 'BUY' | 'SELL';
  quantity: number;
  notionalUsdt: number;
  expectedProfitPerCyclePct: number;
}

export function generateGridRungs(config: GridConfig): GridRung[] {
  const {
    lowerPrice,
    upperPrice,
    currentMarkPrice,
    levels,
    totalMarginUsdt,
    leverage,
    mode,
    priceDecimals,
    qtyDecimals,
  } = config;

  if (lowerPrice >= upperPrice) {
    throw new Error('lowerPrice must be strictly less than upperPrice');
  }

  const totalNotional = totalMarginUsdt * leverage;
  const notionalPerRung = totalNotional / levels;
  const rungs: GridRung[] = [];

  const arithmeticStep = (upperPrice - lowerPrice) / (levels - 1);
  const geometricRatio = Math.pow(upperPrice / lowerPrice, 1 / (levels - 1));

  for (let i = 0; i < levels; i++) {
    const rawPrice =
      mode === 'ARITHMETIC'
        ? lowerPrice + i * arithmeticStep
        : lowerPrice * Math.pow(geometricRatio, i);

    const price = Number(rawPrice.toFixed(priceDecimals));
    const quantity = Number((notionalPerRung / price).toFixed(qtyDecimals));

    // Rungs below current Mark Price are BUY limits; rungs above are SELL limits
    const side: 'BUY' | 'SELL' = price < currentMarkPrice ? 'BUY' : 'SELL';

    const stepPct =
      mode === 'GEOMETRIC'
        ? (geometricRatio - 1) * 100
        : (arithmeticStep / price) * 100;

    rungs.push({
      index: i,
      price,
      side,
      quantity,
      notionalUsdt: Number((price * quantity).toFixed(2)),
      expectedProfitPerCyclePct: Number((stepPct * leverage).toFixed(2)),
    });
  }

  return rungs;
}

/**
 * When a Grid Rung fills on the User WebSocket (`ws/user-api`),
 * automatically compute the counter take-profit limit order 1 rung away.
 */
export function buildAutoReplenishOrder(
  filledRungIndex: number,
  filledSide: 'BUY' | 'SELL',
  rungs: GridRung[],
  symbol: string
) {
  const targetIndex = filledSide === 'BUY' ? filledRungIndex + 1 : filledRungIndex - 1;
  if (targetIndex < 0 || targetIndex >= rungs.length) return null;

  const targetRung = rungs[targetIndex];
  return {
    symbol,
    side: filledSide === 'BUY' ? ('SELL' as const) : ('BUY' as const),
    type: 'LIMIT' as const,
    timeInForce: 'GTC' as const,
    price: String(targetRung.price),
    quantity: String(targetRung.quantity),
    postOnly: true,
    clientOrderId: `vektor-grid-flip-${targetRung.index}-${Date.now()}`,
  };
}
```

---

## 2. Delta-Neutral Funding Rate Harvester (`src/quant/fundingHarvester.ts`)

Scans all Strike V2 perpetual markets for funding rate carry opportunities, calculates annualized APR, and computes the exact VWAP-safe delta-neutral perpetual hedge leg:

```typescript
// src/quant/fundingHarvester.ts
export interface MarketFundingSnapshot {
  symbol: string;            // "ADA-USDT" | "BTC-USDT" | "ETH-USDT" | "SOL-USDT"
  markPrice: number;
  indexPrice: number;
  fundingRate8h: number;     // e.g., 0.00032 (+0.032% per 8 hours)
  nextFundingTimeMs: number;
  openInterestUsdt: number;
}

export interface FundingOpportunity {
  symbol: string;
  fundingRate8hPct: number;
  annualizedAprPct: number;
  basisSpreadPct: number;    // (mark - index) / index * 100
  recommendedPerpSide: 'SHORT' | 'LONG';
  recommendedSpotAction: 'HOLD_OR_BUY_SPOT' | 'BORROW_OR_UNDERWEIGHT';
  dailyYieldOn10kUsdt: number;
}

export function rankFundingOpportunities(
  snapshots: MarketFundingSnapshot[]
): FundingOpportunity[] {
  return snapshots
    .map((m) => {
      // 3 funding intervals per day * 365 days = 1,095 intervals/year
      const annualizedAprPct = Number((Math.abs(m.fundingRate8h) * 3 * 365 * 100).toFixed(2));
      const fundingRate8hPct = Number((m.fundingRate8h * 100).toFixed(4));
      const basisSpreadPct = Number(
        (((m.markPrice - m.indexPrice) / m.indexPrice) * 100).toFixed(3)
      );

      // Positive funding -> Longs pay Shorts -> Open SHORT Perp against Spot holdings
      const recommendedPerpSide: 'SHORT' | 'LONG' =
        m.fundingRate8h >= 0 ? 'SHORT' : 'LONG';

      const dailyYieldOn10kUsdt = Number(
        (10_000 * Math.abs(m.fundingRate8h) * 3).toFixed(2)
      );

      return {
        symbol: m.symbol,
        fundingRate8hPct,
        annualizedAprPct,
        basisSpreadPct,
        recommendedPerpSide,
        recommendedSpotAction:
          m.fundingRate8h >= 0 ? 'HOLD_OR_BUY_SPOT' : 'BORROW_OR_UNDERWEIGHT',
        dailyYieldOn10kUsdt,
      };
    })
    .sort((a, b) => b.annualizedAprPct - a.annualizedAprPct);
}

/**
 * Generates a TWAP-sliced Delta-Neutral Hedge plan so large positions
 * enter the Strike V2 CLOB with near-zero slippage.
 */
export function buildDeltaNeutralHedgePlan(params: {
  symbol: string;
  spotAssetQuantity: number; // e.g., 10,000 ADA
  markPrice: number;
  perpLeverage: number;      // Recommended: 1x to 3x for safe funding farming
  twapSlices: number;        // e.g., 4 slices over 60 seconds
  qtyDecimals: number;
}) {
  const totalNotionalUsdt = params.spotAssetQuantity * params.markPrice;
  const requiredPerpMarginUsdt = totalNotionalUsdt / params.perpLeverage;
  const sliceQuantity = Number(
    (params.spotAssetQuantity / params.twapSlices).toFixed(params.qtyDecimals)
  );

  // At 2x short leverage, liquidation is roughly +45% above entry mark price
  const estimatedShortLiqPrice = Number(
    (params.markPrice * (1 + 0.9 / params.perpLeverage)).toFixed(4)
  );

  return {
    symbol: params.symbol,
    side: 'SELL' as const, // Short Perp to offset Long Spot (Net Delta = 0)
    totalHedgeQuantity: params.spotAssetQuantity,
    totalNotionalUsdt: Number(totalNotionalUsdt.toFixed(2)),
    requiredPerpMarginUsdt: Number(requiredPerpMarginUsdt.toFixed(2)),
    estimatedShortLiqPrice,
    twapSliceCount: params.twapSlices,
    sliceQuantity,
  };
}
```

---

## 3. Aegis Autonomous Liquidation Shield (`src/quant/liquidationShield.ts`)

Monitors every open position received via `wss://v2.strikefinance.org/ws` (`strike-userstream`) and triggers automatic protective actions before a liquidation can occur:

```typescript
// src/quant/liquidationShield.ts
export interface MonitoredPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  marginUsdt: number;
  maintenanceMarginRatio: number; // from marginTiers.ts
}

export interface ShieldEvaluation {
  symbol: string;
  distanceToLiqPct: number;
  healthStatus: 'SAFE' | 'WARNING' | 'CRITICAL_AUTO_TRIM';
  recommendedAction: 'NONE' | 'CANCEL_OPEN_BUYS' | 'TRIM_25_PERCENT_REDUCE_ONLY';
  reduceOnlyOrderPayload?: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET';
    quantity: string;
    reduceOnly: true;
    clientOrderId: string;
  };
}

export function evaluatePositionShield(
  pos: MonitoredPosition,
  warningBufferPct = 8.0,
  criticalTrimBufferPct = 5.0,
  qtyDecimals = 2
): ShieldEvaluation {
  if (!pos.liquidationPrice || pos.size <= 0) {
    return {
      symbol: pos.symbol,
      distanceToLiqPct: 100,
      healthStatus: 'SAFE',
      recommendedAction: 'NONE',
    };
  }

  const distanceToLiqPct =
    pos.side === 'LONG'
      ? ((pos.markPrice - pos.liquidationPrice) / pos.markPrice) * 100
      : ((pos.liquidationPrice - pos.markPrice) / pos.markPrice) * 100;

  const roundedDist = Number(Math.max(0, distanceToLiqPct).toFixed(2));

  if (roundedDist <= criticalTrimBufferPct) {
    const trimQty = Number((pos.size * 0.25).toFixed(qtyDecimals));
    return {
      symbol: pos.symbol,
      distanceToLiqPct: roundedDist,
      healthStatus: 'CRITICAL_AUTO_TRIM',
      recommendedAction: 'TRIM_25_PERCENT_REDUCE_ONLY',
      reduceOnlyOrderPayload: {
        symbol: pos.symbol,
        side: pos.side === 'LONG' ? 'SELL' : 'BUY',
        type: 'MARKET',
        quantity: String(trimQty),
        reduceOnly: true,
        clientOrderId: `vektor-shield-trim-${Date.now()}`,
      },
    };
  }

  if (roundedDist <= warningBufferPct) {
    return {
      symbol: pos.symbol,
      distanceToLiqPct: roundedDist,
      healthStatus: 'WARNING',
      recommendedAction: 'CANCEL_OPEN_BUYS',
    };
  }

  return {
    symbol: pos.symbol,
    distanceToLiqPct: roundedDist,
    healthStatus: 'SAFE',
    recommendedAction: 'NONE',
  };
}
```

---

## 4. CLOB Whale-Wall & Imbalance Radar (`src/quant/whaleRadar.ts`)

Analyzes the Strike V2 orderbook (`GET /price/v2/depth` + `{symbol}@depth` deltas) to detect whale support/resistance walls and orderbook bid/ask pressure:

```typescript
// src/quant/whaleRadar.ts
export type PriceLevel = [string, string]; // [price, quantity]

export interface WhaleWall {
  side: 'BID' | 'ASK';
  price: number;
  quantity: number;
  notionalUsdt: number;
  multipleOfAverage: number;
}

export function analyzeOrderbookDepth(bids: PriceLevel[], asks: PriceLevel[]) {
  const parsedBids = bids.map(([p, q]) => ({
    price: Number(p),
    quantity: Number(q),
    notionalUsdt: Number(p) * Number(q),
  }));
  const parsedAsks = asks.map(([p, q]) => ({
    price: Number(p),
    quantity: Number(q),
    notionalUsdt: Number(p) * Number(q),
  }));

  const totalBidNotional = parsedBids.reduce((acc, b) => acc + b.notionalUsdt, 0);
  const totalAskNotional = parsedAsks.reduce((acc, a) => acc + a.notionalUsdt, 0);
  const totalDepth = totalBidNotional + totalAskNotional || 1;

  const bidImbalancePct = Number(((totalBidNotional / totalDepth) * 100).toFixed(1));
  const avgLevelNotional = totalDepth / Math.max(1, parsedBids.length + parsedAsks.length);

  const whaleWalls: WhaleWall[] = [];

  for (const b of parsedBids) {
    if (b.notionalUsdt >= avgLevelNotional * 2.5) {
      whaleWalls.push({
        side: 'BID',
        price: b.price,
        quantity: b.quantity,
        notionalUsdt: Number(b.notionalUsdt.toFixed(0)),
        multipleOfAverage: Number((b.notionalUsdt / avgLevelNotional).toFixed(1)),
      });
    }
  }

  for (const a of parsedAsks) {
    if (a.notionalUsdt >= avgLevelNotional * 2.5) {
      whaleWalls.push({
        side: 'ASK',
        price: a.price,
        quantity: a.quantity,
        notionalUsdt: Number(a.notionalUsdt.toFixed(0)),
        multipleOfAverage: Number((a.notionalUsdt / avgLevelNotional).toFixed(1)),
      });
    }
  }

  return {
    totalBidNotional: Number(totalBidNotional.toFixed(0)),
    totalAskNotional: Number(totalAskNotional.toFixed(0)),
    bidImbalancePct,
    askImbalancePct: Number((100 - bidImbalancePct).toFixed(1)),
    whaleWalls: whaleWalls.sort((a, b) => b.notionalUsdt - a.notionalUsdt).slice(0, 6),
  };
}
```

---

## 5. Fast 48-Hour Hackathon Build Schedule

1. **Hours 1–4 (Base & Skills):**
   * Clone `https://github.com/strike-finance/strike-builder-reference` into `/Users/mrnetwork/Vektor` and install `strike-finance-skills` (`npx strike-finance-skills install`).
   * Verify `ConnectPanel.tsx` Ed25519 API Wallet onboarding and `X-Builder-Fee-Bps` header injection.
2. **Hours 5–16 (Module 1 — CLOB Whale Heatmap & Batch Grid Studio):**
   * Add `gridEngine.ts` and `whaleRadar.ts`.
   * Build the interactive Grid range visualizer on top of the live Strike orderbook stream (`priceStream.ts`) and wire **"Deploy 12-Rung Batch Grid"** + `userStream.ts` auto-replenish loop.
3. **Hours 17–28 (Module 2 — Delta-Neutral Funding Rate Harvester):**
   * Add `fundingHarvester.ts`.
   * Build the live `ADA-USDT`, `BTC-USDT`, `ETH-USDT`, `SOL-USDT` Funding APR Leaderboard with 1-click **TWAP Delta-Neutral Hedge** execution.
4. **Hours 29–40 (Module 3 — Aegis Liquidation Shield & Simulation Replay):**
   * Add `liquidationShield.ts` connected to `usePositions.ts`.
   * Add a **"Simulate Flash Crash (-12%)"** test button so judges can watch the Liquidation Shield automatically cancel exposed buy grids and execute a `25%` reduce-only trim in real time!
5. **Hours 41–48 (Deploy, Polish & Demo Video):**
   * Deploy to Vercel, verify live testnet/mainnet API calls, and record a crisp 2-minute walkthrough highlighting how Vektor multiplies Strike V2 CLOB liquidity and Builder Code fee volume.
