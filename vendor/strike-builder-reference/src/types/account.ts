// ── Account data from GET /v2/account ──
// Decimals are serialized as strings (govalues/decimal).

export interface SymbolSettings {
  margin_mode: "cross" | "isolated";
  leverage: number;
  allow_pre_trade: boolean;
}

export interface Account {
  account_id: string;
  name?: string; // sub-accounts only
  parent_account_id?: string; // sub-accounts only
  parent_blockchain_address?: string; // sub-accounts only
  blockchain: string;
  blockchain_address: string | null; // null for sub-accounts
  nickname?: string;
  avatar_url?: string;
  wallet_balance: string;
  // Base Balance − Σ(cross) IM + Σ(cross) uPnL. Can be negative; once a copy
  // hold (unused copy reservation or unpaid profit share) is positive, those
  // holds are subtracted and the result is floored at 0.
  available_balance: string;
  copy_reserved_balance: string;
  copy_deployed_margin: string;
  copy_profit_share_reserved: string;
  unrealized_pnl: string; // Σ uPnL of ALL positions
  // CROSS margin balance: wallet − Σ(isolated) iso_balance + Σ(cross) uPnL
  margin_balance: string;
  total_margin: string; // legacy: position_initial_margin + maintenance_margin
  position_initial_margin: string; // Σ IM of all positions
  maintenance_margin: string; // Σ MM of all positions
  sub_accounts: { account_id: string; name: string }[];
  default_margin_mode: "cross" | "isolated";
  default_leverage: number;
  // Only symbols with stored settings. Use GET /v2/symbols for the effective
  // settings of every listed market.
  symbol_settings?: Record<string, SymbolSettings>;
}

// ── GET /v2/symbols — effective margin mode + leverage for every listed market ──

export interface SymbolsResponse {
  default_margin_mode: "cross" | "isolated";
  default_leverage: number;
  symbol_settings: Record<string, { margin_mode: "cross" | "isolated"; leverage: number }>;
}

// ── Builder Connect (POST /auth/builder/verify-signature) ──

export type BuilderReferralStatus =
  | "accepted"
  | "already_accepted"
  | "already_set"
  | "skipped_self_referral"
  | "skipped_circular_referral"
  | "not_requested"
  | "failed";

export interface BuilderConnectResult {
  account_id: string;
  nickname: string;
  avatar_url: string;
  builder_code: string;
  fee_share_bps: number; // approved max builder fee for this user (bps)
  api_wallet_id: number;
  api_wallet_public_key: string;
  api_wallet_expired_at: string; // RFC3339
  referral: { status: BuilderReferralStatus; code?: string };
}

// ── GET /v2/fee-tiers (public) ──
// feeTiers rows use Go field names (no json tags); rates are numbers.

export interface FeeTierConfig {
  Tier: number;
  MinVolume: number;
  TakerRate: number;
  MakerRate: number;
}

export interface FeeTiersResponse {
  feeTiers: FeeTierConfig[];
  makerRebateTiers: { tier: number; minMakerVolumeShare: number; makerRate: number }[];
  stakingFeeDiscountTiers: { tier: number; minStakedStrike: number; discountRate: number }[] | null;
  referralTiers?: {
    tier: number;
    name: string;
    min_referred_volume: number;
    reward_rate: number;
    referee_discount_rate: number;
  }[];
}

// ── GET /v2/portfolio — fee-related subset (full response has many more fields) ──

export interface PortfolioFeeInfo {
  fee_tier: number;
  fee_tiers: FeeTierConfig[];
  maker_fee_rate_override: string | null;
  fee_discount_rate: number; // referral discount, whole percent (4 = 4%)
  staking_fee_discount_rate: string; // fraction, e.g. "0.1"
  staking_fee_discount_tiers: { tier: number; minStakedStrike: number; discountRate: number }[] | null;
  is_trading_enabled: boolean;
  min_deposit_usd: number;
  min_withdraw_usd: number;
}
