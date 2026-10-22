/**
 * Strike vaults - leader-managed pooled trading accounts.
 * A vault is its own trading account; the leader trades it by adding
 * `vault_id` to ordinary order requests. Public reads need no auth.
 * Full notes and verified endpoints: docs/VAULTS.md
 */

import { API_BASE_URL } from "./config";
import { authenticatedFetch, throwApiError } from "./auth";

export interface Vault {
  vault_id: string;
  type: "user" | "protocol";
  name: string;
  description?: string;
  account_id: string; // "vault_" + first 8 chars of vault_id - NOT usable as a REST account_id selector
  leader_account_id: string;
  nickname?: string;
  leader_commission_bps: number;
  total_shares: string;
  share_price: string;
  equity: string;
  wallet_balance: string;
  min_leader_share_pct: number;
  lockup_days: number;
  min_deposit: string;
  allow_proportional_close: boolean;
  status: "active" | "paused" | "closed";
  is_verified: boolean;
  created_at: number;
  // list-only metrics (absent / "" on GET /v2/vault/:id)
  apr?: string;
  return_24h?: string;
  period_return?: string;
  all_time_deposits?: string;
  all_time_withdrawals?: string;
  all_time_pnl?: string;
  depositors?: number;
  fee_earned?: string;
  sharpe_ratio?: string;
}

export interface VaultPortfolio {
  vault_id: string;
  total_value_locked: string;
  apr: string;
  all_time_deposits: string;
  all_time_withdrawals: string;
  all_time_pnl: string;
  return_24h: string;
  period_return: string;
  volume: string;
  all_time_volume: string;
  depositors: number;
  fee: string; // leader fee in percent
  commission_bps: number;
  fee_earned: string;
  pending_fees_owed: string;
  sharpe_ratio?: string;
  max_drawdown?: string;
  created_at: number;
  /** [ts_ms, tvl, pnl, fees_accrued, depositors, share_price] - strings after the timestamp */
  vault_history: [number, string, string, string, string, string][];
}

export interface VaultDepositor {
  address: string;
  nickname?: string;
  deposited: string;
  total_deposited: string;
  total_withdrawn: string;
  current_equity: string;
  share_percentage: string;
  pnl: string;
  deposited_since: number;
}

export interface CreateVaultRequest {
  name: string;
  description?: string;
  initial_deposit: string; // JSON string, ≥ "100" and ≥ min_deposit; taken from withdrawable balance
  leader_commission_bps?: number; // 0–5000, default 1000; engine replaces 0 with 1000
  lockup_days?: number; // 1–30, default 1
  min_deposit?: string; // default "100"
  allow_proportional_close?: boolean; // default false
}

export type VaultPeriod = "24h" | "7d" | "30d" | "6m" | "1y" | "all";

const qs = (p: Record<string, string | number | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
};

// ── Public reads (no auth) ──

export async function listVaults(p: { status?: Vault["status"]; type?: Vault["type"]; leader_account_id?: string; depositor_account_id?: string; period?: VaultPeriod; limit?: number; offset?: number } = {}): Promise<{ vaults: Vault[]; count: number }> {
  const res = await fetch(`${API_BASE_URL}/v2/vaults${qs({ limit: 100, ...p })}`);
  if (!res.ok) throw new Error(`List vaults failed: ${res.status}`);
  const data = await res.json();
  return { vaults: data.vaults ?? [], count: data.count ?? 0 };
}

/** Vaults led by `accountId`. `null` entry means the create is still being processed by the engine. */
export const listMyVaults = (accountId: string) => listVaults({ leader_account_id: accountId });

export async function getVault(vaultId: string): Promise<Vault> {
  const res = await fetch(`${API_BASE_URL}/v2/vault/${encodeURIComponent(vaultId)}`);
  if (!res.ok) throw new Error(res.status === 404 ? "vault not found" : `Get vault failed: ${res.status}`);
  return res.json();
}

export async function getVaultPortfolio(vaultId: string, period: VaultPeriod = "30d"): Promise<VaultPortfolio> {
  const res = await fetch(`${API_BASE_URL}/v2/vault/${encodeURIComponent(vaultId)}/portfolio${qs({ period })}`);
  if (!res.ok) throw new Error(res.status === 404 ? "vault not found" : `Vault portfolio failed: ${res.status}`);
  return res.json();
}

export async function getVaultDepositors(vaultId: string, limit = 100): Promise<{ depositors: VaultDepositor[]; count: number }> {
  const res = await fetch(`${API_BASE_URL}/v2/vault/${encodeURIComponent(vaultId)}/depositors${qs({ limit })}`);
  if (!res.ok) throw new Error(`Vault depositors failed: ${res.status}`);
  const data = await res.json();
  return { depositors: data.depositors ?? [], count: data.count ?? 0 };
}

