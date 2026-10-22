# Demo video script (target 2:30, screen capture + voice)

Record at 1440p, dark theme, browser zoom 110%. Have Live mode connected and a small grid already running before you start so the live cut is instant.

| t | Screen | Say |
|---|---|---|
| 0:00 | Landing page hero (animated grid) | "Vektor is a quant terminal for Strike V2. Three engines: a grid that pays the builder on every fill, a delta-neutral funding harvester, and a liquidation shield. Let me show you it working." |
| 0:12 | Click **Launch App** → Demo mode, Grid Studio | "Demo mode is the real engines on an in-browser matching engine — same code as live." |
| 0:18 | Click **▶ Judge tour**, let it run (captions do the talking); speak over the crash step | "…flash crash. Buy rungs fill, the long walks toward its liquidation line — and Aegis cancels the resting buys at 8% buffer, trims 25% at 5%. One episode, one trim, with cooldown." |
| 1:00 | Tour ends on telemetry; point at header | "Every fill carries the builder fee. Strike's own grid bot pays zero — that's the head-to-head card." |
| 1:05 | Scroll to **Backtest** card, click 7d | "Before deploying, replay the exact range over 7 days of mainnet candles through the same engine: round trips, net after fees, drawdown." |
| 1:20 | Toggle **Funding skew**, show skewApplied + $/day | "Funding on Strike is hourly. The skew tilts rung sizes so the inventory you accumulate sits on the side that receives it. Spread plus carry from one ladder." |
| 1:32 | Switch to **Live** (already connected) | "Live, mainnet, builder code vektor. Real book, real walls, and the L3 feed — order-level — flagging spoofs and icebergs." |
| 1:45 | Show the running live grid log + Proof ↗ | "Here's a real grid resting on ADA. And this is the part I care about most: the proof page re-reads my fills from Strike's public API in your browser and prints the curl commands. Don't trust the screenshot — run them." |
| 2:05 | Terminal: `npm run cli -- status` / worker status JSON | "Same engines run headless 24/7 in a worker, from a CLI, and from an AI agent via a Strike-style skill." |
| 2:18 | Sidebar: Regime guard + Vault panel | "Regime guard pauses or widens grids on Fear & Greed and OI shocks. And vault_id is already threaded through every order — next step is a Vektor grid vault anyone can deposit into." |
| 2:28 | Landing page CTA | "Vektor. Built on Strike, pays Strike builders, verifiable on Strike. Thanks." |

Cuts to avoid: wallet signature popups (pre-connect), any wait > 2 s (speed the sim to 3× in the tour — it does this automatically).
