import type { DocContent } from "../DocsFrame";
import { P, H3, Code, DocLink, Ext, Callout, StepList, DocTable, Tag } from "../primitives";
import { BUILDER_FEE_BPS, GRID_LEVELS, GRID_PREFIX, SKEW, SHIELD, HOURS_YEAR, REGIME, ADA_MIN_NOTIONAL_MAINNET, STRIKE_APP } from "../facts";

export const gridStudio: DocContent = {
  sections: [
    { id: "what", title: "What it does", body: (
      <>
        <P>A neutral grid rests buy orders below the current price and sell orders above it, {GRID_LEVELS.min}-{GRID_LEVELS.max} levels, spaced arithmetically or geometrically. The level nearest the price is left empty so buys and sells never collide.</P>
        <P>When an entry fills, Vektor places the exit one level away for the exact filled quantity. When the exit fills, the round trip is booked and the entry is placed again. Every order carries the builder fee header ({BUILDER_FEE_BPS} bps).</P>
      </>
    ) },
    { id: "how", title: "How to use it", body: (
      <StepList steps={[
        { title: "Set the range", body: "Drag Lower and Upper (as a percentage from the current price). Set levels, margin and leverage." },
        { title: "Read the design card", body: "Spacing per rung, net profit per round trip after maker and builder fees, and total notional. Red lines are blocking problems, such as rungs below the minimum order size." },
        { title: "Optional settings", body: <>Funding skew tilts rung sizes toward the side that receives funding (saturates at {(SKEW.refRateHourly * 100).toFixed(4)}% per hour, sizes move by up to ±{SKEW.maxSkew * 100}%). Per-rung stop-loss attaches a stop leg to each entry.</> },
        { title: "Deploy", body: "Press Deploy. The log lists each rung with \"engine ack\" once Strike confirms it." },
        { title: "Manage", body: "Tick Auto-shift to recentre the ladder when the price leaves the range. Stop grid cancels every resting rung; positions stay open until closed." },
      ]} />
    ) },
    { id: "reading", title: "Reading the screen", body: (
      <DocTable head={["Element", "Meaning"]} rows={[
        ["Green line on the ladder", "Resting buy order"],
        ["Red line", "Resting sell order"],
        ["Orange dashed line", "Liquidation price of your position"],
        ["Bars on the right edge", "Large resting orders (walls) in the order book"],
        ["Stats: Resting / Fills / Round trips", "Live counts for this grid"],
        ["Builder fees", "Fees the builder earned on this grid's fills"],
      ]} />
    ) },
    { id: "limits", title: "Limits", body: (
      <>
        <P>Each rung must clear the market's minimum order value (ADA-USD on mainnet: ${ADA_MIN_NOTIONAL_MAINNET}). The Deploy button refuses rungs below it, because Strike drops undersized orders without an error.</P>
        <P>Client order IDs start with <Code>{GRID_PREFIX}-</Code>. Do not place your own orders with that prefix.</P>
        <Callout tone="honest">Grid deploy, fills, counter orders and builder fees have run on mainnet. Auto-shift (<Code>/v2/orders/replace</Code>) and per-rung stop-loss brackets (<Code>/v2/order/strategy</Code>) are tested in the simulator and unit tests but have not yet run with real money.</Callout>
      </>
    ) },
  ],
};

export const backtest: DocContent = {
  sections: [
    { id: "backtest", title: "Backtest before you deploy", body: (
      <>
        <P>The Backtest card replays the grid you designed over 24 hours, 7 days or 30 days of real mainnet candles, through the same matching engine and grid code the live grid uses. You get net profit after fees, annualised return, maximum drawdown, time spent inside the range and an equity curve.</P>
        <Callout tone="honest">Candles come from mainnet even in Demo mode, because testnet has almost no trades. The replay fills every rung a candle's wick touched, which is optimistic on thin order books.</Callout>
      </>
    ) },
    { id: "smart-range", title: "Smart range", body: (
      <P>Smart range proposes a range of the last price ± 3 × ATR(14) - the average true range over 14 candles, a standard measure of recent volatility - and picks a level count whose spacing clears Strike's own fee floor. Press Apply to copy it to the sliders.</P>
    ) },
    { id: "head-to-head", title: "Head-to-head with Strike's grid bot", body: (
      <P>The Head-to-head card runs the same range through Vektor's grid and through Strike's native <Code>/v2/grid/bot</Code> on the same candles. The native bot carries no builder code, so its builder revenue is always zero. In Live mode you can also launch the native bot beside yours.</P>
    ) },
  ],
};

