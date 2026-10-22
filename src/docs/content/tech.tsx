import type { DocContent } from "../DocsFrame";
import { P, H3, Code, CodeBlock, DocLink, Ext, Callout, DocTable, Tag } from "../primitives";
import { API_HOST, PRICE_HOST, BUILDER_FEE_BPS, BUILDER_FEE_CAP_BPS, REPO_URL, STRIKE_DOCS } from "../facts";

export const architecture: DocContent = {
  sections: [
    { id: "layers", title: "Layers", body: (
      <DocTable head={["Folder", "Contents"]} rows={[
        [<Code>src/quant</Code>, "Pure engines with no React and no network: grid, funding, shield, whale radar, L3, regime, backtest, backfill"],
        [<Code>src/sim</Code>, "In-memory matching engine and price scenarios for Demo mode"],
        [<Code>src/api</Code>, "Strike REST calls, signing, deposits, the live adapter"],
        [<Code>src/ws</Code>, "Price, user and L3 streams"],
        [<Code>src/hooks/useVektor.ts</Code>, "Owns grids per symbol, shield, hedge, auto-shift, regime and the watchdog"],
        [<Code>worker/</Code>, "The same engines running headless in Node"],
        [<Code>cli/</Code>, "Command-line interface over the engines"],
      ]} />
    ) },
    { id: "adapter", title: "One adapter seam", body: (
      <>
        <P>Engines produce orders; an <Code>ExecutionAdapter</Code> sends them and reports fills. Demo mode uses the simulator, Live mode uses Strike. That is why Demo mode is the real engine code, not a mock screen.</P>
        <CodeBlock label="src/quant/types.ts">{`interface ExecutionAdapter {
  mode: "live" | "sim";
  placeBatch(orders);
  placeStrategy?(req);      // brackets
  replaceAll?(symbol, orders); // auto-shift
  cancel(symbol, clientOrderId);
  cancelAll(symbol?);
  onFill(cb);
}`}</CodeBlock>
      </>
    ) },
    { id: "roles", title: "Order roles in the client ID", body: (
      <P>Grid orders are tagged <Code>vektor-grid-&lt;id&gt;-&lt;rung&gt;-&lt;e|x|s&gt;-&lt;seq&gt;</Code> (entry, exit, stop). Fills route by that tag, so the grid survives reconnects and reloads, and the proof page can attribute fills without any server of ours.</P>
    ) },
    { id: "tests", title: "Tests", body: <P>Run <Code>npm test</Code>. The suite covers the engines, simulator, backtester, CLI, Cardano witness merging and a full render of the app.</P> },
  ],
};

