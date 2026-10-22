import { useState, useEffect, useMemo } from "react";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { useMarkets } from "./hooks/useMarkets";
import { usePriceStream } from "./hooks/usePriceStream";
import { useUserStream } from "./hooks/useUserStream";
import { useEnrichedPositions } from "./hooks/usePositions";
import { useVektor } from "./hooks/useVektor";
import { DEFAULT_FEE_RATES, effectiveFeeRates, tierZeroFeeRates, type FeeRates } from "./math/fees";
import { getFeeTiers, getPortfolio } from "./api/account";
import { BUILDER_CODE, BUILDER_FEE_BPS } from "./api/config";
import type { ConnectedInfo } from "./components/ConnectPanel";

import { ConnectPanel } from "./components/ConnectPanel";
import { AccountPanel } from "./components/AccountPanel";
import { DepositPanel } from "./components/DepositPanel";
import { PositionsTable } from "./components/PositionsTable";
import { VektorHeader, type Tab } from "./components/quant/VektorHeader";
import { GridStudio } from "./components/quant/GridStudio";
import { FundingHarvester } from "./components/quant/FundingHarvester";
import { ShieldPanel } from "./components/quant/ShieldPanel";
import { SimControls } from "./components/quant/SimControls";
import { ActiveGrids } from "./components/quant/ActiveGrids";
import { TourOverlay, useJudgeTour } from "./components/quant/JudgeTour";
import { ConfirmHost } from "./components/quant/ConfirmDialog";
import { Walkthrough, shouldAutoStart } from "./components/quant/Walkthrough";
import { RegimePanel } from "./components/quant/RegimePanel";
import { VaultPanel } from "./components/quant/VaultPanel";
import { useRegime } from "./hooks/useRegime";
import { calculateBalances, calculateOpenOrderCosts } from "./math/balanceCalculations";

