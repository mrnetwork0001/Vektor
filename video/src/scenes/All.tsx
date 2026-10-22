import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import { C, display, mono, sans, serif } from "../theme";
import { clamp, expo, pop } from "../ui/motion";
import { Words } from "../ui/Words";
import { Browser } from "../ui/Footage";
import { Lockup, Mark, Card, Fill, Glow, Head, In, Kicker, Ladder, Logo, OC, fillAt, short, useCue, utc } from "./common";

const DEMO = { tag: "Demo mode", tagColor: C.amber };
const LIVE = { tag: "Live · mainnet", tagColor: C.mint };
const APP = "tryvektor.vercel.app/app.html";
const usd = (n: number, d = 5) => n.toFixed(d);

/** Mono label + value row inside a card. */
const Row: React.FC<{ k: string; v: React.ReactNode; color?: string }> = ({ k, v, color = "#fff" }) => (
  <div style={{ display: "flex", justifyContent: "space-between", gap: 24, fontFamily: mono, fontSize: 19, padding: "5px 0", color: "rgba(255,255,255,0.55)" }}>
    <span>{k}</span><span style={{ color }}>{v}</span>
  </div>
);
/** A small caption under a Browser frame. */
const Note: React.FC<{ at: number; children: React.ReactNode; top?: number }> = ({ at, children, top = 978 }) => (
  <In at={at} style={{ position: "absolute", left: 0, right: 0, top, textAlign: "center", fontFamily: mono, fontSize: 17, letterSpacing: "0.08em", color: "rgba(255,255,255,0.5)" }}>{children}</In>
);

// 1 ─ The problem: four quiet losses, over a dim ladder that nobody is running.
export const Problem: React.FC = () => {
  const { f, rel } = useCue("problem");
  const items: [string, string, string][] = [
    ["Sideways", "Sideways markets", "go unharvested"],
    ["Funding", "Hourly funding", "never collected"],
    ["Liquidations", "Liquidations", "while nobody watches"],
    ["tab", "The tab closes", "and the bot stops"],
  ];
  return (
    <Fill bg={C.bg}>
      <Ladder f={f} opacity={0.35} lit={0} speed={0.6} />
      <Glow x="50%" y="30%" color="rgba(244,63,94,0.10)" />
      <div style={{ position: "absolute", left: 140, top: 150, width: 1640 }}>
        <Kicker dot={C.red}>Perpetuals, today</Kicker>
        <Head size={88} style={{ marginTop: 26 }}><Words text="Perps traders lose money four quiet ways." at={rel("Perps") - 4} every={3} accent={{ "quiet": C.red }} /></Head>
      </div>
      {items.map(([cue, a, b], i) => (
        <Card key={cue} at={rel(cue) - 6} left={140 + i * 418} top={560} width={380} accent={C.red}>
          <div style={{ fontFamily: mono, fontSize: 16, color: C.red, letterSpacing: "0.12em" }}>0{i + 1}</div>
          <div style={{ fontSize: 34, fontWeight: 600, marginTop: 14, letterSpacing: "-0.02em" }}>{a}</div>
          <div style={{ fontSize: 24, color: "rgba(255,255,255,0.6)", marginTop: 6 }}>{b}</div>
        </Card>
      ))}
    </Fill>
  );
};

