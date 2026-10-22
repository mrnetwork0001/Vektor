import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplayGuard, enrollMessage, publicKeyOf, requestMessage, signMessage, verifySig } from "../auth";
import { TenantStore, seal, unseal, parseMasterKey } from "../store";
import { AccountEngine, type EngineClient, type MarketHub } from "../engine";
import type { Market } from "../../src/types/market";

const PRIV = "11".repeat(32);
const PUB = publicKeyOf(PRIV);
const MASTER = parseMasterKey("ab".repeat(32));

describe("auth", () => {
  it("verifies enroll and request signatures and rejects tampering", () => {
    const ts = Date.now();
    const sig = signMessage(PRIV, enrollMessage(ts, PUB));
    expect(verifySig(PUB, enrollMessage(ts, PUB), sig)).toBe(true);
    expect(verifySig(PUB, enrollMessage(ts + 1, PUB), sig)).toBe(false);
    const rs = signMessage(PRIV, requestMessage("POST", "/v1/grids", ts, '{"a":1}'));
    expect(verifySig(PUB, requestMessage("POST", "/v1/grids", ts, '{"a":1}'), rs)).toBe(true);
    expect(verifySig(PUB, requestMessage("POST", "/v1/grids", ts, '{"a":2}'), rs)).toBe(false);
    expect(verifySig("zz", "x", rs)).toBe(false);
  });
  it("rejects stale timestamps and replayed signatures", () => {
    const g = new ReplayGuard(120_000);
    const now = 1_000_000;
    expect(g.check("s1", now, now)).toBeNull();
    expect(g.check("s1", now, now + 10)).toBe("replayed signature");
    expect(g.check("s2", now - 200_000, now)).toBe("stale or future timestamp");
    expect(g.check("s3", now + 200_000, now)).toBe("stale or future timestamp");
  });
});

describe("store", () => {
  it("round-trips AES-256-GCM and detects tampering", () => {
    const s = seal(MASTER, PRIV);
    expect(s.data).not.toContain(PRIV);
    expect(unseal(MASTER, s)).toBe(PRIV);
    expect(() => unseal(MASTER, { ...s, data: s.data.replace(/^./, (c) => (c === "0" ? "1" : "0")) })).toThrow();
    expect(() => parseMasterKey("short")).toThrow();
  });
  it("persists tenants encrypted and removes them", () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-"));
    const path = join(dir, "tenants.json");
    const st = new TenantStore(path, MASTER);
    st.upsert({ publicKey: PUB, privateKey: PRIV, accountId: "acc-1", builderCode: "vektor", feeShareBps: 10 });
    expect(readFileSync(path, "utf8")).not.toContain(PRIV);
    const again = new TenantStore(path, MASTER);
    expect(again.get(PUB)?.accountId).toBe("acc-1");
    expect(again.privateKey(PUB)).toBe(PRIV);
    again.remove(PUB);
    expect(new TenantStore(path, MASTER).size).toBe(0);
  });
});

// ── AccountEngine with a fake Strike client ──
const market = {
  symbol: "ADA-USD", base_prec: 0, quote_prec: 5, default_leverage: 20, mark_price: "0.21",
  order_tick_price: "0.00001", order_limit_step_size: "1", order_limit_min_size: "1", order_min_notional: "10",
  margin_tiers: [{ max_notional: "50000", max_leverage: 20, maintenance_margin_rate: "0.01", maintenance_amount: "0" }],
} as unknown as Market;

function fakeClient() {
  const calls: { method: string; path: string; body?: any; headers?: Record<string, string> }[] = [];
  const client: EngineClient = {
    async call(method, path, body, extra) {
      calls.push({ method, path, body, headers: extra });
      if (path === "/v2/orders/batch") return { status: 200, json: { successful: [], failed: null } as any };
      return { status: 200, json: {} as any };
    },
    userStream() { return () => {}; },
  };
  return { client, calls };
}

describe("AccountEngine", () => {
  const hub: MarketHub = { markets: { "ADA-USD": market }, marks: { "ADA-USD": { p: 0.21, r: 0 } }, regime: {} };
  const cfg = { symbol: "ADA-USD", lowerPrice: 0.209, upperPrice: 0.211, levels: 4, marginUsd: 14, leverage: 3, mode: "ARITHMETIC" as const };

  it("deploys with leverage + builder fee, places the counter on a fill once, and stops", async () => {
    const { client, calls } = fakeClient();
    const eng = new AccountEngine(client, hub, { builderFeeBps: 10, log: () => {}, persist: () => {} });
    await eng.deployGrid(cfg);
    expect(calls.find((c) => c.path === "/v2/leverage")?.body).toMatchObject({ symbol: "ADA-USD", leverage: 3 });
    const batch = calls.find((c) => c.path === "/v2/orders/batch")!;
    expect(batch.headers?.["X-Builder-Fee-Bps"]).toBe("10");
    const entry = batch.body.orders[0];

    const fill = (tradeId: number) => eng.onStreamEvent("ORDER_TRADE_UPDATE", {
      s: "ADA-USD", c: entry.client_order_id, S: entry.side.toUpperCase(), q: entry.size, z: entry.size, l: entry.size, L: entry.price,
      X: "FILLED", t: tradeId, i: 1, n: "0", m: true, E: Date.now(), builder_fee: "0.01",
    });
    const before = calls.filter((c) => c.path === "/v2/orders/batch").length;
    fill(77);
    await new Promise((r) => setTimeout(r, 0));
    const after = calls.filter((c) => c.path === "/v2/orders/batch").length;
    expect(after).toBe(before + 1); // counter order
    expect(eng.telemetry.fills).toBe(1);
    expect(eng.telemetry.builderFeesUsd).toBeCloseTo(0.01);

    fill(77); // duplicate delivery
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.path === "/v2/orders/batch").length).toBe(after);
    expect(eng.telemetry.fills).toBe(1);

    const ok = await eng.stopGrid("ADA-USD");
    expect(ok).toBe(true);
    expect(eng.grids["ADA-USD"]).toBeUndefined();
    expect(calls.filter((c) => c.path === "/v2/order/cancel").length).toBeGreaterThan(0);
  });

  it("refuses to deploy under a regime PAUSE unless the guard is off, and refuses sub-minimum rungs", async () => {
    const { client } = fakeClient();
    const paused: MarketHub = { ...hub, regime: { "ADA-USD": { recommendation: { action: "PAUSE" } } as any } };
    const eng = new AccountEngine(client, paused, { builderFeeBps: 10, log: () => {}, persist: () => {} });
    await expect(eng.deployGrid(cfg)).rejects.toThrow(/regime guard/);
    await expect(eng.deployGrid({ ...cfg, regimeGuard: false })).resolves.toBeTruthy();
    await expect(eng.deployGrid({ ...cfg, regimeGuard: false, marginUsd: 2 })).rejects.toThrow(/below min/i);
  });
});
