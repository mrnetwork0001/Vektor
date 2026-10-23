import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import chart from "../data/banner-chart.json";
import onchain from "../data/onchain.json";
import { C, display, mono, sans } from "./theme";

/**
 * Submission banner (1920x1080). Real content only: five mainnet receipts read from data/onchain.json
 * (three deposits, the builder-connected grid fill, the Autopilot fill) over the real hourly ADA-USD
 * closes on Strike for the hackathon window (data/banner-chart.json).
 */

const S = onchain.strike;
const ethFill = S.eth.fills.find((f) => f.side === "sell")!;
const autoFill = S.ada.fills[S.ada.fills.length - 1];
const hhmmss = (utc: string) => utc.slice(11, 19);

type Card = {
  key: string; title: string; logo?: string; rows: [string, string][]; foot: string;
  x: number; y: number; w: number; rot: number; z: number; accent?: boolean; badge?: string;
};

const CARDS: Card[] = [
  { key: "eth", title: "Deposit", logo: "ethereum.svg", rows: [["Chain", "Ethereum"], ["Amount", "16 USDC"]], foot: `BLOCK ${onchain.chain.eth.deposit.block}`, x: 1000, y: 580, w: 230, rot: -14, z: 1 },
  { key: "ada", title: "Deposit", logo: "cardano-white.svg", rows: [["Chain", "Cardano"], ["Amount", "95 ADA"]], foot: `BLOCK ${onchain.chain.ada.deposit.block}`, x: 1775, y: 580, w: 230, rot: 14, z: 1 },
  { key: "sol", title: "Deposit", logo: "solana.svg", rows: [["Chain", "Solana"], ["Amount", "5 USDC"]], foot: `SLOT ${onchain.chain.sol.deposit.slot}`, x: 1175, y: 535, w: 260, rot: -7, z: 2 },
  { key: "auto", title: "Autopilot fill", rows: [["Side", `BUY ${autoFill.size} ADA`], ["Price", String(autoFill.price)], ["Tab", "closed"]], foot: `${hhmmss(autoFill.utc)} UTC · MAKER`, x: 1600, y: 535, w: 260, rot: 7, z: 2 },
  { key: "grid", title: "Grid fill", rows: [["Side", `SELL ${ethFill.size} ADA`], ["Price", String(ethFill.price)], ["Builder", `vektor · ${onchain.builder.fee_bps} bps`]], foot: `${hhmmss(ethFill.utc)} UTC · MAKER`, x: 1388, y: 520, w: 300, rot: 0, z: 3, accent: true, badge: "builder fee paid" },
];

const Receipt: React.FC<{ c: Card }> = ({ c }) => {
  const u = c.w / 100;
  return (
    <div style={{ position: "absolute", left: c.x - c.w / 2, top: c.y - c.w * 0.62, width: c.w, zIndex: c.z, transform: `rotate(${c.rot}deg)` }}>
      <div style={{
        width: c.w, height: c.w * 1.24, borderRadius: 8 * u, boxSizing: "border-box", padding: `${8 * u}px ${8 * u}px`,
        background: "linear-gradient(180deg, #17191c, #0d0e10)", display: "flex", flexDirection: "column", textAlign: c.rot > 0 ? "right" : "left",
        boxShadow: `0 0 0 ${c.accent ? 3 : 2}px ${c.accent ? C.mint : "rgba(255,255,255,0.16)"}, 0 40px 80px rgba(0,0,0,0.6)${c.accent ? ", 0 0 120px rgba(37,250,176,0.35)" : ""}`,
      }}>
        <div style={{ display: "flex", flexDirection: c.rot > 0 ? "row-reverse" : "row", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontFamily: display, fontWeight: 700, fontSize: 10 * u, letterSpacing: "-0.02em", color: "#fff", whiteSpace: "nowrap" }}>{c.title}</span>
          {c.logo
            ? <Img src={staticFile(`logos/${c.logo}`)} style={{ height: 11 * u, width: "auto" }} />
            : null}
        </div>
        <div style={{ height: 1, background: "rgba(255,255,255,0.12)", margin: `${6 * u}px 0` }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 5 * u, flex: 1 }}>
          {c.rows.map(([k, v]) => (
            <div key={k}>
              <div style={{ fontFamily: mono, fontSize: 4.4 * u, letterSpacing: "0.1em", color: C.faint, textTransform: "uppercase" }}>{k}</div>
              <div style={{ fontFamily: mono, fontWeight: 500, fontSize: 8 * u, color: k === "Builder" || k === "Tab" ? C.mint : "#fff", whiteSpace: "nowrap" }}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{ fontFamily: mono, fontSize: 4.6 * u, letterSpacing: "0.08em", color: c.accent ? C.mint : C.muted, whiteSpace: "nowrap" }}>{c.foot}</div>
      </div>
      {c.badge ? (
        <div style={{
          position: "absolute", left: "50%", top: -78, transform: "translateX(-50%)", whiteSpace: "nowrap",
          padding: "10px 22px", borderRadius: 999, background: "rgba(10,10,10,0.92)", border: `3px solid ${C.mint}`,
          fontFamily: mono, fontWeight: 500, fontSize: 30, color: C.mint, boxShadow: "0 14px 34px rgba(0,0,0,0.55)",
        }}>{c.badge}</div>
      ) : null}
    </div>
  );
};

/** The real ADA-USD price line on Strike, faint, under the receipts. */
const PriceLine: React.FC = () => {
  const raw = chart.n as number[];
  const n = raw.map((_, i) => { const w = raw.slice(Math.max(0, i - 1), i + 2); return w.reduce((a, b) => a + b, 0) / w.length; });
  const x0 = 1190, x1 = 1920, yTop = 800, yBot = 990;
  const pts = n.map((v, i) => [x0 + (i / (n.length - 1)) * (x1 - x0), yBot - v * (yBot - yTop)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0 }}>
      <defs>
        <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={C.mint} stopOpacity="0.2" />
          <stop offset="1" stopColor={C.mint} stopOpacity="0" />
        </linearGradient>
        <linearGradient id="fadeMask" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.3" stopColor="#fff" stopOpacity="1" />
        </linearGradient>
        <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={C.mint} stopOpacity="0" />
          <stop offset="0.2" stopColor={C.mint} stopOpacity="0.7" />
          <stop offset="1" stopColor={C.mint} stopOpacity="1" />
        </linearGradient>
      </defs>
      <mask id="m"><rect x={x0} y={0} width={x1 - x0} height={1080} fill="url(#fadeMask)" /></mask>
      <path d={`${d} L ${x1} 1080 L ${x0} 1080 Z`} fill="url(#fill)" mask="url(#m)" />
      <path d={d} fill="none" stroke="url(#fade)" strokeWidth={4} strokeLinejoin="round" style={{ filter: "drop-shadow(0 0 10px rgba(37,250,176,0.6))" }} />
    </svg>
  );
};

