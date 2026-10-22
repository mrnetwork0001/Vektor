// ── Synthetic price + order book for demo mode ──

import type { OrderBookDepthResponse } from "../types/market";

export type Scenario = "RANGE" | "TREND_UP" | "TREND_DOWN" | "FLASH_CRASH" | "SQUEEZE";

export interface PriceSimState {
  price: number;
  anchor: number; // mean-reversion centre for RANGE
  scenario: Scenario;
  scenarioTicksLeft: number;
  seed: number;
}

export function createPriceSim(start: number, seed = 42): PriceSimState {
  return { price: start, anchor: start, scenario: "RANGE", scenarioTicksLeft: 0, seed };
}

/** Deterministic PRNG so demo replays are reproducible. */
function rand(state: PriceSimState) {
  state.seed = (state.seed * 1664525 + 1013904223) % 4294967296;
  return state.seed / 4294967296;
}
function gauss(state: PriceSimState) {
  const u = Math.max(rand(state), 1e-9), v = rand(state);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function triggerScenario(state: PriceSimState, scenario: Scenario, ticks = 25) {
  state.scenario = scenario;
  state.scenarioTicksLeft = ticks;
}

/** One tick (~1 s of market time). Range: mean-reverting ~0.35% vol. Crash: −12% over the scenario. */
export function stepPrice(state: PriceSimState, volPct = 0.35): number {
  let drift = 0;
  let vol = volPct / 100;
  switch (state.scenario) {
    case "RANGE":
      drift = ((state.anchor - state.price) / state.price) * 0.05;
      break;
    case "TREND_UP": drift = 0.0015; vol *= 1.2; break;
    case "TREND_DOWN": drift = -0.0015; vol *= 1.2; break;
    case "FLASH_CRASH": drift = -0.12 / 25; vol *= 2.5; break;
    case "SQUEEZE": drift = 0.10 / 25; vol *= 2.5; break;
  }
  state.price = state.price * (1 + drift + vol * gauss(state));
  if (state.scenarioTicksLeft > 0 && --state.scenarioTicksLeft === 0) {
    state.scenario = "RANGE";
    state.anchor = state.price;
  }
  return state.price;
}

/** Top-20 synthetic book with a couple of whale walls that drift with price. */
export function syntheticDepth(mark: number, tick: number, state: PriceSimState, levels = 20): OrderBookDepthResponse {
  const bids: string[][] = [];
  const asks: string[][] = [];
  const dec = Math.max(0, Math.ceil(-Math.log10(tick)));
  const baseQty = 50_000 / mark; // ~$50k per level
  for (let i = 1; i <= levels; i++) {
    const spread = tick * (2 + i * 3);
    const wallBid = i === 4 || i === 11;
    const wallAsk = i === 7;
    const qB = baseQty * (0.4 + rand(state) * 1.2) * (wallBid ? 6 : 1);
    const qA = baseQty * (0.4 + rand(state) * 1.2) * (wallAsk ? 5 : 1);
    bids.push([(mark - spread).toFixed(dec), qB.toFixed(2)]);
    asks.push([(mark + spread).toFixed(dec), qA.toFixed(2)]);
  }
  return { lastUpdateId: Date.now(), E: Date.now(), T: Date.now(), bids, asks };
}