// 2 ─ Why Strike: logo, then fact chips in sync, then the three chain logos.
export const Strike: React.FC = () => {
  const { f, rel } = useCue("strike");
  const chips: [string, string][] = [["central", "Central limit order book"], ["Funding", "Funding every hour"], ["Builder", "Builder codes pay the integrator"], ["Trading", "API keys can't withdraw"]];
  const chains: [string, "cardano" | "ethereum" | "solana", string][] = [["Cardano,", "cardano", "Cardano"], ["Ethereum", "ethereum", "Ethereum"], ["Solana", "solana", "Solana"]];
  const lp = interpolate(f, [rel("Strike") - 6, rel("Strike") + 16], [0, 1], { ...clamp, easing: expo });
  return (
    <Fill bg={C.bg}>
      <Glow x="50%" y="22%" color="rgba(37,250,176,0.16)" size="50% 40%" />
      <div style={{ position: "absolute", left: 0, right: 0, top: 120, display: "flex", justifyContent: "center", opacity: lp, transform: `scale(${0.9 + 0.1 * lp})` }}>
        <Logo name="strike" h={92} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 268, textAlign: "center" }}>
        <Head size={64}><Words text="The right place to fix it." at={rel("right") - 4} every={3} accent={{ "fix": C.mint }} /></Head>
      </div>
      <div style={{ position: "absolute", left: 160, right: 160, top: 450, display: "flex", flexWrap: "wrap", gap: 22, justifyContent: "center" }}>
        {chips.map(([cue, t]) => {
          const p = pop(f, rel(cue) - 4);
          return (
            <div key={cue} style={{ opacity: Math.min(1, p * 1.4), transform: `scale(${0.85 + 0.15 * p})`, padding: "18px 30px", borderRadius: 999, background: "rgba(37,250,176,0.08)", boxShadow: `0 0 0 1px rgba(37,250,176,0.4)`, fontSize: 32, fontWeight: 500, display: "flex", alignItems: "center", gap: 14 }}>
              {cue === "Builder" ? <Logo name="strike" h={22} /> : <span style={{ width: 10, height: 10, borderRadius: 5, background: C.mint }} />}{t}
            </div>
          );
        })}
      </div>
      <In at={rel("Deposits") - 4} style={{ position: "absolute", left: 0, right: 0, top: 690, textAlign: "center", fontFamily: mono, fontSize: 20, letterSpacing: "0.16em", color: "rgba(255,255,255,0.55)" }}>DEPOSITS FROM</In>
      <div style={{ position: "absolute", left: 0, right: 0, top: 750, display: "flex", justifyContent: "center", gap: 120 }}>
        {chains.map(([cue, logo, name]) => {
          const p = pop(f, rel(cue) - 4);
          return (
            <div key={cue} style={{ opacity: Math.min(1, p * 1.4), transform: `translateY(${(1 - p) * 30}px)`, display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
              <div style={{ height: 110, display: "flex", alignItems: "center" }}><Logo name={logo} h={logo === "ethereum" ? 110 : 84} /></div>
              <div style={{ fontSize: 26, fontWeight: 500 }}>{name}</div>
            </div>
          );
        })}
      </div>
    </Fill>
  );
};

// 3 ─ The gap: which Strike order paths carry a builder code.
export const Gap: React.FC = () => {
  const { f, rel } = useCue("gap");
  const rows: [string, string, boolean, number][] = [
    ["Batch orders via the API", "builder code attached", true, 4],
    ["Strike's native grid bot", "no builder code", false, rel("grid") - 4],
    ["Strike's TWAP", "no builder code", false, rel("TWAP") - 4],
  ];
  const big = rel("Every") - 6;
  return (
    <Fill bg={C.paper} color={C.paperInk}>
      <div style={{ position: "absolute", left: 220, top: 130, display: "flex", alignItems: "center", gap: 20 }}>
        <div style={{ background: C.bg, padding: "10px 18px", borderRadius: 12 }}><Logo name="strike" h={30} /></div>
        <Kicker color="rgba(10,10,10,0.55)" dot={C.red}>order path · builder fee</Kicker>
      </div>
      <div style={{ position: "absolute", left: 220, top: 230, width: 1480 }}>
        {rows.map(([a, b, ok, at]) => {
          const p = interpolate(f, [at, at + 14], [0, 1], { ...clamp, easing: expo });
          const flash = ok ? 0 : interpolate(f, [at + 10, at + 18, at + 34], [0, 1, 0.25], clamp);
          return (
            <div key={a} style={{ opacity: p, transform: `translateX(${(1 - p) * -40}px)`, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "26px 34px", marginBottom: 18, borderRadius: 18, background: ok ? "#fff" : `rgba(244,63,94,${0.06 + 0.12 * flash})`, boxShadow: `0 0 0 1px ${ok ? "rgba(10,10,10,0.08)" : "rgba(244,63,94,0.45)"}` }}>
              <span style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em" }}>{a}</span>
              <span style={{ fontFamily: mono, fontSize: 26, color: ok ? "#0b8a5f" : C.red }}>{ok ? "✓ " : "✕ "}{b}</span>
            </div>
          );
        })}
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 790, textAlign: "center" }}>
        <Head size={70}><Words text="Every fill pays the builder nothing." at={big} every={3} accent={{ "nothing.": C.red }} /></Head>
      </div>
    </Fill>
  );
};