// ── Leader writes (API wallet, master account only; all async - outcome arrives as VAULT_* user-stream events) ──

/** POST /v2/vault/create - 200 means queued. The new vault_id is NOT returned: poll listMyVaults(). */
export async function createVault(req: CreateVaultRequest): Promise<{ success: boolean; request_id: string; message: string }> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/vault/create`, "POST", req);
  if (!res.ok) return throwApiError(res, "Create vault failed");
  return res.json();
}

export async function pauseVault(vaultId: string): Promise<{ success: boolean; new_status: string }> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/vault/${encodeURIComponent(vaultId)}/pause`, "POST", {});
  if (!res.ok) return throwApiError(res, "Pause vault failed");
  return res.json();
}

export async function resumeVault(vaultId: string): Promise<{ success: boolean; new_status: string }> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/vault/${encodeURIComponent(vaultId)}/resume`, "POST", {});
  if (!res.ok) return throwApiError(res, "Resume vault failed");
  return res.json();
}

/** POST /v2/vault/deposit - from the caller's withdrawable balance; mints shares at the current share price. */
export async function depositToVault(vaultId: string, usdAmount: string): Promise<{ success: boolean; request_id: string }> {
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/vault/deposit`, "POST", { vault_id: vaultId, usd_amount: usdAmount });
  if (!res.ok) return throwApiError(res, "Vault deposit failed");
  return res.json();
}

/** POST /v2/vault/withdraw - deferred by lockup_days; request_id is the withdrawal_id. Shares ≤ 8 decimals. */
export async function withdrawFromVault(vaultId: string, shares: string | "all"): Promise<{ success: boolean; request_id: string }> {
  const body = shares === "all" ? { vault_id: vaultId, withdraw_all: true } : { vault_id: vaultId, shares: toShares8(shares) };
  const res = await authenticatedFetch(`${API_BASE_URL}/v2/vault/withdraw`, "POST", body);
  if (!res.ok) return throwApiError(res, "Vault withdraw failed");
  return res.json();
}

// ── Pure helpers ──

/** Shares must have at most 8 decimals - truncate, never round up. */
export function toShares8(s: string): string {
  const [i, f = ""] = String(s).split(".");
  const frac = f.slice(0, 8).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i;
}

/** Resolve the UUID `vault_id` from a `vault_xxxxxxxx` account id using a vault list (the REST selector needs the UUID). */
export function vaultIdFromAccountId(vaultAccountId: string, vaults: Vault[]): string | null {
  return vaults.find((v) => v.account_id === vaultAccountId)?.vault_id ?? null;
}

/** Add `vault_id` to any order-shaped body when a vault is selected; no-op otherwise. */
export function withVault<T extends object>(body: T, vaultId?: string | null): T & { vault_id?: string } {
  return vaultId ? { ...body, vault_id: vaultId } : body;
}

/** Live unrealized leader fee: max(0, bps/10000 × (p × profitable_shares − profitable_basis)). */
export function pendingLeaderFee(portfolio: Pick<VaultPortfolio, "commission_bps"> & { pending_fees_profitable_shares: string; pending_fees_profitable_basis: string }, sharePrice: number): number {
  const v = (portfolio.commission_bps / 10000) * (sharePrice * parseFloat(portfolio.pending_fees_profitable_shares) - parseFloat(portfolio.pending_fees_profitable_basis));
  return Math.max(0, Number.isFinite(v) ? v : 0);
}

/** Compact summary for a performance card from the public list/portfolio rows. */
export function summarizeVault(v: Vault, p?: VaultPortfolio | null) {
  const n = (s?: string) => { const x = parseFloat(s ?? ""); return Number.isFinite(x) ? x : 0; };
  return {
    name: v.name,
    status: v.status,
    tvlUsd: n(p?.total_value_locked ?? v.equity),
    sharePrice: n(v.share_price),
    aprPct: n(p?.apr ?? v.apr),
    allTimePnlUsd: n(p?.all_time_pnl ?? v.all_time_pnl),
    return24hPct: n(p?.return_24h ?? v.return_24h),
    depositors: p?.depositors ?? v.depositors ?? 0,
    leaderFeePct: v.leader_commission_bps / 100,
    feeEarnedUsd: n(p?.fee_earned ?? v.fee_earned),
    volumeUsd: n(p?.volume),
    maxDrawdownPct: n(p?.max_drawdown),
    lockupDays: v.lockup_days,
    minDepositUsd: n(v.min_deposit),
  };
}
