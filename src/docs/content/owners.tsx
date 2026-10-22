import type { DocContent } from "../DocsFrame";
import { P, H3, Code, DocLink, Ext, Callout, StepList, DocTable, Tag } from "../primitives";
import { ADA_MIN_NOTIONAL_MAINNET, BUILDER_CODE, STRIKE_APP, WATCHDOG_SECONDS } from "../facts";

export const userGuide: DocContent = {
  sections: [
    { id: "setup", title: "Set up from scratch", body: (
      <StepList steps={[
        { title: "Open the terminal and switch to Live", body: "The sidebar's Execution mode panel. Market data starts streaming immediately." },
        { title: "Connect a wallet", body: <>Choose Cardano, Solana or Ethereum, pick your wallet, sign the challenge. The Connected panel must say <Code>Builder: {BUILDER_CODE}</Code>.</> },
        { title: "Deposit", body: <>Use the Deposit panel. Wait for the Account panel's Wallet Balance to update. See <DocLink to="deposits">Deposits</DocLink>.</> },
        { title: "Check the regime guard", body: <>If it says EXTREME, deploy is blocked. Untick it only if you accept the risk. See <DocLink to="regime-guard">Regime guard</DocLink>.</> },
        { title: "Deploy a small grid", body: `Grid Studio → Prove-it preset → Deploy. It sizes three rungs that clear the $${ADA_MIN_NOTIONAL_MAINNET} minimum on ADA-USD.` },
        { title: "Watch it", body: "Log lines show acknowledgements, fills and counter orders. The header shows volume, fills and builder fees." },
        { title: "Stop", body: "Stop grid & cancel rungs. Close open positions with the position's Close button or PANIC." },
      ]} />
    ) },
    { id: "log", title: "Grid log lines", body: (
      <DocTable head={["Line", "Meaning"]} rows={[
        [<Code>Deployed N rungs</Code>, "The batch was sent"],
        [<Code>Rung i SIDE resting @ p (engine ack)</Code>, "Strike confirmed the order is on the book"],
        [<Code>Entry BUY/SELL q @ p</Code>, "An entry filled; the exit is placed next"],
        [<Code>Exit … / Round trip +$x</Code>, "A full cycle completed; profit booked"],
        [<Code>rejected (reason)</Code>, "Strike rejected or dropped the order"],
        [<Code>Adopted N resting rung(s)</Code>, "The grid was rebuilt from your open orders after a reload"],
        [<Code>Regime PAUSE - counter held</Code>, "The guard is holding counter orders"],
      ]} />
    ) },
    { id: "buttons", title: "Buttons", body: (
      <DocTable head={["Button", "What happens"]} rows={[
        ["Prove-it preset", "Fills a small grid sized from the live market's rules"],
        ["Copy proof summary", "Copies a markdown block describing the live grid"],
        ["Proof ↗", "Opens the public proof page for your account"],
        ["Judge tour", "45-second guided demo in Demo mode"],
        ["?", "Replays the walkthrough"],
        ["PANIC", "Cancels everything and flattens every position, after confirmation"],
      ]} />
    ) },
  ],
};

export const faq: DocContent = {
  sections: [
    { id: "own-builder", title: "\"cannot connect an account to its own builder\"", body: (
      <P>Strike will not let the account that owns a builder code approve that code for itself. Sign that account in with API wallet keys (no builder fee is charged), or connect a different wallet address to trade through the builder.</P>
    ) },
    { id: "silently-dropped", title: "Rungs show \"rejected (silently_dropped)\"", body: (
      <P>Strike accepted the request but the engine never created the order, and sent no event. Vektor's watchdog checks after {WATCHDOG_SECONDS} seconds and frees the rung. The usual cause was rungs below the market minimum (ADA-USD on mainnet: ${ADA_MIN_NOTIONAL_MAINNET}); Deploy now refuses those.</P>
    ) },
    { id: "tick", title: "\"Order price is not a multiple of tick size\"", body: (
      <P>Every price must sit on the market's price grid. Vektor rounds grid and hedge prices to the tick (sells down, buys up). If you see this, report the market; it means a market's tick was missing from its rules.</P>
    ) },
    { id: "paused", title: "Deploy says \"Paused by regime guard\"", body: (
      <P>The market scored EXTREME. Untick the guard in the sidebar to deploy anyway. It never cancels or closes anything.</P>
    ) },
    { id: "deposit-time", title: "I deposited but my balance is still $0", body: (
      <P>Strike credits after block confirmations, usually 2-5 minutes (about 12 blocks on Ethereum). The balance updates by itself. If the panel showed an error after the wallet signed, open Manual in the Deposit panel and confirm by transaction hash.</P>
    ) },
    { id: "rpc", title: "Wallet balance shows \"unavailable\"", body: (
      <P>Public Solana and Ethereum RPC servers (the nodes that answer balance queries) reject requests from browser pages. Vektor sends them through its own address instead: a proxy in development and a small serverless relay in production. If it still fails, the message lists each server and its reply.</P>
    ) },
    { id: "refresh", title: "I refreshed and had to sign in again", body: (
      <P>Tick "Remember on this device" when signing in. It keeps the trading key in this browser and restores the session after a refresh. Your running grid is rebuilt from your open orders either way.</P>
    ) },
    { id: "wrong-network", title: "My wallet asked to send on the wrong network", body: (
      <P>Cancel it. The Ethereum deposit flow now asks the wallet to switch to Ethereum mainnet first and refuses to send on any other chain.</P>
    ) },
    { id: "leverage", title: "My position shows 20x, not the leverage I chose", body: (
      <P>Older versions sized orders with your leverage but did not set it on Strike. Deploy and hedge launch now set the symbol leverage first.</P>
    ) },
  ],
};