const Chip: React.FC<{ logos?: [string, number][]; text: string }> = ({ logos = [], text }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 14, height: 70, padding: "0 26px", borderRadius: 999, background: "rgba(255,255,255,0.06)", border: "2px solid rgba(255,255,255,0.14)", boxSizing: "border-box" }}>
    {logos.map(([l, h]) => <Img key={l} src={staticFile(`logos/${l}`)} style={{ height: h, width: "auto" }} />)}
    <span style={{ fontFamily: sans, fontWeight: 600, fontSize: 28, color: "rgba(255,255,255,0.88)", whiteSpace: "nowrap" }}>{text}</span>
  </div>
);

export const Banner: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg, color: "#fff", overflow: "hidden" }}>
    <AbsoluteFill style={{ background: "radial-gradient(45% 60% at 74% 45%, rgba(37,250,176,0.20), rgba(37,250,176,0.06) 55%, transparent 78%)" }} />
    <AbsoluteFill style={{ background: "radial-gradient(35% 45% at 8% 10%, rgba(37,250,176,0.08), transparent 70%)" }} />
    <PriceLine />
    {CARDS.map((c) => <Receipt key={c.key} c={c} />)}
    <div style={{ position: "absolute", right: 48, bottom: 36, fontFamily: mono, fontSize: 18, letterSpacing: "0.08em", color: "rgba(37,250,176,0.75)", whiteSpace: "nowrap" }}>
      REAL ADA-USD ON STRIKE · {chart.from.toUpperCase()} – {chart.to.toUpperCase()}
    </div>

    <Img src={staticFile("logos/vektor-lockup.png")} style={{ position: "absolute", left: 104, top: 96, height: 120 }} />
    <div style={{ position: "absolute", left: 104, top: 318, width: 900, fontFamily: display, fontWeight: 800, fontSize: 124, lineHeight: 0.95, letterSpacing: "-0.05em" }}>
      Paid on<br /><span style={{ color: C.mint, textShadow: "0 0 50px rgba(37,250,176,0.45)" }}>every fill.</span>
    </div>
    <div style={{ position: "absolute", left: 108, top: 600, width: 780, fontFamily: sans, fontWeight: 500, fontSize: 40, lineHeight: 1.3, color: "rgba(255,255,255,0.78)" }}>
      Grids, funding carry and a liquidation shield on Strike perps. Autopilot keeps trading after you close the tab.
    </div>
    <div style={{ position: "absolute", left: 104, top: 880, display: "flex", gap: 16 }}>
      <Chip logos={[["strike-white.svg", 30]]} text="mainnet" />
      <Chip text="Builder code vektor" />
      <Chip logos={[["ethereum.svg", 30], ["solana.svg", 24], ["cardano-white.svg", 30]]} text="deposits" />
    </div>
  </AbsoluteFill>
);