// 4 ─ The turn: bolt, wordmark, tagline, the ladder lights rung by rung.
export const Turn: React.FC = () => {
  const { f, rel } = useCue("turn");
  const t = rel("Vektor");
  const p = interpolate(f, [t - 10, t + 18], [0, 1], { ...clamp, easing: expo });
  const lit = interpolate(f, [t, rel("fill.") + 10], [0, 1], clamp);
  return (
    <Fill bg={C.bg}>
      <Ladder f={f} opacity={0.55} lit={lit} />
      <Glow x="50%" y="44%" color="rgba(37,250,176,0.18)" size="38% 34%" />
      <div style={{ position: "absolute", left: 0, right: 0, top: 220, display: "flex", justifyContent: "center" }}><Lockup width={1100} p={p} /></div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 630, textAlign: "center", fontSize: 64, fontWeight: 500, letterSpacing: "-0.03em" }}>
        <Words text="The quant terminal that pays its builder on every fill." at={rel("The") - 2} every={3} accent={{ "every": C.mint, "fill.": C.mint }} />
      </div>
    </Fill>
  );
};

// 5 ─ Grid Studio, demo footage: design card, deploy, ladder, log.
export const Grid: React.FC = () => {
  const { f, rel } = useCue("grid");
  return (
    <Fill bg={C.bg}>
      <Glow x="50%" y="50%" />
      <Browser name="grid" url={APP} width={1560} left={180} top={60} startFrom={97} {...DEMO} cams={[
        { f: 0, z: 1 }, { f: 30, rect: "design", z: 1.5 }, { f: rel("ladder") + 30, rect: "ladder", z: 1.25 },
        { f: rel("rung.") - 10, rect: "ladder", z: 1.25 }, { f: rel("When") + 10, rect: "log", z: 1.9 },
      ]} />
      <Card at={rel("builder") - 4} left={1340} top={760} width={440} out={rel("When") - 4}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: mono, fontSize: 16, color: C.mint, letterSpacing: "0.1em" }}><Logo name="strike" h={18} />BUILDER CODE</div>
        <div style={{ fontFamily: mono, fontSize: 24, marginTop: 10 }}>{`{ code: "${OC.builder.code}", ${OC.builder.fee_bps} bps }`}</div>
        <div style={{ fontSize: 20, color: "rgba(255,255,255,0.6)", marginTop: 6 }}>on every rung · post only · one batch</div>
      </Card>
    </Fill>
  );
};

// 6 ─ Backtest + head-to-head, demo footage.
export const Backtest: React.FC = () => {
  const { rel } = useCue("backtest");
  return (
    <Fill bg={C.bg}>
      <Glow x="50%" y="50%" />
      <Browser name="backtest" url={APP} width={1560} left={180} top={60} startFrom={230} {...DEMO} cams={[
        { f: 0, rect: "card", z: 1.35 }, { f: rel("Same"), rect: "card", z: 1.5 }, { f: rel("Strike's") + 20, rect: "h2h", z: 1.45 },
      ]} />
      <Card at={rel("mainnet") - 4} left={120} top={790} width={520} out={rel("Then") - 4}>
        <Kicker size={14}>Same engine</Kicker>
        <div style={{ fontSize: 26, marginTop: 10 }}>Real mainnet candles · fees included</div>
      </Card>
      <Card at={rel("side") - 4} left={1300} top={790} width={500}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}><Logo name="strike" h={20} /><Kicker size={14}>native bot · same range</Kicker></div>
        <div style={{ fontSize: 26, marginTop: 10 }}>Head-to-head, builder revenue compared</div>
      </Card>
    </Fill>
  );
};

