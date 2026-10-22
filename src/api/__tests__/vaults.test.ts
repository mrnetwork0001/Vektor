import { describe, it, expect, vi, afterEach } from "vitest";
import { listVaults, getVaultPortfolio, toShares8, vaultIdFromAccountId, withVault, pendingLeaderFee, summarizeVault, type Vault, type VaultPortfolio } from "../vaults";
import { planGrid, initGridState, buildDeployOrders, applyGridFill } from "../../quant/gridEngine";

afterEach(() => vi.unstubAllGlobals());

const vault: Vault = {
  vault_id: "536b4d72-687d-5e8e-a3be-cef0757c795f", type: "user", name: "MARKET WIZARDS", account_id: "vault_536b4d72",
  leader_account_id: "019fb258-2d11-7175-9a89-34a0df514a8c", leader_commission_bps: 500, total_shares: "1993.33471332",
  share_price: "0.9409091306425472555", equity: "1875.546832189532361", wallet_balance: "1964.678340559532361",
  min_leader_share_pct: 5, lockup_days: 1, min_deposit: "50", allow_proportional_close: true, status: "active", is_verified: false,
  created_at: 1789833609240, apr: "-66.9517", all_time_pnl: "-115.56", return_24h: "-3.44", depositors: 5, fee_earned: "0",
};

describe("vault helpers", () => {
  it("truncates shares to 8 decimals without rounding up", () => {
    expect(toShares8("100.123456789")).toBe("100.12345678");
    expect(toShares8("100.5")).toBe("100.5");
    expect(toShares8("100")).toBe("100");
    expect(toShares8("7.000000001")).toBe("7");
  });
  it("maps vault_ account ids to UUIDs and tags order bodies", () => {
    expect(vaultIdFromAccountId("vault_536b4d72", [vault])).toBe(vault.vault_id);
    expect(vaultIdFromAccountId("vault_nope", [vault])).toBeNull();
    expect(withVault({ symbol: "ADA-USD" }, vault.vault_id)).toEqual({ symbol: "ADA-USD", vault_id: vault.vault_id });
    expect(withVault({ symbol: "ADA-USD" }, null)).toEqual({ symbol: "ADA-USD" });
  });
  it("computes the unrealized leader fee from the portfolio formula", () => {
    expect(pendingLeaderFee({ commission_bps: 1000, pending_fees_profitable_shares: "1000", pending_fees_profitable_basis: "1000" }, 1.2)).toBeCloseTo(20, 6);
    expect(pendingLeaderFee({ commission_bps: 1000, pending_fees_profitable_shares: "1000", pending_fees_profitable_basis: "1000" }, 0.9)).toBe(0);
  });
  it("summarizes list + portfolio rows (portfolio wins where present)", () => {
    const p = { total_value_locked: "1875.31", apr: "-68.86", all_time_pnl: "-115.79", return_24h: "-4.54", depositors: 5, fee_earned: "0", volume: "9362.25", max_drawdown: "4.35" } as VaultPortfolio;
    const s = summarizeVault(vault, p);
    expect(s).toMatchObject({ name: "MARKET WIZARDS", tvlUsd: 1875.31, aprPct: -68.86, leaderFeePct: 5, depositors: 5, volumeUsd: 9362.25, maxDrawdownPct: 4.35, lockupDays: 1, minDepositUsd: 50 });
    expect(summarizeVault(vault).tvlUsd).toBeCloseTo(1875.5468, 3);
  });
});

describe("vault reads (mocked fetch)", () => {
  it("lists vaults by leader and reads a portfolio", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/v2/vaults?")) return { ok: true, status: 200, json: async () => ({ vaults: [vault], count: 1 }) };
      if (url.includes("/portfolio")) return { ok: true, status: 200, json: async () => ({ vault_id: vault.vault_id, total_value_locked: "1875", depositors: 5, commission_bps: 500 }) };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const mine = await listVaults({ leader_account_id: vault.leader_account_id });
    expect(mine.vaults[0].account_id).toBe("vault_536b4d72");
    expect(fetchMock.mock.calls[0][0]).toContain(`leader_account_id=${vault.leader_account_id}`);
    const p = await getVaultPortfolio(vault.vault_id, "7d");
    expect(p.total_value_locked).toBe("1875");
    expect(fetchMock.mock.calls[1][0]).toContain("period=7d");
  });
});

describe("grid orders carry vault_id when a vault is selected", () => {
  const rules = { symbol: "ADA-USD", tick: 0.0001, stepSize: 1, minSize: 1, minNotional: 5, basePrec: 0, quotePrec: 4 };
  const fees = { makerRate: 0, takerRate: 0.0005, builderFeeBps: 10 };
  it("deploy and counter orders include vault_id; plain grids don't", () => {
    const plan = planGrid({ symbol: "ADA-USD", lowerPrice: 0.38, upperPrice: 0.46, markPrice: 0.42, levels: 9, marginUsd: 600, leverage: 3, mode: "ARITHMETIC", vaultId: vault.vault_id }, rules, fees);
    const { orders } = buildDeployOrders(plan);
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((o) => o.vault_id === vault.vault_id)).toBe(true);
    const state = initGridState(plan);
    const buy = state.rungs[3].resting[0];
    const r = applyGridFill(state, { symbol: "ADA-USD", clientOrderId: buy.clientOrderId, orderId: 1, side: "BUY", fillQty: buy.size, fillPrice: state.rungs[3].price, cumFilled: buy.size, orderQty: buy.size, isMaker: true, commission: 0, builderFee: 0, timestamp: 0, status: "FILLED" });
    expect(r.orders[0].vault_id).toBe(vault.vault_id);

    const plain = planGrid({ symbol: "ADA-USD", lowerPrice: 0.38, upperPrice: 0.46, markPrice: 0.42, levels: 9, marginUsd: 600, leverage: 3, mode: "ARITHMETIC" }, rules, fees);
    expect(buildDeployOrders(plain).orders.every((o) => !("vault_id" in o))).toBe(true);
  });
});
