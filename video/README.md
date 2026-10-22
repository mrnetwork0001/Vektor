# Vektor demo film

Remotion film for the Strike Finance hackathon. 13 scenes, about 2:43, narrated by Sarah (ElevenLabs).

## What is real
- **On-chain figures.** Every hash, block, slot, time and amount comes from `data/onchain.json`, read back by `scripts/onchain.mjs` (read-only). Sources are Strike's public selectors, Ethereum and Solana public RPC, and Koios.
- **Builder fee.** The $0.01 builder fee on the 18:33:53 UTC fill appears on Strike's user-stream fill event, not in public history, and the film says so. "builder fees $0.06 · fills 6" is the app's own live telemetry, shown as such.
- **Demo footage.** The Grid Studio, Backtest, Funding Harvester and Aegis Shield clips were recorded on https://tryvektor.vercel.app in **Demo mode**: a simulated book, with no orders or deposits placed. Each one carries a "Demo mode" tag on its browser frame. Clicks were demo-only.
- **Live footage.** `public/footage/owner/autopilot-live.mp4` was recorded by the owner on the live Cardano account (01a16503…). It is tagged "Live · mainnet" and shows the server-run Autopilot fill at 19:59:56 UTC (21:59:56 local).
- **Proof page.** The `proof_ada` clip is the public `/proof.html` for the same account.
- **Logos.** All logos are official and unaltered, kept in `public/logos/`:
  - Strike Finance: `strike-white.svg`, from https://www.strikefinance.org/logo-white.svg (the Strike app's own header asset).
  - Ethereum: `ethereum.svg`, from https://ethereum.org/images/assets/svgs/eth-diamond-rainbow.svg (ethereum.org brand assets).
  - Solana: `solana.svg`, from https://solana.com/src/img/branding/solanaLogoMark.svg (Solana branding kit).
  - Cardano: `cardano-white.svg` and `cardano-blue.svg`, from https://cardano.org/img/cardano-white.svg and https://cardano.org/img/cardano-black.svg (cardano.org brand).
  - Vektor: `vektor-lockup.png` and `vektor-mark.png`, the owner's official brand files.

## Build it
```bash
npm install
npm run onchain                      # refresh data/onchain.json (read-only)
node scripts/voiceover.mjs           # ElevenLabs VO (key read at runtime from ../../Syntura/video/.env, never printed)
npm run timing                       # word timings -> src/timing.json, then caption cleanup
node scripts/music.mjs && node scripts/sfx.mjs
ONLY=landing,grid,backtest,shield,harvester,docs,proof,proof_ada node scripts/capture.mjs   # needs the SOCKS tunnel on :1080
node scripts/encode.mjs
npm run draft                        # half-scale draft -> out/draft.mp4
```
The capture goes through `ssh -N -D 1080 root@38.49.213.208`. It uses that host only as a tunnel: nothing is installed or run there.