// 7 ─ Funding Harvester, demo footage, then the real mainnet hedge.
export const Harvester: React.FC = () => {
  const { rel } = useCue("harvester");
  const hedge = fillAt("ada", "19:15:49"), unwind = fillAt("ada", "19:17:10");
  return (
    <Fill bg={C.bg}>
      <Glow x="50%" y="50%" />
      <Browser name="harvester" url={APP} width={1560} left={180} top={60} startFrom={40} {...DEMO} cams={[
        { f: 0, rect: "radar", z: 1.3 }, { f: rel("sizes") + 10, rect: "sizer", z: 1.4 }, { f: rel("On") + 30, rect: "tracker", z: 1.3 },
      ]} />
      <Card at={rel("mainnet") - 4} left={1220} top={640} width={580}>
        <Kicker size={14}>Mainnet · ADA-USD</Kicker>
        <div style={{ marginTop: 12 }}>
          <Row k={`${utc(hedge.utc)}`} v={`SHORT ${hedge.size} @ ${usd(hedge.price)}`} color={C.red} />
          <Row k={`${utc(unwind.utc)}`} v={`CLOSE ${unwind.size} @ ${usd(unwind.price)}`} color={C.mint} />
        </div>
      </Card>
    </Fill>
  );
};

// 8 ─ Aegis Shield after a simulated crash, demo footage.
export const Shield: React.FC = () => {
  const { rel } = useCue("shield");
  return (
    <Fill bg={C.bg}>
      <Glow x="50%" y="50%" color="rgba(245,158,11,0.10)" />
      <Browser name="shield" url={APP} width={1300} left={70} top={110} startFrom={300} {...DEMO} cams={[
        { f: 0, z: 1 }, { f: 70, rect: "gauge", z: 1.5 }, { f: rel("Under") + 10, rect: "rules", z: 1.5 }, { f: rel("Once") - 10, rect: "log", z: 1.4 },
      ]} />
      <Card at={rel("eight") - 4} left={1420} top={260} width={420} accent={C.amber}>
        <div style={{ fontFamily: mono, fontSize: 44, color: C.amber }}>&lt; 8%</div>
        <div style={{ fontSize: 24, marginTop: 6 }}>cancel the buy rungs</div>
      </Card>
      <Card at={rel("five,") - 4} left={1420} top={500} width={420} accent={C.red}>
        <div style={{ fontFamily: mono, fontSize: 44, color: C.red }}>&lt; 5%</div>
        <div style={{ fontSize: 24, marginTop: 6 }}>trim 25%, reduce only</div>
      </Card>
    </Fill>
  );
};

