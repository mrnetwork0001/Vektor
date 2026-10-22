import type { Vektor } from "../../hooks/useVektor";
import { formatCurrency } from "../../math/formatUtils";
import { MarketSelector } from "../MarketSelector";
import { API_BASE_URL } from "../../api/config";
import { confirmDialog } from "./ConfirmDialog";

const NETWORK = /testnet/i.test(API_BASE_URL) ? "testnet" : "mainnet";

export type Tab = "grid" | "funding" | "shield";

export function VektorHeader({ v, tab, setTab, builderCode, onTour, tourActive, accountId, vaultId, drawerOpen, onToggleDrawer, onHelp }: { v: Vektor; tab: Tab; setTab: (t: Tab) => void; builderCode: string; onTour: () => void; tourActive: boolean; accountId?: string | null; vaultId?: string | null; drawerOpen?: boolean; onToggleDrawer?: () => void; onHelp?: () => void }) {
  const t = v.telemetry;
  const worst = v.healths.reduce<string>((acc, h) => (h.health === "CRITICAL" ? "CRITICAL" : h.health === "WARNING" && acc !== "CRITICAL" ? "WARNING" : acc), "SAFE");
  return (
    <header className="app-header vk-header">
      <div className="vk-brand">
        <h1><a href="/" title="Back to the landing page" style={{ display: "inline-flex" }}><img src="/brand/vektor-header.png" alt="Vektor" style={{ height: 60, width: "auto", display: "block" }} /></a></h1>
        <span className={`mode-pill ${v.mode}`}>{v.mode === "sim" ? "DEMO" : `LIVE · ${NETWORK}`}</span>
        <MarketSelector symbols={v.symbols} selected={v.symbol} onChange={v.setSymbol} />
        <button className="btn btn-tour" onClick={onTour} disabled={tourActive} title="45-second guided demo">▶ Judge tour</button>
        <button className="btn btn-help" onClick={onHelp} title="Show the app walkthrough" aria-label="Help: show the walkthrough">?</button>
        <button className={`burger-btn ${drawerOpen ? "open" : ""}`} aria-label="Toggle controls" aria-expanded={!!drawerOpen} onClick={onToggleDrawer}><span /><span /><span /></button>
      </div>
      <nav className="vk-tabs" data-tour="tabs">
        {([["grid", "Grid Studio"], ["funding", "Funding Harvester"], ["shield", `Aegis Shield${worst !== "SAFE" ? ` · ${worst}` : ""}`]] as [Tab, string][]).map(([k, label]) => (
          <button key={k} className={`vk-tab ${tab === k ? "active" : ""} ${k === "shield" && worst !== "SAFE" ? worst.toLowerCase() : ""}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>
      <div className="vk-telemetry" title="Builder code revenue telemetry" data-tour="telemetry">
        <span><em>{builderCode}</em> @ {v.fees.builderFeeBps} bps{vaultId ? ` · vault ${vaultId.slice(0, 8)}` : ""}</span>
        <span>vol <b>{formatCurrency(t.volumeUsd)}</b></span>
        <span>fills <b>{t.fills}</b></span>
        <span>builder fees <b className="text-green">{formatCurrency(t.builderFeesUsd)}</b></span>
        {accountId && <a className="btn btn-proof" href={`/proof.html?account=${encodeURIComponent(accountId)}&bps=${v.fees.builderFeeBps}`} target="_blank" rel="noopener" title="Public, verifiable proof of this account's Vektor activity">Proof ↗</a>}
        <button className="btn btn-danger btn-panic" data-tour="panic" onClick={() => void confirmDialog("Cancel every open order on every symbol and close every position with reduce-only market orders. This cannot be undone.", { title: "PANIC - flatten everything?", okLabel: "Flatten everything", danger: true }).then((ok) => { if (ok) void v.panic(); })}>PANIC</button>
      </div>
    </header>
  );
}
