// Values quoted in the docs. Engine values are imported from the code so the
// docs cannot drift; deployment facts that live outside the code are written once
// here with where they were checked.
import { DEFAULT_SHIELD_RULES } from "../quant/liquidationShield";
import { HOURS_PER_YEAR } from "../quant/fundingHarvester";
import { SKEW_REF_RATE, DEFAULT_MAX_SKEW, GRID_CID_PREFIX } from "../quant/gridEngine";
import { THRESHOLDS } from "../quant/regime";
import { DEMO_MARKETS } from "../sim/demoMarkets";

export const SHIELD = DEFAULT_SHIELD_RULES;
export const HOURS_YEAR = HOURS_PER_YEAR;
export const SKEW = { refRateHourly: SKEW_REF_RATE, maxSkew: DEFAULT_MAX_SKEW };
export const GRID_PREFIX = GRID_CID_PREFIX;
export const GRID_LEVELS = { min: 4, max: 60 }; // planGrid() in src/quant/gridEngine.ts
export const REGIME = THRESHOLDS;
export const DEMO_SYMBOLS = Object.keys(DEMO_MARKETS);
export const DEMO_WALLET_USD = 10_000; // createSim() in src/hooks/useVektor.ts
export const WATCHDOG_SECONDS = 8; // live watchdog in src/hooks/useVektor.ts

// Deployment facts - checked on mainnet 2026-10-22 (README §5b).
export const APP_NAME = "Vektor";
export const BUILDER_CODE = "vektor";
export const BUILDER_FEE_BPS = 10;
export const BUILDER_FEE_CAP_BPS = 100; // Strike's maximum fee share
export const API_HOST = "https://api.strikefinance.org";
export const PRICE_HOST = "https://api.strikefinance.org/price";
export const STRIKE_APP = "https://app.strikefinance.org";
export const STRIKE_DOCS = "https://docs.strikefinance.org";
export const REPO_URL = "https://github.com/mrnetwork0001/Vektor";
export const ADA_MIN_NOTIONAL_MAINNET = 10; // GET /v2/markets ADA-USD order_min_notional
export const WITHDRAW_MIN = 5;
export const WITHDRAW_FEE = 1;

export const PROOF = {
  ownerAccount: "01a162e1-f0fb-77f4-8958-8adaf4b9a2b9",
  builderAccount: "01a164cf-36b1-7387-aa2f-199cc57f8c3f",
  cardanoAccount: "01a16503-d2a3-74ad-855e-2362748ad8bb",
  ethDepositTx: "0x5000652a28260cc9152cb5df90327cf57c756ac0748b7fd7ec4f1c1416abd7e8",
  solDepositTx: "3Gf7BvvapQ1yKLNKrnsjrKSMz2PQUgc84JmqRQqMEKT9uPbsGihhBq1tfFEWFC1tLdJfpBNtShfxukHrpa36H9mW",
};