// 9 ─ Autopilot: how it works, then the owner's live recording and the 19:59:56 fill.
export const Autopilot: React.FC = () => {
  const { f, rel } = useCue("autopilot");
  const fill = fillAt("ada", "19:59:56");
  const exit = OC.strike.ada.open_orders.find((o) => o.client_order_id.includes("-2-x-"))!;
  const live = rel("At") - 14;
  const tick = interpolate(f, [rel("box,") - 4, rel("box,") + 6], [0, 1], clamp);
  const steps: [string, string][] = [["Your", "Wallet signs the enrolment"], ["encrypted", "Trading key encrypted at rest"], ["server.", "Server runs the grid"]];
  const tab = interpolate(f, [rel("tab.") - 6, rel("tab.") + 10], [0, 1], { ...clamp, easing: expo });
  const diagOut = interpolate(f, [live - 10, live + 4], [1, 0], clamp);
  return (
    <Fill bg={C.bg}>
      <Glow x="50%" y="40%" />
      <AbsoluteFill style={{ opacity: diagOut }}>
        <Card at={rel("Tick") - 6} left={210} top={170} width={560}>
          <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
            <div style={{ width: 54, height: 54, borderRadius: 12, boxShadow: `0 0 0 3px ${C.mint}`, display: "flex", alignItems: "center", justifyContent: "center", background: `rgba(37,250,176,${0.9 * tick})` }}>
              <svg width={34} height={34} viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke={C.bg} strokeWidth={3.2} strokeLinecap="round" strokeDasharray={24} strokeDashoffset={24 * (1 - tick)} /></svg>
            </div>
            <div><div style={{ fontSize: 40, fontWeight: 600 }}>Autopilot</div><div style={{ fontSize: 22, color: "rgba(255,255,255,0.55)" }}>run this grid on the server</div></div>
          </div>
        </Card>
        {steps.map(([cue, t], i) => (
          <Card key={cue} at={rel(cue) - 6} left={210 + i * 520} top={480} width={460}>
            <div style={{ fontFamily: mono, fontSize: 16, color: C.mint }}>0{i + 1}</div>
            <div style={{ fontSize: 30, fontWeight: 500, marginTop: 10 }}>{t}</div>
          </Card>
        ))}
        <div style={{ position: "absolute", left: 1000, top: 180, width: 700, height: 150, borderRadius: 18, background: C.panel, boxShadow: "0 0 0 1px rgba(255,255,255,0.12)", opacity: interpolate(f, [rel("Then") - 6, rel("Then") + 4], [0, 1], clamp) * (1 - tab), transform: `scale(${1 - 0.25 * tab}) translateY(${-60 * tab}px)`, display: "flex", alignItems: "center", gap: 18, padding: "0 30px" }}>
          <Mark size={44} /><span style={{ fontSize: 30, flex: 1 }}>Vektor · Grid Studio</span><span style={{ fontSize: 40, color: "rgba(255,255,255,0.6)" }}>✕</span>
        </div>
        <In at={rel("tab.") + 8} style={{ position: "absolute", left: 1000, top: 210, width: 700, textAlign: "center", fontFamily: mono, fontSize: 24, color: C.mint, letterSpacing: "0.1em" }}>TAB CLOSED · GRID STILL RUNNING</In>
      </AbsoluteFill>
      <Browser name="autopilot" url={APP} width={1560} left={180} top={50} enter={live} hold={live + 40} stopAt={112} {...LIVE} cams={[
        { f: live, z: 1 }, { f: live + 30, rect: { x: 300, y: 600, w: 560, h: 80 }, z: 2.2 },
        { f: live + 70, z: 1.2 }, { f: rel("server", 1) - 10, rect: { x: 370, y: 530, w: 440, h: 70 }, z: 2.4 },
        { f: rel("higher.") - 20, rect: { x: 1150, y: 14, w: 360, h: 40 }, z: 2.6 },
      ]} />
      <Card at={rel("bought") - 2} left={160} top={760} width={820}>
        <Kicker size={14}>Server-run fill · {utc(fill.utc)} · no tab open</Kicker>
        <Row k="Entry" v={`BUY ${fill.size} ADA @ ${usd(fill.price)} · ${fill.role}`} color={C.mint} />
        <Row k="Exit, one rung up" v={`SELL ${exit.size} @ ${usd(exit.price)} · resting`} color={C.red} />
        <Row k="Builder" v={<span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}><Logo name="strike" h={16} />{`${exit.builder.Code} · ${exit.builder.FeeBps} bps`}</span>} />
      </Card>
      <Card at={rel("higher.") - 14} left={1040} top={800} width={720}>
        <Kicker size={14}>The app's live telemetry</Kicker>
        <div style={{ fontFamily: mono, fontSize: 30, marginTop: 10 }}>builder fees <span style={{ color: C.mint }}>$0.06</span> · fills 6</div>
      </Card>
    </Fill>
  );
};

