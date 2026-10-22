// Reads every figure the film quotes back from public sources into data/onchain.json.
// Read-only: Strike public selectors (account_id / blockchain_address), Ethereum and
// Solana public RPC, Koios (Cardano). No keys, no writes.
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STRIKE = "https://api.strikefinance.org";
const ETH_RPC = "https://ethereum-rpc.publicnode.com";
const SOL_RPC = "https://api.mainnet-beta.solana.com";
const KOIOS = "https://api.koios.rest/api/v1";

const ACCOUNTS = {
  owner: "01a162e1-f0fb-77f4-8958-8adaf4b9a2b9",
  eth: "01a164cf-36b1-7387-aa2f-199cc57f8c3f",
  sol: "01a164ed-d806-7564-9c17-b6b72adc1607",
  ada: "01a16503-d2a3-74ad-855e-2362748ad8bb",
};
const ADDR = {
  eth: "0xEbB92c8f27368222E4B722FB386DbC6Fe80CC426",
  sol: "GnX9xu9UZgtjNXREKebPRSQLA4FeAgBiXwp5LPY3FHHy",
  ada: "addr1q8evmulashpenxt7f3th24ek7qn0h7eclcp28juemas8kpeuvw6c5ayua84954ucpzhk6pu2hydh8wrw7hzexvvxpcgsuntw5y",
};
const ETH_TX = { approve: "0x4ce2ee67a773ca4ed68ae428998699269bd9a453c4bcbb5c080e27977208ffa9", deposit: "0x5000652a28260cc9152cb5df90327cf57c756ac0748b7fd7ec4f1c1416abd7e8" };
const SOL_SIG = "3Gf7BvvapQ1yKLNKrnsjrKSMz2PQUgc84JmqRQqMEKT9uPbsGihhBq1tfFEWFC1tLdJfpBNtShfxukHrpa36H9mW";
const AUTOPILOT = "https://vektor.38-49-213-208.sslip.io/health";

const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };
const rpc = async (url, method, params) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
};
const iso = (ms) => new Date(ms).toISOString();
const num = (s) => Number(s);

async function strikeAccount(id) {
  const [fills, ledger, open, pos] = await Promise.all([
    get(`${STRIKE}/v2/history/fill?account_id=${id}&limit=50`),
    get(`${STRIKE}/v2/history/transaction?account_id=${id}&limit=50`),
    get(`${STRIKE}/v2/openOrders?account_id=${id}`),
    get(`${STRIKE}/v2/positions?account_id=${id}`).catch(() => ({ positions: [] })),
  ]);
  return {
    account_id: id,
    fills: (fills.fills ?? []).map((f) => ({ trade_id: f.trade_id, utc: iso(f.timestamp), symbol: f.symbol, side: f.side, size: num(f.size), price: num(f.price), role: f.role, fee: num(f.fee), fee_type: f.fee_type, realized_pnl: num(f.realized_pnl), client_order_id: f.client_order_id ?? null })).reverse(),
    ledger: (ledger.transactions ?? []).map((t) => ({ utc: iso(t.timestamp), type: t.type, amount_usd: num(t.amount), status: t.status ?? null, asset: t.asset_symbol ?? null, asset_amount: t.asset_amount ?? null, tx_hash: t.tx_hash ?? null, blockchain: t.blockchain ?? null })).reverse(),
    open_orders: (open.orders ?? []).map((o) => ({ side: o.Side, size: num(o.Size), price: num(o.Price), client_order_id: o.ClientOrderID, builder: o.Builder ?? null })),
    positions: (pos.positions ?? []).map((p) => ({ symbol: p.symbol, size: num(p.size), entry: num(p.entry_price), leverage: p.leverage })),
  };
}

