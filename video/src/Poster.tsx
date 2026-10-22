import React from "react";
import { AbsoluteFill } from "remotion";
import { C, sans, serif, mono } from "./theme";
import { Glow, Ladder, Logo, Lockup, Mark } from "./scenes/common";

/** YouTube thumbnail: the lockup, one big line, the crosshair locking a fill on the ladder. */
export const Poster: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg, fontFamily: sans, color: "#fff", overflow: "hidden" }}>
    <Ladder f={40} opacity={0.5} levels={7} top={200} height={760} />
    <Glow x="74%" y="52%" color="rgba(37,250,176,0.28)" size="32% 40%" />
    <Mark size={560} style={{ position: "absolute", left: 1090, top: 270, transform: "none" }} />
    <div style={{ position: "absolute", left: 90, top: 70 }}><Lockup width={640} /></div>
    <div style={{ position: "absolute", left: 96, top: 360, fontSize: 150, fontWeight: 800, letterSpacing: "-0.05em", lineHeight: 0.95, textShadow: "0 6px 40px rgba(0,0,0,0.8)" }}>
      Paid on<br /><span style={{ fontFamily: serif, fontStyle: "italic", fontWeight: 400, color: C.mint, fontSize: 176 }}>every fill.</span>
    </div>
    <div style={{ position: "absolute", left: 100, top: 790, fontFamily: mono, fontSize: 44, color: "rgba(255,255,255,0.85)" }}>Grid bot · Funding · Autopilot</div>
    <div style={{ position: "absolute", left: 100, bottom: 70, display: "flex", alignItems: "center", gap: 18, fontSize: 32, color: "rgba(255,255,255,0.7)" }}>Built on <Logo name="strike" h={40} /></div>
  </AbsoluteFill>
);