export const fundingHarvester: DocContent = {
  sections: [
    { id: "what", title: "What it does", body: (
      <>
        <P>Strike settles funding every hour at HH:00 UTC (coordinated universal time). When the rate is positive, longs pay shorts. The table ranks every market by annual rate: hourly rate × {HOURS_YEAR.toLocaleString()} hours.</P>
        <P>If you hold the asset in your own wallet and short the same amount on Strike, price moves cancel out (delta zero) and you keep the funding.</P>
      </>
    ) },
    { id: "how", title: "How to use it", body: (
      <StepList steps={[
        { title: "Pick the market", body: "The sizer uses the market selected in the header. Click a table row to switch." },
        { title: "Enter your spot amount", body: "Type how much of the asset you hold, or press Read balance to fill it from your connected wallet." },
        { title: "Check the plan", body: "Perp leg, margin required, liquidation price (from the market's margin tiers) and expected funding. Launch is disabled if the margin is more than your balance." },
        { title: "Launch", body: "Vektor sets the symbol leverage, then sends the hedge as immediate-or-cancel limit orders with the builder fee. The tracker shows Filled and Status." },
        { title: "Unwind", body: "Unwind closes the position with a reduce-only market order." },
      ]} />
    ) },
    { id: "statuses", title: "Statuses", body: (
      <DocTable head={["Status", "Meaning"]} rows={[
        [<Tag tone="accent">DONE</Tag>, "Full size filled; funding accrues hourly"],
        [<Tag>RUNNING</Tag>, "Slices still being placed, or only part filled"],
        [<Tag tone="warning">FAILED</Tag>, "Strike rejected or dropped the order; the reason is shown"],
        [<Tag>UNWOUND</Tag>, "Position closed"],
      ]} />
    ) },
    { id: "limits", title: "Limits", body: (
      <Callout tone="honest">Launch and unwind have run on mainnet (ADA-USD, 50 ADA). The spot leg lives in your wallet, so Vektor cannot see or protect it; if funding turns negative, a long perp collects it but is not a hedge. The funding-flip guard (Rule C) unwinds after 3 adverse hours.</Callout>
    ) },
  ],
};

export const aegisShield: DocContent = {
  sections: [
    { id: "what", title: "What it does", body: (
      <P>For each open position the Shield computes the distance between the mark price and the liquidation price, using the same formulas as Strike's engine, and shows it as a gauge. Health is SAFE, WARNING or CRITICAL.</P>
    ) },
    { id: "rules", title: "Rules", body: (
      <DocTable head={["Rule", "Trigger (default)", "Action"]} rows={[
        ["A", `buffer < ${SHIELD.warnPct}%`, "Cancel resting buy rungs on that symbol to free margin. Once per episode."],
        ["B", `buffer < ${SHIELD.criticalPct}%`, `Reduce-only market order for ${SHIELD.trimFraction * 100}% of the position, then a ${SHIELD.cooldownMs / 1000} s cooldown; never while a trim is pending.`],
        ["C", "3 adverse funding hours", "Unwind the Harvester hedge (lives in the Harvester)."],
        ["PANIC", "you press it", "Cancel every order and flatten every position, after a confirmation."],
      ]} />
    ) },
    { id: "alerts", title: "Alerts", body: (
      <P>Press Enable browser alerts to get system notifications for warnings, trims and round trips even when the tab is in the background.</P>
    ) },
    { id: "limits", title: "Limits", body: (
      <Callout tone="honest">The gauge and Rule A's cancel path have run live. Rule B has not fired on mainnet: it needs a position within {SHIELD.criticalPct}% of liquidation, and pushing one there on purpose would risk funds. It is covered by simulator and unit tests. The Shield acts only while the terminal tab or the headless worker is running.</Callout>
    ) },
  ],
};

export const regimeGuard: DocContent = {
  sections: [
    { id: "what", title: "What it does", body: (
      <P>The regime guard scores each market from 0 to 100 using the Fear and Greed index, open-interest change against a rolling baseline, the 24-hour price range, and the funding rate. Below {REGIME.elevatedScore} is CALM; {REGIME.elevatedScore}-{REGIME.extremeScore} is ELEVATED; {REGIME.extremeScore} and above is EXTREME.</P>
    ) },
    { id: "effects", title: "Effects", body: (
      <DocTable head={["Level", "Effect when the guard is on"]} rows={[
        ["CALM", "Nothing"],
        ["ELEVATED", "New grids are widened by ×1.25-1.75 so rungs sit further from a volatile price"],
        ["EXTREME", "Deploy is blocked and counter orders are held until conditions calm; nothing is cancelled or closed"],
      ]} />
    ) },
    { id: "turn-off", title: "When to turn it off", body: (
      <P>Untick it when you want exactly the range you set: a deliberate tight test grid, a small amount you accept to risk, or when you are watching the position yourself. The panel says so whenever it is blocking or widening.</P>
    ) },
  ],
};

