import { useState, useEffect, useMemo } from "react";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { useMarkets } from "./hooks/useMarkets";
import { usePriceStream } from "./hooks/usePriceStream";
import { useUserStream } from "./hooks/useUserStream";
import { useEnrichedPositions } from "./hooks/usePositions";
import { calculateBalances, calculateOpenOrderCosts } from "./math/balanceCalculations";
import { DEFAULT_FEE_RATES, effectiveFeeRates, tierZeroFeeRates, type FeeRates } from "./math/fees";
import { getFeeTiers, getPortfolio } from "./api/account";
import { BUILDER_FEE_BPS } from "./api/config";
import type { ConnectedInfo } from "./components/ConnectPanel";

import { ConnectPanel } from "./components/ConnectPanel";
import { MarketSelector } from "./components/MarketSelector";
import { PriceBar } from "./components/PriceBar";
import { OrderBook } from "./components/OrderBook";
import { OrderForm } from "./components/OrderForm";
import { PositionsTable } from "./components/PositionsTable";
import { AccountPanel } from "./components/AccountPanel";
import { DepositPanel } from "./components/DepositPanel";
import { WithdrawPanel } from "./components/WithdrawPanel";
import { Chart } from "./components/Chart";

export default function App() {
  // All auth state in memory — no localStorage
  const [connectedInfo, setConnectedInfo] = useState<ConnectedInfo | null>(null);
  const accountId = connectedInfo?.accountId ?? null;

  // Per-order builder fee: configured value, capped by the user's approved fee_share_bps
  const builderFeeBps = Math.min(BUILDER_FEE_BPS, connectedInfo?.feeShareBps ?? 0);

  // Listen for session expired (API wallet rejected by the server)
  useEffect(() => {
    const handler = () => {
      console.log("[App] Session expired — resetting to connect screen");
      setConnectedInfo(null);
    };
    window.addEventListener("strike:session-expired", handler);
    return () => window.removeEventListener("strike:session-expired", handler);
  }, []);

  // Market data
  const { markets, symbols } = useMarkets();
  const [symbol, setSymbol] = useState("BTC-USD");
  useEffect(() => {
    if (symbols.length > 0 && !symbols.includes(symbol)) setSymbol(symbols[0]);
  }, [symbols, symbol]);

  // Real-time price stream
  const { prices, markPrice, indexPrice, fundingRate, nextFundingTime, depth } =
    usePriceStream(symbol);

  // User data: REST (re)load after each user-stream subscribe, then WS updates
  const {
    positions,
    orders,
    walletBalance,
    account,
    symbols: symbolSettings,
    refreshSymbols,
  } = useUserStream(accountId);

  // Fee rates: public tier 0 first, then the account's tier (GET /v2/portfolio:
  // fee tier, maker override, referral/staking discounts)
  const [feeRates, setFeeRates] = useState<FeeRates>(DEFAULT_FEE_RATES);
  useEffect(() => {
    getFeeTiers()
      .then((res) => {
        const t0 = tierZeroFeeRates(res);
        if (t0) setFeeRates((prev) => (prev === DEFAULT_FEE_RATES ? t0 : prev));
      })
      .catch((e) => console.warn("[App] /v2/fee-tiers unavailable:", e));
  }, []);
  useEffect(() => {
    if (!accountId) return;
    getPortfolio()
      .then((info) => setFeeRates(effectiveFeeRates(info)))
      .catch((e) => console.warn("[App] Fee rates unavailable, using tier 0:", e));
  }, [accountId]);

  // Enrich positions with derived fields (uPnL, IM, MM, liquidation price, ...)
  const enrichedPositions = useEnrichedPositions(
    positions,
    prices,
    markets,
    walletBalance,
    symbolSettings
  );

  // Effective symbol leverage (GET /v2/symbols) for open-order margin
  const leverageBySymbol = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [sym, s] of Object.entries(symbolSettings?.symbol_settings ?? {})) out[sym] = s.leverage;
    return out;
  }, [symbolSettings]);

  // Open order costs — margin locked by open orders (TotalOrderCost netting formula)
  const openOrderCosts = useMemo(
    () => calculateOpenOrderCosts(orders, enrichedPositions, leverageBySymbol, markets),
    [orders, enrichedPositions, leverageBySymbol, markets]
  );

  // Live balances, same formulas as GET /v2/account (which is a point-in-time snapshot)
  const balances = useMemo(
    () => calculateBalances(walletBalance, enrichedPositions, openOrderCosts),
    [walletBalance, enrichedPositions, openOrderCosts]
  );

  const currentMarket = markets[symbol] ?? null;
  const basePrec = currentMarket?.base_prec ?? 4;

  return (
    <div className="app">
      <ToastContainer
        position="top-right"
        autoClose={4000}
        theme="dark"
        toastStyle={{ background: "#1a1a1a", color: "#fff", fontSize: 13 }}
      />
      <header className="app-header">
        <h1>Strike Builder Reference</h1>
        <MarketSelector
          symbols={symbols.length > 0 ? symbols : [symbol]}
          selected={symbol}
          onChange={setSymbol}
        />
      </header>

      <div className="app-layout">
        <aside className="sidebar">
          <ConnectPanel
            connectedInfo={connectedInfo}
            onConnected={setConnectedInfo}
            onDisconnected={() => setConnectedInfo(null)}
          />

          {connectedInfo && (
            <>
              <AccountPanel
                walletBalance={walletBalance}
                availableBalance={balances.availableBalance}
                marginBalance={balances.marginBalance}
                totalInitialMargin={balances.totalInitialMargin}
                totalUnrealizedPnL={balances.totalUnrealizedPnL}
              />
              <DepositPanel wallet={connectedInfo.wallet} />
              <WithdrawPanel
                wallet={connectedInfo.wallet}
                withdrawableBalance={balances.withdrawableBalance}
              />
            </>
          )}
        </aside>

        <main className="main-content">
          <PriceBar
            symbol={symbol}
            markPrice={markPrice}
            indexPrice={indexPrice}
            fundingRate={fundingRate}
            nextFundingTime={nextFundingTime}
          />

          <Chart symbol={symbol} markPrice={markPrice} />

          <div className="trading-grid">
            <OrderBook
              depth={depth}
              midPrice={markPrice}
              basePrec={basePrec}
            />

            {accountId && (
              <OrderForm
                symbol={symbol}
                market={currentMarket}
                markPrice={markPrice}
                depth={depth}
                positions={enrichedPositions}
                availableBalance={balances.availableBalance}
                accountId={accountId}
                account={account}
                symbolSetting={symbolSettings?.symbol_settings?.[symbol]}
                onSettingsChanged={refreshSymbols}
                feeRates={feeRates}
                builderFeeBps={builderFeeBps}
              />
            )}
          </div>

          <PositionsTable
            positions={enrichedPositions}
            basePrec={basePrec}
            markets={markets}
            prices={prices}
            feeRates={feeRates}
            builderFeeBps={builderFeeBps}
          />
        </main>
      </div>
    </div>
  );
}
