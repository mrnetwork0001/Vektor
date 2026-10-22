import type { DocContent } from "../DocsFrame";
import { P, Code, DocLink, Ext, Callout, StepList, DocTable, Tag } from "../primitives";
import { BUILDER_CODE, BUILDER_FEE_BPS, DEMO_SYMBOLS, DEMO_WALLET_USD, STRIKE_APP } from "../facts";

export const welcome: DocContent = {
  intro: (
    <P>Vektor is a trading terminal for <Ext href={STRIKE_APP}>Strike Finance</Ext>, a perpetual futures exchange (a "perps" exchange: contracts with no expiry date) that runs a central limit order book, or CLOB. Vektor places and manages orders on that book for you, and every order it places carries the builder code <Code>{BUILDER_CODE}</Code>, so the builder earns {BUILDER_FEE_BPS} basis points (0.{BUILDER_FEE_BPS / 10}%) of each fill.</P>
  ),
  sections: [
    { id: "three-engines", title: "Three engines", body: (
      <DocTable head={["Engine", "What it does for you"]} rows={[
        [<strong>Grid Studio</strong>, "Rests buy orders below the price and sell orders above it. When one fills, it places the opposite order one level away, so a market that moves sideways turns into small, repeated profits."],
        [<strong>Funding Harvester</strong>, "Strike pays funding every hour between longs and shorts. The Harvester ranks markets by that payment and opens a perp position that collects it while your spot holding cancels the price risk."],
        [<strong>Aegis Shield</strong>, "Watches how far each position is from liquidation and cancels buy orders or trims the position before Strike's engine would liquidate it."],
      ]} />
    ) },
    { id: "two-modes", title: "Demo and Live", body: (
      <>
        <P lead="Demo mode">runs the real engines against an in-browser matching engine with {DEMO_SYMBOLS.length} markets ({DEMO_SYMBOLS.join(", ")}) and a ${DEMO_WALLET_USD.toLocaleString()} play balance. Nothing touches Strike.</P>
        <P lead="Live mode">connects your wallet and trades on Strike mainnet with real money. The code paths are the same; only the adapter that sends orders changes.</P>
      </>
    ) },
    { id: "where-next", title: "Where to go next", body: (
      <ul className="docs-list">
        <li><DocLink to="quick-start">Quick start</DocLink> - see everything work in two minutes, no wallet. <Tag tone="accent">recommended</Tag></li>
        <li><DocLink to="how-it-works">How it works</DocLink> - the full path from signature to running grid.</li>
        <li><DocLink to="real-vs-simulated">Real vs simulated</DocLink> - exactly what has run on mainnet.</li>
      </ul>
    ) },
  ],
};

export const howItWorks: DocContent = {
  sections: [
    { id: "flow", title: "End to end", body: (
      <StepList steps={[
        { title: "Connect", body: "Your Cardano, Solana or Ethereum wallet signs a Builder Connect challenge. Strike issues an API wallet (an Ed25519 key pair) approved for the builder code. That key signs every order; your wallet is only needed again for deposits and withdrawals." },
        { title: "Fund", body: <>Deposit from the sidebar. You type the amount in normal units; the app builds the transaction, your wallet signs it, and the hash is registered with Strike. Credit appears after block confirmations, usually 2-5 minutes. See <DocLink to="deposits">Deposits and sign-in</DocLink>.</> },
        { title: "Design and test", body: <>Pick a range, levels, margin and leverage in Grid Studio. Backtest it on real mainnet candles first. See <DocLink to="backtest">Backtest and smart range</DocLink>.</> },
        { title: "Deploy", body: <>One <Code>POST /v2/orders/batch</Code> places every rung as a post-only limit order with the builder fee header. Strike acknowledges each one on the user stream and the log shows "resting (engine ack)".</> },
        { title: "Run", body: "When a rung fills, the counter order is placed for the filled quantity within the same second. The Shield checks every position continuously. Close the tab and the orders stay on Strike; reopen it and the grid is rebuilt from your open orders." },
      ]} />
    ) },
    { id: "async", title: "Built for an asynchronous exchange", body: (
      <>
        <P>Strike answers order requests before the matching engine runs them, so <Code>201 pending</Code> means "queued", not "placed". Vektor treats the user stream as the truth: fills and rejections arrive there with a reason code.</P>
        <P>If no event arrives within a few seconds, a watchdog asks Strike for the order. A missing order means it was silently dropped, and the rung is freed with the reason in the log.</P>
      </>
    ) },
  ],
};

export const quickStart: DocContent = {
  intro: <Callout tone="note">Everything on this page runs in Demo mode. You do not need a wallet, an account or any funds.</Callout>,
  sections: [
    { id: "two-minutes", title: "Two-minute tour", body: (
      <StepList steps={[
        { title: "Open the app", body: <>Go to <a className="docs-link" href="/app.html">the terminal</a>. It opens in Demo mode and shows a short walkthrough the first time; press <Code>?</Code> in the header to see it again.</> },
        { title: "Press Judge tour", body: "A 45-second guided demo deploys a grid, lets it fill, triggers a 12% flash crash, and shows the Shield cancel buys and trim the position." },
        { title: "Deploy your own grid", body: "In Grid Studio, leave the defaults and press Deploy. Watch green (buy) and red (sell) rungs fill on the ladder and counter orders appear in the log." },
        { title: "Crash the market", body: "In the sidebar's Demo market panel, press Flash crash -12%, then open the Aegis Shield tab to read the log." },
        { title: "Try the Harvester", body: "Open Funding Harvester, choose a market, and press Launch. The demo accrues funding faster than real time so you can see it move." },
      ]} />
    ) },
    { id: "go-live", title: "Going live", body: (
      <P>Switch the sidebar to Live, connect a wallet, deposit a small amount, and use the <strong>Prove-it preset</strong> in Grid Studio. It sizes a three-rung grid that clears the market's minimum order size and usually fills within minutes. The <DocLink to="user-guide">User guide</DocLink> walks through it.</P>
    ) },
  ],
};