// 10 ─ Proof: one card per deposit with its chain logo, then the builder fee.
export const Proof: React.FC = () => {
  const { rel } = useCue("proof");
  const eth = OC.chain.eth.deposit, sol = OC.chain.sol.deposit, ada = OC.chain.ada.deposit;
  const ethFill = fillAt("eth", "18:33:53");
  const cards: { cue: string; logo: "ethereum" | "solana" | "cardano"; amt: string; ref: string; time: string; hash: string }[] = [
    { cue: "16", logo: "ethereum", amt: `${eth.usdc_transfers[0].amount} USDC`, ref: `block ${eth.block.toLocaleString("en-US")}`, time: utc(eth.utc), hash: short(eth.hash) },
    { cue: "5", logo: "solana", amt: `${-sol.token_deltas.find((d) => d.delta < 0)!.delta} USDC`, ref: `slot ${sol.slot.toLocaleString("en-US")}`, time: utc(sol.utc), hash: short(sol.signature) },
    { cue: "95", logo: "cardano", amt: "95 ADA", ref: `block ${Number(ada.block).toLocaleString("en-US")}`, time: utc(String(ada.utc)), hash: short(String(ada.hash)) },
  ];
  return (
    <Fill bg={C.bg}>
      <Glow x="50%" y="30%" />
      <div style={{ position: "absolute", left: 0, right: 0, top: 90, textAlign: "center" }}>
        <Head size={72}><Words text="All of it ran on mainnet." at={rel("All") - 4} every={3} accent={{ "mainnet.": C.mint }} /></Head>
      </div>
      {cards.map((c, i) => (
        <Card key={c.cue} at={rel(c.cue) - 6} left={150 + i * 550} top={250} width={510}>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <div style={{ width: 70, height: 70, display: "flex", alignItems: "center", justifyContent: "center" }}><Logo name={c.logo} h={c.logo === "ethereum" ? 70 : 52} /></div>
            <div style={{ fontSize: 46, fontWeight: 600, letterSpacing: "-0.02em" }}>{c.amt}</div>
          </div>
          <div style={{ marginTop: 14 }}>
            <Row k="deposit" v={c.ref} /><Row k="time" v={c.time} /><Row k="tx" v={c.hash} color={C.mint} />
          </div>
        </Card>
      ))}
      <In at={rel("Each") - 4} style={{ position: "absolute", left: 0, right: 0, top: 590, textAlign: "center", fontSize: 30, color: "rgba(255,255,255,0.7)" }}>Each signed in the wallet, from inside Vektor.</In>
      <Card at={rel("fill,") - 6} left={460} top={680} width={1000}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}><Logo name="strike" h={26} /><Kicker size={14}>Builder fee on a real fill</Kicker></div>
        <div style={{ marginTop: 12 }}>
          <Row k={utc(ethFill.utc)} v={`SELL ${ethFill.size} ADA @ ${usd(ethFill.price)} · ${ethFill.role}`} />
          <Row k="builder fee (user-stream fill event)" v="$0.01" color={C.mint} />
        </div>
      </Card>
    </Fill>
  );
};

// 11 ─ Under the hood: engines, two backends, the public proof page.
export const Under: React.FC = () => {
  const { rel } = useCue("under");
  const boxes: [string, string, string][] = [["engines", "Pure engines", "grid · funding · shield · backtest"], ["demo", "Demo backend", "simulated order book"], ["Live", "Live backend", "Strike mainnet"]];
  return (
    <Fill bg={C.bg}>
      <Glow x="30%" y="40%" />
      {boxes.map(([cue, a, b], i) => (
        <Card key={cue} at={rel(cue) - 6} left={110} top={150 + i * 230} width={640} out={rel("proof") + 6}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>{cue === "Live" ? <Logo name="strike" h={24} /> : null}<span style={{ fontSize: 36, fontWeight: 600 }}>{a}</span></div>
          <div style={{ fontFamily: mono, fontSize: 20, color: "rgba(255,255,255,0.55)", marginTop: 8 }}>{b}</div>
        </Card>
      ))}
      <Browser name="proof_ada" url="tryvektor.vercel.app/proof.html" width={rel("proof") > 0 ? 1000 : 1000} left={820} top={150} enter={rel("hood,")} startFrom={60}
        style={{}} cams={[{ f: 0, z: 1 }, { f: rel("check"), z: 1.25, dy: 120 }]} />
      <Note at={rel("proof") - 4} top={830}>proof.html · public fills, open orders and builder tags for any account</Note>
    </Fill>
  );
};

