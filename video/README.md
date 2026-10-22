# Vektor demo film

Remotion film for the Strike Finance hackathon. Target 2:40 (2:00 to 3:00), 13 scenes.

## What is real
Every figure the film quotes is read back from public sources by `scripts/onchain.mjs` into `data/onchain.json` (Strike public selectors, Ethereum and Solana public RPC, Koios). The builder fee appears only on Strike's user-stream fill event, not in public history; the film labels it that way. Anything simulated (demo mode, backtests) is labelled on screen.

## Build it
```bash
npm install
npm run onchain   # refresh data/onchain.json (read-only)
```
Voice, music, timing, capture and render steps follow in later phases.
