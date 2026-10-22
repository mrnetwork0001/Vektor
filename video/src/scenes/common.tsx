import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { scene, wordAt } from "../timing";
import { C, display, mono, sans } from "../theme";
import { clamp, expo, pop } from "../ui/motion";
import onchain from "../../data/onchain.json";

/** Scene-local frame and word cues: rel("word", n) is when the nth "word" is spoken, scene-local. */
export function useCue(id: string) {
  const s = scene(id);
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => wordAt(id, w, n) - s.from;
  return { s, f, rel, dur: s.durationInFrames };
}

export const Fill: React.FC<{ bg: string; children: React.ReactNode; color?: string }> = ({ bg, children, color = "#fff" }) => (
  <AbsoluteFill style={{ background: bg, fontFamily: sans, color, overflow: "hidden" }}>{children}</AbsoluteFill>
);

/** Small mono kicker with the app's teal dot. */
export const Kicker: React.FC<{ children: React.ReactNode; color?: string; dot?: string; size?: number; style?: React.CSSProperties }> = ({ children, color = "rgba(255,255,255,0.6)", dot = C.teal, size = 16, style }) => (
  <div style={{ fontFamily: mono, fontSize: size, letterSpacing: "0.16em", textTransform: "uppercase", color, display: "flex", alignItems: "center", gap: 12, ...style }}>
    <span style={{ width: 8, height: 8, borderRadius: 4, background: dot, boxShadow: `0 0 10px ${dot}` }} />{children}
  </div>
);

/** Fade, rise and un-blur for any block. */
export const In: React.FC<{ at: number; dur?: number; y?: number; x?: number; children: React.ReactNode; style?: React.CSSProperties; out?: number }> = ({ at, dur = 16, y = 26, x = 0, children, style, out }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [at, at + dur], [0, 1], { ...clamp, easing: expo });
  const o = out != null ? interpolate(f, [out, out + 10], [1, 0], clamp) : 1;
  return <div style={{ opacity: p * o, transform: `translate(${(1 - p) * x}px, ${(1 - p) * y}px)`, filter: p < 1 ? `blur(${(1 - p) * 7}px)` : undefined, ...style }}>{children}</div>;
};

/** A glass card that pops in at `at`. */
export const Card: React.FC<{ at: number; left: number; top: number; width: number; light?: boolean; accent?: string; children: React.ReactNode; style?: React.CSSProperties; out?: number }> = ({ at, left, top, width, light, accent = C.teal, children, style, out }) => {
  const f = useCurrentFrame();
  const p = pop(f, at);
  const o = interpolate(f, [at, at + 8], [0, 1], clamp) * (out != null ? interpolate(f, [out, out + 10], [1, 0], clamp) : 1);
  return (
    <div style={{
      position: "absolute", left, top, width, opacity: o, transform: `translateY(${(1 - p) * 28}px) scale(${0.94 + 0.06 * p})`, transformOrigin: "50% 100%",
      background: light ? "rgba(255,255,255,0.9)" : "rgba(23,22,29,0.9)", color: light ? C.paperInk : "#fff", padding: "22px 26px", borderRadius: 20,
      boxShadow: light ? "0 0 0 1px rgba(13,12,17,0.08), 0 26px 60px rgba(40,20,90,0.14)" : "0 0 0 1px rgba(255,255,255,0.1), 0 30px 70px rgba(0,0,0,0.5)",
      borderTop: `3px solid ${accent}`, fontFamily: sans, backdropFilter: "blur(16px)", ...style,
    }}>{children}</div>
  );
};

/** A short tx hash chip. */
export const short = (h: string, a = 10, b = 8) => `${h.slice(0, a)}…${h.slice(-b)}`;
export const Hash: React.FC<{ h: string; color?: string; size?: number }> = ({ h, color = C.teal, size = 18 }) => (
  <span style={{ fontFamily: mono, fontSize: size, color, letterSpacing: "0.02em" }}>{short(h)}</span>
);

/** "22:41:25 UTC" from an ISO time. */
export const utc = (iso: string) => `${iso.slice(11, 19)} UTC`;
export const blockStr = (n: number) => n.toLocaleString("en-US");

/** A big headline in DM Sans. */
export const Head: React.FC<{ children: React.ReactNode; size?: number; style?: React.CSSProperties }> = ({ children, size = 92, style }) => (
  <div style={{ fontFamily: display, fontWeight: 600, fontSize: size, letterSpacing: "-0.04em", lineHeight: 1.04, ...style }}>{children}</div>
);

/** Scene-local start frame of line i. */
export const lineStartLocal = (s: { from: number; lines: { startFrame: number }[] }, i: number) => s.lines[i].startFrame - s.from;