export const l3Radar: DocContent = {
  sections: [
    { id: "what", title: "What it does", body: (
      <>
        <P>Strike publishes an order-level feed (L3, "level 3": every individual order, not just price totals). The radar follows it and flags two patterns:</P>
        <ul className="docs-list">
          <li><strong>Spoof</strong>: a large order pulled within 15 seconds, untouched, after the price came close.</li>
          <li><strong>Iceberg</strong>: a price level that refills three or more times right after fills.</li>
        </ul>
        <P>It also keeps a per-price reliability score: how often a wall stayed until it was hit.</P>
      </>
    ) },
    { id: "limits", title: "Limits", body: (
      <Callout tone="honest">The browser cannot load Strike's L3 snapshot because that endpoint sends no CORS (cross-origin) header, so the panel may stay at "syncing" in the terminal. The feed itself was verified from the server side on ADA, BTC and SOL. Detection thresholds are hand-tuned.</Callout>
    ) },
  ],
};

export const deposits: DocContent = {
  sections: [
    { id: "sign-in", title: "Ways to sign in", body: (
      <DocTable head={["Method", "Use it when", "Builder fee"]} rows={[
        ["Builder Connect (wallet)", "Normal use. Your Cardano, Solana or Ethereum wallet signs a challenge.", "Charged"],
        ["API wallet keys", <>The account owns the builder code (Strike refuses to connect an account to its own builder), or for bots. Create keys at <Ext href={`${STRIKE_APP}/api-keys`}>app.strikefinance.org/api-keys</Ext>.</>, "Not charged"],
      ]} />
    ) },
    { id: "remember", title: "Staying signed in", body: (
      <P>Both methods offer "Remember on this device". It stores the trading key in this browser's local storage, unencrypted, and signs you back in after a refresh. Disconnect forgets it. Deposits on a restored session ask the wallet to reconnect.</P>
    ) },
    { id: "deposit", title: "Depositing", body: (
      <StepList steps={[
        { title: "Choose the asset", body: "The panel shows your wallet balance for it and the native coin for fees." },
        { title: "Type the amount", body: "Plain units, for example 16 for 16 USDC. The panel shows the raw amount sent to Strike and refuses more than you hold." },
        { title: "Get Quote", body: "Strike returns the USD value and builds the transaction." },
        { title: "Deposit with wallet", body: "Ethereum: the wallet is switched to Ethereum mainnet, then asks twice (token approval, then deposit). Solana: one signature, sign within about 60 seconds. Cardano: one signature; Vektor adds the witness and submits." },
        { title: "Wait", body: "Credit usually appears in 2-5 minutes, after block confirmations. The balance updates by itself." },
      ]} />
    ) },
    { id: "withdraw", title: "Withdrawing", body: (
      <P>Withdrawals need your wallet's signature, and API-wallet keys cannot withdraw by design. Use the Withdraw panel while signed in with a wallet, or the Strike app.</P>
    ) },
  ],
};

export const proof: DocContent = {
  sections: [
    { id: "what", title: "What it is", body: (
      <P>The proof page at <Code>/proof.html?account=&lt;account id&gt;&amp;bps=10</Code> reads an account's fills, funding and positions from Strike's public history endpoints, in your own browser. It counts the fills Vektor made (by their client order ID prefix), totals volume and builder revenue, and prints every request it ran so you can repeat them.</P>
    ) },
    { id: "how", title: "How to open it", body: (
      <P>In Live mode press <strong>Proof</strong> in the header, or build the URL yourself with any account id. See <DocLink to="real-vs-simulated">Real vs simulated</DocLink> for accounts used during testing.</P>
    ) },
    { id: "limits", title: "Limits", body: (
      <Callout tone="honest">Strike's public fill rows list the trading commission but not the builder fee, so the page reconstructs builder revenue with Strike's formula: notional × bps ÷ 10,000, rounded down to cents.</Callout>
    ) },
  ],
};
