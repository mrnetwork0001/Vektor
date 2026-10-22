/**
 * Vektor Autopilot - multi-tenant server that keeps each user's grids and
 * shield running after they close the browser. Users enroll their own Strike
 * API wallet (trade-only, cannot withdraw); every request is signed with it.
 *
 *   VEKTOR_MASTER_KEY    32-byte hex, encrypts stored keys (required)
 *   VEKTOR_HOST/PORT     default 127.0.0.1:8920 (put nginx in front)
 *   VEKTOR_DATA          tenant store, default server/data/tenants.json
 *   VEKTOR_ALLOW_ORIGIN  comma list of allowed browser origins, or *
 *   VEKTOR_MAX_TENANTS   default 50
 *   BUILDER_FEE_BPS      default 10 (capped by each tenant's approval)
 *   STRIKE_API_URL       default https://api.strikefinance.org
 *
 *   npm run autopilot
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { StrikeClient } from "../worker/strikeClient";
import { AccountEngine, type GridRequest } from "./engine";
import { Hub } from "./hub";
import { TenantStore, atomicWrite, parseMasterKey } from "./store";
import { ReplayGuard, enrollMessage, publicKeyOf, requestMessage, verifySig } from "./auth";

const env = (k: string, d: string) => process.env[k] ?? d;
const API = env("STRIKE_API_URL", "https://api.strikefinance.org");
const HOST = env("VEKTOR_HOST", "127.0.0.1");
const PORT = Number(env("VEKTOR_PORT", "8920"));
const DATA = env("VEKTOR_DATA", "server/data/tenants.json");
const ALLOW = env("VEKTOR_ALLOW_ORIGIN", "*").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_TENANTS = Number(env("VEKTOR_MAX_TENANTS", "50"));
const FEE_BPS = Number(env("BUILDER_FEE_BPS", "10"));

const master = parseMasterKey(process.env.VEKTOR_MASTER_KEY);
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const tlog = (pub: string) => (m: string) => log(`[${pub.slice(0, 8)}] ${m}`);

const store = new TenantStore(DATA, master);
const hub = new Hub(API, log);
const engines = new Map<string, AccountEngine>();
const replay = new ReplayGuard();

function clientFor(publicKey: string, privateKey: string) {
  return new StrikeClient({
    apiUrl: API, priceUrl: `${API}/price`, userWsUrl: API.replace("https://", "wss://") + "/ws/user-api", priceWsUrl: API.replace("https://", "wss://") + "/ws/price",
    publicKey, privateKey, builderFeeBps: 0,
  });
}

async function startEngine(pub: string) {
  const rec = store.get(pub)!;
  const statePath = store.statePath(pub);
  const snap = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : undefined;
  const fee = Math.min(FEE_BPS, rec.feeShareBps ?? FEE_BPS);
  const eng = new AccountEngine(clientFor(pub, store.privateKey(pub)), hub, {
    builderFeeBps: rec.builderCode ? fee : 0, log: tlog(pub),
    persist: (s) => { try { atomicWrite(statePath, JSON.stringify(s)); } catch (e: any) { tlog(pub)(`persist failed: ${e.message}`); } },
  }, snap);
  engines.set(pub, eng);
  await eng.start();
  tlog(pub)(`engine started (account ${rec.accountId}, builder ${rec.builderCode ?? "none"} @ ${rec.builderCode ? fee : 0} bps)`);
}

// ── HTTP ──
const send = (res: ServerResponse, code: number, body: unknown) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); };
const readBody = (req: IncomingMessage) => new Promise<string>((ok, bad) => {
  let s = ""; req.on("data", (c) => { s += c; if (s.length > 65_536) { bad(new Error("body too large")); req.destroy(); } }); req.on("end", () => ok(s)); req.on("error", bad);
});

function authenticate(req: IncomingMessage, path: string, body: string): string | { error: string } {
  const pub = String(req.headers["x-vektor-key"] ?? "").toLowerCase();
  const ts = Number(req.headers["x-vektor-ts"]);
  const sig = String(req.headers["x-vektor-sig"] ?? "");
  if (!store.get(pub)) return { error: "not enrolled" };
  if (!verifySig(pub, requestMessage(req.method ?? "GET", path, ts, body), sig)) return { error: "bad signature" };
  const r = replay.check(sig, ts);
  return r ? { error: r } : pub;
}

createServer(async (req, res) => {
  const origin = String(req.headers.origin ?? "");
  res.setHeader("Access-Control-Allow-Origin", ALLOW.includes("*") ? "*" : ALLOW.includes(origin) ? origin : ALLOW[0] ?? "");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-vektor-key, x-vektor-ts, x-vektor-sig");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  const path = (req.url ?? "/").split("?")[0];
  try {
    const body = req.method === "GET" ? "" : await readBody(req);
    if (path === "/health") return send(res, 200, { ok: true, tenants: store.size, maxTenants: MAX_TENANTS, markets: Object.keys(hub.markets).length, uptimeSec: Math.round(process.uptime()) });

    if (path === "/v1/enroll" && req.method === "POST") {
      const { publicKey, privateKey, ts, sig, builderCode, feeShareBps } = JSON.parse(body || "{}");
      const pub = String(publicKey ?? "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(pub) || !/^[0-9a-fA-F]{64}([0-9a-fA-F]{64})?$/.test(String(privateKey ?? ""))) return send(res, 400, { error: "keys must be raw hex" });
      if (publicKeyOf(privateKey) !== pub) return send(res, 400, { error: "private key does not match public key" });
      if (!verifySig(pub, enrollMessage(Number(ts), pub), String(sig ?? ""))) return send(res, 401, { error: "bad signature" });
      const r = replay.check(String(sig), Number(ts)); if (r) return send(res, 401, { error: r });
      if (!store.get(pub) && store.size >= MAX_TENANTS) return send(res, 503, { error: "autopilot is full" });
      const acc = await clientFor(pub, privateKey).call("GET", "/v2/account").catch((e: Error) => ({ status: 401, json: { error: e.message } }));
      if (acc.status !== 200 || !acc.json?.account_id) return send(res, 401, { error: `Strike rejected the key: ${acc.json?.error ?? acc.status}` });
      engines.get(pub)?.stop(); engines.delete(pub);
      store.upsert({ publicKey: pub, privateKey: String(privateKey).slice(0, 64).toLowerCase(), accountId: acc.json.account_id, builderCode: builderCode || undefined, feeShareBps: Number.isFinite(Number(feeShareBps)) ? Number(feeShareBps) : undefined });
      await startEngine(pub);
      return send(res, 200, { ok: true, accountId: acc.json.account_id });
    }

    if (!path.startsWith("/v1/")) return send(res, 404, { error: "not found" });
    const who = authenticate(req, path, body);
    if (typeof who !== "string") return send(res, 401, who);
    const eng = engines.get(who);
    if (!eng) return send(res, 503, { error: "engine not running" });

    if (path === "/v1/status" && req.method === "GET") return send(res, 200, eng.status());
    if (path === "/v1/grids" && req.method === "POST") {
      const g: GridRequest = JSON.parse(body || "{}");
      if (!g.symbol || !(g.levels >= 4)) return send(res, 400, { error: "symbol and levels required" });
      const plan = await eng.deployGrid(g);
      return send(res, 200, { ok: true, gridId: plan.gridId, rungs: plan.rungs.length, warnings: plan.warnings });
    }
    const m = /^\/v1\/grids\/([A-Za-z0-9-]+)$/.exec(path);
    if (m && req.method === "DELETE") return send(res, 200, { ok: await eng.stopGrid(m[1]) });
    if (path === "/v1/panic" && req.method === "POST") { await eng.panic(); return send(res, 200, { ok: true }); }
    if (path === "/v1/enroll" && req.method === "DELETE") {
      for (const sym of Object.keys(eng.grids)) await eng.stopGrid(sym);
      eng.stop(); engines.delete(who); store.remove(who);
      tlog(who)("disabled: grids stopped, key wiped");
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "not found" });
  } catch (e: any) {
    log(`error ${req.method} ${path}: ${e.message}`);
    return send(res, 400, { error: e.message });
  }
}).listen(PORT, HOST, async () => {
  log(`autopilot on http://${HOST}:${PORT} · ${store.size} tenant(s) · builder fee ${FEE_BPS} bps`);
  try { await hub.start(); log(`hub: ${Object.keys(hub.markets).length} markets`); } catch (e: any) { log(`hub start failed: ${e.message}`); }
  for (const t of store.list()) { await startEngine(t.publicKey).catch((e) => tlog(t.publicKey)(`start failed: ${e.message}`)); await new Promise((r) => setTimeout(r, 1500)); }
});