/** Read-back of the mainnet run (scripts/onchain.mjs). */
export const OC = onchain as unknown as {
  builder: { code: string; fee_bps: number };
  chain: {
    eth: { deposit: { hash: string; block: number; utc: string; usdc_transfers: { amount: number }[] } };
    sol: { deposit: { signature: string; slot: number; utc: string; token_deltas: { delta: number }[] } };
    ada: { deposit: Record<string, unknown> & { utc?: string; block?: number; hash?: string } };
  };
  strike: Record<string, { fills: { utc: string; side: string; size: number; price: number; role: string; client_order_id?: string }[]; open_orders: { side: string; size: number; price: number; client_order_id: string; builder: { Code: string; FeeBps: number } }[] }>;
  autopilot: { ok: boolean; tenants: number; markets: number };
};
export const fillAt = (acct: string, hhmmss: string) => {
  const x = OC.strike[acct].fills.find((f) => f.utc.slice(11, 19) === hhmmss);
  if (!x) throw new Error(`no fill ${acct} ${hhmmss}`);
  return x;
};

/** Official logos, unaltered (public/logos, sources in README). */
const LOGO = { strike: "logos/strike-white.svg", ethereum: "logos/ethereum.svg", solana: "logos/solana.svg", cardano: "logos/cardano-white.svg", cardanoBlue: "logos/cardano-blue.svg" } as const;
export const Logo: React.FC<{ name: keyof typeof LOGO; h: number; style?: React.CSSProperties }> = ({ name, h, style }) => (
  <Img src={staticFile(LOGO[name])} style={{ height: h, width: "auto", display: "block", ...style }} />
);

/** Vektor's mark (public/logos/vektor-mark.png, black ground, screened onto the scene). */
export const Mark: React.FC<{ size: number; p?: number; style?: React.CSSProperties }> = ({ size, p = 1, style }) => (
  <Img src={staticFile("logos/vektor-mark.png")} style={{ width: size, height: size, mixBlendMode: "screen", opacity: p, transform: `scale(${0.6 + 0.4 * p}) rotate(${(1 - p) * -90}deg)`, ...style }} />
);
/** The full lockup: mark + VEKTOR + PRECISION EXECUTION, revealed left to right. */
export const Lockup: React.FC<{ width: number; p?: number }> = ({ width, p = 1 }) => (
  <Img src={staticFile("logos/vektor-lockup.png")} style={{ width, height: "auto", clipPath: `inset(0 ${(1 - p) * 100}% 0 0)`, transform: `scale(${0.94 + 0.06 * p})`, filter: `drop-shadow(0 0 ${30 * p}px rgba(37,250,176,0.35))` }} />
);

/**
 * The motif: a grid ladder. Horizontal order levels, a price line wandering across them,
 * rungs lighting up as the price touches them. `lit` 0..1 scales how many rungs have filled.
 */
export const Ladder: React.FC<{ f: number; levels?: number; opacity?: number; lit?: number; top?: number; height?: number; speed?: number }> = ({ f, levels = 9, opacity = 1, lit = 1, top = 140, height = 800, speed = 1 }) => {
  const W = 1920, gap = height / (levels - 1);
  const yAt = (x: number) => top + height / 2 + Math.sin((x + f * 6 * speed) / 210) * height * 0.28 + Math.sin((x + f * 3 * speed) / 77) * gap * 0.35;
  const pts = Array.from({ length: 97 }, (_, i) => { const x = (i / 96) * W; return `${x.toFixed(0)},${yAt(x).toFixed(1)}`; }).join(" ");
  const head = yAt(W * 0.72);
  return (
    <svg width={W} height={1080} style={{ position: "absolute", left: 0, top: 0, opacity }}>
      {Array.from({ length: levels }, (_, i) => {
        const y = top + i * gap;
        const near = Math.max(0, 1 - Math.abs(head - y) / (gap * 0.6));
        const on = i / (levels - 1) <= lit || near > 0.2;
        const buy = y > top + height / 2;
        const col = buy ? C.mint : C.red;
        return (
          <g key={i}>
            <line x1={0} x2={W} y1={y} y2={y} stroke={on ? col : "rgba(255,255,255,0.18)"} strokeOpacity={on ? 0.25 + 0.6 * near : 1} strokeWidth={1.4} strokeDasharray={on ? undefined : "4 8"} />
            {near > 0 ? <circle cx={W * 0.72} cy={y} r={6 + 10 * near} fill={col} opacity={0.5 * near} /> : null}
          </g>
        );
      })}
      <polyline points={pts} fill="none" stroke="#fff" strokeWidth={2.2} strokeOpacity={0.85} />
      <circle cx={W * 0.72} cy={head} r={7} fill="#fff" />
      <g stroke={C.mint} strokeWidth={2} fill="none" opacity={0.9}>
        <circle cx={W * 0.72} cy={head} r={26} />
        <path d={`M${W * 0.72 - 50} ${head}h18M${W * 0.72 + 32} ${head}h18`} />
      </g>
    </svg>
  );
};

/** A glow pool for dark scenes. */
export const Glow: React.FC<{ x: string; y: string; color?: string; size?: string }> = ({ x, y, color = "rgba(37,250,176,0.16)", size = "45% 40%" }) => (
  <AbsoluteFill style={{ background: `radial-gradient(${size} at ${x} ${y}, ${color}, transparent 70%)` }} />
);