// 12 ─ Next: the Grid Vault.
export const Next: React.FC = () => {
  const { rel } = useCue("next");
  return (
    <Fill bg={C.bg}>
      <Ladder f={rel("Next") + 200} opacity={0.3} />
      <Glow x="50%" y="50%" />
      <div style={{ position: "absolute", left: 0, right: 0, top: 250, textAlign: "center" }}>
        <Kicker style={{ justifyContent: "center" }}>Next</Kicker>
        <Head size={110} style={{ marginTop: 30 }}><Words text="Vektor Grid Vault" at={rel("Vektor") - 4} every={4} accent={{ Vault: C.mint }} /></Head>
        <div style={{ fontSize: 40, color: "rgba(255,255,255,0.7)", marginTop: 40 }}><Words text="Anyone can deposit. Every vault fill still pays the builder." at={rel("anyone") - 2} every={3} /></div>
      </div>
    </Fill>
  );
};

// 13 ─ Close.
export const Close: React.FC = () => {
  const { f, rel, dur } = useCue("close");
  const p = interpolate(f, [rel("Vektor") - 10, rel("Vektor") + 18], [0, 1], { ...clamp, easing: expo });
  const fade = interpolate(f, [dur - 40, dur], [1, 0], clamp);
  return (
    <Fill bg={C.bg}>
      <AbsoluteFill style={{ opacity: fade }}>
        <Ladder f={f} opacity={0.4} lit={interpolate(f, [0, 200], [0, 1], clamp)} />
        <Glow x="50%" y="40%" color="rgba(37,250,176,0.2)" size="40% 34%" />
        <div style={{ position: "absolute", left: 0, right: 0, top: 150, display: "flex", justifyContent: "center" }}><Lockup width={1000} p={p} /></div>
        <In at={rel("Built") - 4} style={{ position: "absolute", left: 0, right: 0, top: 530, display: "flex", justifyContent: "center", alignItems: "center", gap: 24, fontSize: 46, fontWeight: 500 }}>
          Built on <Logo name="strike" h={50} />
        </In>
        <div style={{ position: "absolute", left: 0, right: 0, top: 630, textAlign: "center", fontSize: 58, letterSpacing: "-0.02em" }}>
          <Words text="Paid on every fill." at={rel("Paid") - 2} every={3} accent={{ every: C.mint, "fill.": C.mint }} />
        </div>
        <In at={rel("Try") - 4} style={{ position: "absolute", left: 0, right: 0, top: 790, textAlign: "center", fontFamily: mono, fontSize: 40, color: C.mint }}>tryvektor.vercel.app</In>
        <In at={rel("Try") + 10} style={{ position: "absolute", left: 0, right: 0, top: 870, textAlign: "center", fontFamily: mono, fontSize: 20, letterSpacing: "0.14em", color: "rgba(255,255,255,0.5)" }}>STRIKE FINANCE HACKATHON 2026</In>
      </AbsoluteFill>
    </Fill>
  );
};

export const SCENES: Record<string, React.FC> = {
  problem: Problem, strike: Strike, gap: Gap, turn: Turn, grid: Grid, backtest: Backtest, harvester: Harvester,
  shield: Shield, autopilot: Autopilot, proof: Proof, under: Under, next: Next, close: Close,
};
void display; void sans; void serif;