async function ethTx(hash) {
  const [tx, rc] = await Promise.all([rpc(ETH_RPC, "eth_getTransactionByHash", [hash]), rpc(ETH_RPC, "eth_getTransactionReceipt", [hash])]);
  const block = await rpc(ETH_RPC, "eth_getBlockByNumber", [rc.blockNumber, false]);
  // USDC Transfer(address,address,uint256) logs → decoded amount
  const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const transfers = rc.logs.filter((l) => l.topics[0] === T).map((l) => ({ token: l.address, from: "0x" + l.topics[1].slice(26), to: "0x" + l.topics[2].slice(26), amount: Number(BigInt(l.data)) / 1e6 }));
  return { hash, block: parseInt(rc.blockNumber, 16), utc: iso(parseInt(block.timestamp, 16) * 1000), from: tx.from, to: tx.to, status: rc.status === "0x1" ? "success" : "failed", method: tx.input.slice(0, 10), usdc_transfers: transfers, explorer: `https://etherscan.io/tx/${hash}` };
}

async function solTx(sig) {
  const t = await rpc(SOL_RPC, "getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
  const pre = t.meta.preTokenBalances ?? [], post = t.meta.postTokenBalances ?? [];
  const deltas = post.map((p) => { const q = pre.find((x) => x.accountIndex === p.accountIndex); return { owner: p.owner, mint: p.mint, delta: (p.uiTokenAmount.uiAmount ?? 0) - (q?.uiTokenAmount.uiAmount ?? 0) }; }).filter((d) => d.delta !== 0);
  return { signature: sig, slot: t.slot, utc: iso(t.blockTime * 1000), status: t.meta.err ? "failed" : "success", fee_sol: t.meta.fee / 1e9, token_deltas: deltas, explorer: `https://solscan.io/tx/${sig}` };
}

async function adaTx(raw) {
  const hash = raw.split("#")[0]; // Strike stores "<tx>#<output index>"
  const r = await fetch(`${KOIOS}/tx_info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ _tx_hashes: [hash] }) });
  const j = await r.json();
  const t = Array.isArray(j) ? j[0] : null;
  if (!t) return { hash, note: "not yet indexed by Koios" };
  const out = (t.outputs ?? []).map((o) => ({ to: o.payment_addr?.bech32, ada: Number(o.value) / 1e6 }));
  return { hash, block: t.block_height, utc: iso(t.tx_timestamp * 1000), fee_ada: Number(t.fee) / 1e6, outputs: out, explorer: `https://cardanoscan.io/transaction/${hash}` };
}

const strike = {};
for (const [k, id] of Object.entries(ACCOUNTS)) strike[k] = await strikeAccount(id);

const deposits = Object.fromEntries(["eth", "sol", "ada"].map((k) => [k, strike[k].ledger.find((t) => t.type === "deposit") ?? null]));
const adaHash = deposits.ada?.tx_hash;

const out = {
  read_at_utc: new Date().toISOString(),
  sources: { strike: STRIKE, eth_rpc: ETH_RPC, sol_rpc: SOL_RPC, koios: KOIOS, autopilot: AUTOPILOT },
  builder: { code: "vektor", fee_bps: 10, note: "Builder fee appears on the user-stream fill event (builder_fee); Strike's public fill rows show commission only. ETH-account fill 18:33:53Z carried builder_fee 0.01, observed in the app header 'builder fees $0.01'." },
  addresses: ADDR,
  strike,
  chain: {
    eth: { approve: await ethTx(ETH_TX.approve), deposit: await ethTx(ETH_TX.deposit) },
    sol: { deposit: await solTx(SOL_SIG) },
    ada: { deposit: adaHash ? await adaTx(adaHash) : null },
  },
  autopilot: await get(AUTOPILOT).catch((e) => ({ error: String(e.message) })),
};

mkdirSync(join(ROOT, "data"), { recursive: true });
writeFileSync(join(ROOT, "data/onchain.json"), JSON.stringify(out, null, 2) + "\n");
const f = (a) => a.fills.length;
console.log(`onchain.json written · fills owner ${f(strike.owner)} eth ${f(strike.eth)} sol ${f(strike.sol)} ada ${f(strike.ada)} · open orders ada ${strike.ada.open_orders.length} · autopilot tenants ${out.autopilot.tenants ?? "?"}`);