export const strikeApi: DocContent = {
  sections: [
    { id: "hosts", title: "Hosts", body: (
      <DocTable head={["Use", "URL"]} rows={[["Trading and account", <Code>{API_HOST}</Code>], ["Market data", <Code>{PRICE_HOST}</Code>]]} />
    ) },
    { id: "builder", title: "Which endpoints pay the builder", body: (
      <>
        <P>The builder fee is sent per order as the <Code>X-Builder-Fee-Bps</Code> header (Vektor uses {BUILDER_FEE_BPS}; Strike's cap is {BUILDER_FEE_CAP_BPS}).</P>
        <DocTable head={["Endpoint", "Builder fee", "Vektor uses it for"]} rows={[
          [<Code>POST /v2/orders/batch</Code>, <Tag tone="accent">yes</Tag>, "Grid deploy, counters, hedge slices, shield trims"],
          [<Code>POST /v2/order/strategy</Code>, <Tag tone="accent">yes</Tag>, "Per-rung brackets"],
          [<Code>POST /v2/orders/replace</Code>, <Tag tone="accent">yes</Tag>, "Auto-shift"],
          [<Code>POST /v2/grid/bot</Code>, <Tag tone="warning">no</Tag>, "Head-to-head comparison only"],
          [<Code>POST /v2/algo/twap</Code>, <Tag tone="warning">no</Tag>, "Not used; replaced by sliced IOC orders"],
          [<Code>POST /v2/order/replace</Code>, <Tag tone="warning">no</Tag>, "Not used"],
        ]} />
      </>
    ) },
    { id: "reads", title: "Reads and streams", body: (
      <P>Account and history: <Code>/v2/account</Code>, <Code>/v2/positions</Code>, <Code>/v2/openOrders</Code>, <Code>/v2/history/fill</Code>, <Code>/v2/history/funding</Code>, <Code>/v2/order</Code>. Markets: <Code>/v2/markets</Code>, <Code>/v2/fee-tiers</Code>, <Code>/price/v2/depth</Code>, <Code>markPrice</Code>, <Code>premiumIndex</Code>, <Code>klines</Code>, <Code>fearGreed</Code>, <Code>openInterest</Code>, <Code>ticker/24hr</Code>. Streams: <Code>/ws/price</Code>, <Code>/ws/user-api</Code>, <Code>/ws/l3</Code>. Full reference: <Ext href={STRIKE_DOCS}>Strike docs</Ext>.</P>
    ) },
    { id: "signing", title: "Signing", body: (
      <P>Each authenticated request is signed with the API wallet's Ed25519 key over <Code>METHOD:PATH:TIMESTAMP:NONCE:BODY_HASH</Code>. The user stream logs in with <Code>session.logon</Code>.</P>
    ) },
  ],
};

export const workerCli: DocContent = {
  sections: [
    { id: "worker", title: "Headless worker", body: (
      <>
        <P>The worker runs grids and the Shield without a browser. Keys come from the environment, state is saved to a file, and on restart it backfills missed fills and reconciles open orders.</P>
        <CodeBlock label="shell">{`export STRIKE_API_PUBLIC_KEY=...
export STRIKE_API_PRIVATE_KEY=...
npm run worker
curl localhost:8787/          # status
curl -X POST localhost:8787/panic`}</CodeBlock>
        <Callout tone="honest">The worker runs plain grids and the Shield. Brackets, auto-shift and the regime guard currently run only in the browser.</Callout>
      </>
    ) },
    { id: "cli", title: "Command line", body: (
      <CodeBlock label="shell">{`npm run cli -- plan ADA-USD --lower 0.21 --upper 0.235 --levels 12 --margin 200 --leverage 5
npm run cli -- backtest ADA-USD --days 7
npm run cli -- smart-range ADA-USD
npm run cli -- status`}</CodeBlock>
    ) },
    { id: "skill", title: "Agent skill", body: (
      <P><Code>skills/vektor-grid/SKILL.md</Code> teaches an AI coding agent (Claude Code, Cursor and similar) to plan, backtest and deploy grids through the CLI. Copy it into the agent's skills folder.</P>
    ) },
  ],
};

export const selfHosting: DocContent = {
  sections: [
    { id: "env", title: "Environment variables", body: (
      <DocTable head={["Variable", "Purpose"]} rows={[
        [<Code>VITE_BUILDER_CODE</Code>, "Builder code sent with Builder Connect"],
        [<Code>VITE_BUILDER_FEE_BPS</Code>, "Fee per fill in basis points (0-100)"],
        [<Code>VITE_API_URL</Code>, "Trading API host"],
        [<Code>VITE_PRICE_URL</Code>, "Market-data host"],
        [<Code>VITE_PRICE_WS_URL</Code>, "Price stream"],
        [<Code>VITE_USER_WS_URL</Code>, "User stream"],
        [<Code>STRIKE_API_PUBLIC_KEY</Code> , "Worker only: API wallet public key"],
        [<Code>STRIKE_API_PRIVATE_KEY</Code>, "Worker only: API wallet private key"],
      ]} />
    ) },
    { id: "build", title: "Build and deploy", body: (
      <>
        <CodeBlock label="shell">{`npm install
npm run build   # dist/: landing, app, proof and every docs page`}</CodeBlock>
        <P>Deploy <Code>dist/</Code> as a static site. On Vercel, <Code>vercel.json</Code> and <Code>api/rpc.ts</Code> add the RPC relay used for wallet balances. Source: <Ext href={REPO_URL}>GitHub</Ext>.</P>
      </>
    ) },
  ],
};