export default function App() {
  const [connectedInfo, setConnectedInfo] = useState<ConnectedInfo | null>(null);
  const accountId = connectedInfo?.accountId ?? null;
  const builderFeeBps = Math.min(BUILDER_FEE_BPS, connectedInfo?.feeShareBps ?? 0);
  const [tab, setTab] = useState<Tab>("grid");
  const [vaultId, setVaultId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [walkthrough, setWalkthrough] = useState(() => shouldAutoStart());
  useEffect(() => { setDrawer(false); }, [tab]);
  const [guardOn, setGuardOn] = useState(true);
  const [fundingBySymbol, setFundingBySymbol] = useState<Record<string, number>>({});
  const [symbolsForRegime, setSymbolsForRegime] = useState<string[]>(["ADA-USD", "BTC-USD", "ETH-USD", "SOL-USD"]);
  const regime = useRegime(symbolsForRegime, fundingBySymbol, true);

  useEffect(() => {
    const handler = () => { setConnectedInfo(null); setVaultId(null); };
    window.addEventListener("strike:session-expired", handler);
    return () => window.removeEventListener("strike:session-expired", handler);
  }, []);

  // ── Live data (reference hooks) ──
  const { markets } = useMarkets();
  const [liveSymbol, setLiveSymbol] = useState("ADA-USD");
  const { prices, depth } = usePriceStream(liveSymbol);
  const { positions, orders, walletBalance, symbols: symbolSettings, isLoading: ordersLoading, loadedOnce: ordersLoaded } = useUserStream(accountId);

  const [feeRates, setFeeRates] = useState<FeeRates>(DEFAULT_FEE_RATES);
  useEffect(() => {
    getFeeTiers().then((res) => { const t0 = tierZeroFeeRates(res); if (t0) setFeeRates((p) => (p === DEFAULT_FEE_RATES ? t0 : p)); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!accountId) return;
    getPortfolio().then((info) => setFeeRates(effectiveFeeRates(info))).catch(() => {});
  }, [accountId]);

  const enrichedPositions = useEnrichedPositions(positions, prices, markets, walletBalance, symbolSettings);
  const leverageBySymbol = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [sym, s] of Object.entries(symbolSettings?.symbol_settings ?? {})) out[sym] = s.leverage;
    return out;
  }, [symbolSettings]);
  const openOrderCosts = useMemo(() => calculateOpenOrderCosts(orders, enrichedPositions, leverageBySymbol, markets), [orders, enrichedPositions, leverageBySymbol, markets]);
  const balances = useMemo(() => calculateBalances(walletBalance, enrichedPositions, openOrderCosts), [walletBalance, enrichedPositions, openOrderCosts]);

  // ── Vektor engines (sim or live through the same code) ──
  const v = useVektor({ accountId, markets, prices, depth, positions: enrichedPositions, openOrders: orders, ordersLoading, ordersLoaded, walletBalance, feeRates, builderFeeBps, vaultId, regime: guardOn ? regime.assessments : {} });
  useEffect(() => { setLiveSymbol(v.symbol); }, [v.symbol]);
  // Keyed so a new array/object identity per render cannot loop the regime inputs.
  const fundingKey = v.fundingSnapshots.map((s) => `${s.symbol}:${s.fundingRateHourly.toFixed(8)}`).join(",");
  const symbolsKey = v.symbols.join(",");
  useEffect(() => {
    const next = Object.fromEntries(fundingKey.split(",").filter(Boolean).map((kv) => { const [s, r] = kv.split(":"); return [s, parseFloat(r)]; }));
    setFundingBySymbol((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [fundingKey]);
  useEffect(() => { setSymbolsForRegime((prev) => (prev.join(",") === symbolsKey ? prev : symbolsKey.split(","))); }, [symbolsKey]);
  useEffect(() => { if (v.mode === "sim") setVaultId(null); }, [v.mode]);
  const tour = useJudgeTour(v, setTab);

  return (
    <div className="app">
      <ToastContainer position="top-right" autoClose={4000} theme="dark" toastStyle={{ background: "#1a1a1a", color: "#fff", fontSize: 13 }} />
      <VektorHeader v={v} tab={tab} setTab={setTab} builderCode={connectedInfo?.builderCode ?? BUILDER_CODE} onTour={() => void tour.start()} tourActive={tour.active} accountId={accountId} vaultId={vaultId} drawerOpen={drawer} onToggleDrawer={() => setDrawer((d) => !d)} onHelp={() => { setDrawer(false); setWalkthrough(true); }} />
      <Walkthrough open={walkthrough} onClose={() => setWalkthrough(false)} setTab={setTab} />
      <TourOverlay tour={tour} />
      <ConfirmHost />

      <div className="app-layout">
        <button className={`drawer-backdrop ${drawer ? "show" : ""}`} aria-label="Close menu" onClick={() => setDrawer(false)} />
        <aside className={`sidebar ${drawer ? "open" : ""}`}>
          <div className="drawer-head"><span>Controls</span><button className="btn btn-secondary" onClick={() => setDrawer(false)}>Close</button></div>
          <div className="panel" data-tour="mode">
            <h3>Execution mode</h3>
            <div className="side-toggle">
              <button className={`btn ${v.mode === "sim" ? "active" : ""}`} onClick={() => v.switchMode("sim")}>Demo</button>
              <button className={`btn ${v.mode === "live" ? "active" : ""}`} onClick={() => v.switchMode("live")}>Live</button>
            </div>
            {v.mode === "live" && !accountId && <p className="text-xs text-secondary" style={{ marginTop: 8 }}>Connect a wallet to trade. Market data is already live.</p>}
          </div>
          <RegimePanel regime={regime} symbol={v.symbol} enabled={guardOn} setEnabled={setGuardOn} />
          <ActiveGrids v={v} />
          {v.mode === "sim" ? <SimControls v={v} /> : (
            <>
              <ConnectPanel connectedInfo={connectedInfo} onConnected={setConnectedInfo} onDisconnected={() => { setConnectedInfo(null); setVaultId(null); }} />
              {connectedInfo && (
                <>
                  <VaultPanel accountId={accountId} vaultId={vaultId} setVaultId={setVaultId} />
                  <AccountPanel walletBalance={walletBalance} availableBalance={balances.availableBalance} marginBalance={balances.marginBalance} totalInitialMargin={balances.totalInitialMargin} totalUnrealizedPnL={balances.totalUnrealizedPnL} />
                  {connectedInfo.wallet.walletId !== "api-key" && <DepositPanel wallet={connectedInfo.wallet} />}
                </>
              )}
            </>
          )}
          {v.error && <div className="panel error-panel"><div className="error">{v.error}</div><button className="btn btn-secondary" onClick={v.clearError}>dismiss</button></div>}
        </aside>

        <main className="main-content">
          {tab === "grid" && <GridStudio v={v} accountId={accountId} />}
          {tab === "funding" && <FundingHarvester v={v} wallet={connectedInfo?.wallet ?? null} />}
          {tab === "shield" && <ShieldPanel v={v} />}
          <PositionsTable positions={v.positions} basePrec={4} markets={v.markets} prices={prices} feeRates={feeRates} builderFeeBps={v.fees.builderFeeBps} />
        </main>
      </div>
    </div>
  );
}
