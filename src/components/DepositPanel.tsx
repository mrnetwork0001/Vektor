import { connectWallet as _reconnectWallet } from "../api/wallets";
import { getSpotBalance, solanaRpc } from "../api/spotBalance";
import { addWitnessSet } from "../lib/cardanoTx";
import { VersionedTransaction, Transaction } from "@solana/web3.js";
import { useEffect } from "react";
import { useState } from "react";
import { getDepositQuote, buildDepositTx, confirmDeposit } from "../api/deposit";
import { getCardanoUtxos, type ConnectedWallet } from "../api/wallets";

interface Props {
  wallet: ConnectedWallet;
}

/**
 * Deposit flow UI (3 steps).
 *
 * 1. Enter amount -> POST /v2/deposit/quote
 * 2. Build unsigned TX -> POST /v2/deposit/build-tx
 *    (user_address = the connected wallet, which is the account's registered
 *    wallet; Cardano also sends CIP-30 getUtxos()). The user signs and submits
 *    the tx with their wallet (outside this reference app).
 * 3. Paste tx hash -> POST /v2/deposit (confirm)
 */
// Smallest-unit decimals per asset (USDC/USDT 6, ADA lovelace 6, SOL lamports 9, ETH wei 18).
const DECIMALS: Record<string, number> = { USDC: 6, USDT: 6, USDM: 6, ADA: 6, SOL: 9, ETH: 18 };
/** Exact integer string without float drift: 16 → "16000000". */
function toRawUnits(n: number, decimals: number): string {
  const [i, f = ""] = String(n).split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  return (i + frac).replace(/^0+(?=\d)/, "");
}

/** Poll eth_getTransactionReceipt until mined (max ~3 min). */
async function waitForReceipt(api: any, hash: string): Promise<void> {
  for (let i = 0; i < 90; i++) {
    const r = await api.request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (r) { if (r.status === "0x0") throw new Error("approval transaction reverted"); return; }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("approval not mined after 3 minutes");
}

// Mainnet token contracts we can read a balance for (ERC-20 balanceOf via eth_call).
// Solana SPL mints we can read (getTokenAccountsByOwner).
const SPL: Record<string, { address: string; decimals: number }> = {
  USDC: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  USDT: { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
};
const ERC20: Record<string, { address: string; decimals: number }> = {
  USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
};
const PUBLIC_RPC = "https://ethereum-rpc.publicnode.com";
async function rpc(method: string, params: unknown[]): Promise<string> {
  const r = await fetch(PUBLIC_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
type Bal = { qty: number; gas?: number; note?: string };

/** Make the EVM wallet sit on Ethereum mainnet (switch, or add+switch), else throw. */
export async function ensureEthereumMainnet(api: any): Promise<void> {
  const want = "0x1";
  const cur: string = await api.request({ method: "eth_chainId" });
  if (cur === want) return;
  try {
    await api.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  } catch (e: any) {
    if (e?.code === 4902 || /unrecognized|not added|4902/i.test(String(e?.message))) {
      await api.request({ method: "wallet_addEthereumChain", params: [{ chainId: want, chainName: "Ethereum Mainnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://ethereum-rpc.publicnode.com"], blockExplorerUrls: ["https://etherscan.io"] }] });
      await api.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
    } else throw new Error(`Switch your wallet to Ethereum mainnet first (${e?.message ?? "switch rejected"})`);
  }
  const after: string = await api.request({ method: "eth_chainId" });
  if (after !== want) throw new Error("Wallet is still not on Ethereum mainnet - deposit cancelled to protect your funds");
}
async function readWalletBalance(wallet: ConnectedWallet, asset: string): Promise<Bal | { error: string }> {
  try {
    if (wallet.chain === "ethereum") {
      const addr = wallet.address;
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return { error: "no EVM address on this session" };
      let note = "";
      // Prefer the extension (it is the signer), fall back to a public mainnet RPC if it refuses or is on another chain.
      let call = async (method: string, params: unknown[]): Promise<string> => rpc(method, params);
      if (wallet.api?.request) {
        try {
          const chainId: string = await wallet.api.request({ method: "eth_chainId" });
          if (chainId === "0x1") call = (m, p) => wallet.api.request({ method: m, params: p });
          else note = `wallet is on chain ${parseInt(chainId, 16)} - it will be asked to switch to Ethereum mainnet when you deposit`;
        } catch { /* use public RPC */ }
      }
      const gas = Number(BigInt(await call("eth_getBalance", [addr, "latest"]))) / 1e18;
      if (asset === "ETH") return { qty: gas, gas, note };
      const t = ERC20[asset]; if (!t) return { qty: NaN, gas, note };
      const data = "0x70a08231" + addr.replace(/^0x/, "").toLowerCase().padStart(64, "0");
      const hex = await call("eth_call", [{ to: t.address, data }, "latest"]);
      return { qty: Number(BigInt(hex)) / 10 ** t.decimals, gas, note };
    }
    if (wallet.chain === "solana") {
      const sol = await getSpotBalance(wallet); // native SOL (also the fee balance)
      if (asset === "SOL") return { qty: sol.qty, gas: sol.qty };
      const mint = SPL[asset]; if (!mint) return { qty: NaN, gas: sol.qty };
      const r = await solanaRpc<{ value: any[] }>("getTokenAccountsByOwner", [wallet.address, { mint: mint.address }, { encoding: "jsonParsed" }]);
      const qty = (r?.value ?? []).reduce((a: number, acc: any) => a + (acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0), 0);
      return { qty, gas: sol.qty, note: sol.qty < 0.002 ? "almost no SOL for the network fee" : "" };
    }
    const b = await getSpotBalance(wallet);
    return b.asset === asset ? { qty: b.qty } : { qty: NaN };
  } catch (e: any) { return { error: e?.message ?? String(e) }; }
}

export function DepositPanel({ wallet }: Props) {
  const chain = wallet.chain;
  const [step, setStep] = useState<"amount" | "sign" | "done">("amount");
  const [amount, setAmount] = useState("");
  const [human, setHuman] = useState("");
  const [asset, setAsset] = useState("USDC");
  const [bal, setBal] = useState<Bal | { error: string } | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setBal(undefined);
    readWalletBalance(wallet, asset).then((b) => { if (alive) setBal(b); });
    const t = setInterval(() => readWalletBalance(wallet, asset).then((b) => { if (alive) setBal(b); }), 20_000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.address, wallet.chain, asset]);
  const typed = parseFloat(human);
  const balOk = bal && !("error" in bal) ? bal : null;
  const overBalance = !!balOk && Number.isFinite(balOk.qty) && Number.isFinite(typed) && typed > balOk.qty;
  const noGas = !!balOk && balOk.gas !== undefined && balOk.gas < 0.0005;
  const [requestId, setRequestId] = useState("");
  const [unsignedTx, setUnsignedTx] = useState("");
  const [approvalTx, setApprovalTx] = useState("");
  const [txHash, setTxHash] = useState("");
  const [evmTx, setEvmTx] = useState<any>(null);
  const [evmApproval, setEvmApproval] = useState<any>(null);
  const [signStatus, setSignStatus] = useState("");
  const [usdValue, setUsdValue] = useState("");
  const [depositAddress, setDepositAddress] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleGetQuote = async () => {
    // A restored session has no live wallet object - reconnect the extension before signing.
    if (!wallet.api) { const live = await _reconnectWallet(wallet.chain, wallet.walletId); wallet.api = live.api; wallet.address = live.address || wallet.address; }
    setError("");
    setLoading(true);
    try {
      const quote = await getDepositQuote({
        blockchain: chain,
        asset_symbol: asset,
        asset_amount: amount, // smallest unit, integer string
      });
      setRequestId(quote.request_id);
      setUsdValue(quote.quote.usd_value);
      setDepositAddress(quote.deposit_address);

      const tx = await buildDepositTx({
        request_id: quote.request_id,
        user_address: wallet.address,
        ...(chain === "cardano" && { utxos: await getCardanoUtxos(wallet.api) }),
      });
      setUnsignedTx(
        typeof tx.unsigned_tx === "string" ? tx.unsigned_tx : JSON.stringify(tx.unsigned_tx, null, 2)
      );
      setApprovalTx(
        tx.format === "evm_tx_params" && tx.approval_tx ? JSON.stringify(tx.approval_tx, null, 2) : ""
      );
      setEvmTx(tx.format === "evm_tx_params" ? tx.unsigned_tx : null);
      setEvmApproval(tx.format === "evm_tx_params" ? tx.approval_tx ?? null : null);
      setStep("sign");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  /** EVM: ask the wallet extension to send the approval (if any) and the deposit, then confirm with the returned hash. */
  const handleSignEvm = async () => {
    setError(""); setLoading(true);
    try {
      if (!wallet.api) { const live = await _reconnectWallet(wallet.chain, wallet.walletId); wallet.api = live.api; wallet.address = live.address || wallet.address; }
      setSignStatus("Checking the wallet is on Ethereum mainnet…");
      await ensureEthereumMainnet(wallet.api);
      const send = (tx: any) => wallet.api.request({ method: "eth_sendTransaction", params: [{ from: tx.from ?? wallet.address, to: tx.to, data: tx.data, value: tx.value ?? "0x0", ...(tx.gas ? { gas: tx.gas } : {}) }] }) as Promise<string>;
      if (evmApproval) {
        setSignStatus("1/2 Approve USDC spend in your wallet…");
        const h = await send(evmApproval);
        setSignStatus(`Approval sent (${h.slice(0, 10)}…) - waiting for it to mine…`);
        await waitForReceipt(wallet.api, h);
      }
      setSignStatus(evmApproval ? "2/2 Confirm the deposit in your wallet…" : "Confirm the deposit in your wallet…");
      const hash = await send(evmTx);
      setTxHash(hash);
      setSignStatus(`Deposit sent (${hash.slice(0, 10)}…) - registering with Strike…`);
      await confirmDeposit({ request_id: requestId, tx_hash: hash });
      setStep("done");
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally { setLoading(false); setSignStatus(""); }
  };

  /** Solana: deserialize Strike's base64 tx, wallet signs + sends, signature is the tx hash. */
  const handleSignSolana = async () => {
    setError(""); setLoading(true);
    try {
      if (!wallet.api) { const live = await _reconnectWallet(wallet.chain, wallet.walletId); wallet.api = live.api; wallet.address = live.address || wallet.address; }
      const raw = Uint8Array.from(atob(unsignedTx), (c) => c.charCodeAt(0));
      let tx: VersionedTransaction | Transaction;
      try { tx = VersionedTransaction.deserialize(raw); } catch { tx = Transaction.from(raw); }
      setSignStatus("Confirm the deposit in your Solana wallet…");
      const res = await wallet.api.signAndSendTransaction(tx);
      const sig: string = typeof res === "string" ? res : res?.signature;
      if (!sig) throw new Error("wallet returned no signature");
      setTxHash(sig);
      setSignStatus(`Sent (${sig.slice(0, 10)}…) - registering with Strike…`);
      await confirmDeposit({ request_id: requestId, tx_hash: sig });
      setStep("done");
    } catch (e: any) { setError(e?.message ?? String(e)); } finally { setLoading(false); setSignStatus(""); }
  };

  /** Cardano: CIP-30 signTx → merge the witness set into the tx (body untouched) → submitTx. */
  const handleSignCardano = async () => {
    setError(""); setLoading(true);
    try {
      if (!wallet.api) { const live = await _reconnectWallet(wallet.chain, wallet.walletId); wallet.api = live.api; wallet.address = live.address || wallet.address; }
      setSignStatus("Sign the deposit in your Cardano wallet…");
      const witness: string = await wallet.api.signTx(unsignedTx, true);
      const signed = addWitnessSet(unsignedTx, witness);
      setSignStatus("Submitting to the Cardano network…");
      const hash: string = await wallet.api.submitTx(signed);
      setTxHash(hash);
      setSignStatus(`Submitted (${hash.slice(0, 10)}…) - registering with Strike…`);
      await confirmDeposit({ request_id: requestId, tx_hash: hash });
      setStep("done");
    } catch (e: any) { setError(e?.info ?? e?.message ?? String(e)); } finally { setLoading(false); setSignStatus(""); }
  };

  const handleConfirm = async () => {
    setError("");
    setLoading(true);
    try {
      await confirmDeposit({ request_id: requestId, tx_hash: txHash.trim() });
      setStep("done");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="panel">
      <h3>Deposit</h3>

      {step === "amount" && (
        <>
          <div className="form-group">
            <label>Asset (must be enabled for {chain})</label>
            <select value={asset} onChange={(e) => setAsset(e.target.value)}>
              <option value="USDC">USDC</option>
              <option value="USDM">USDM</option>
              <option value="USDCx">USDCx</option>
              <option value="ADA">ADA</option>
              <option value="SOL">SOL</option>
              <option value="ETH">ETH</option>
            </select>
          </div>
          <div className="form-group">
            <label style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Amount in {asset}</span>
              <span className={overBalance ? "text-red" : ""} title={bal && "error" in bal ? bal.error : undefined}>
                wallet: {bal === undefined ? "reading…" : "error" in bal ? `unavailable (${bal.error})` : Number.isFinite(bal.qty) ? `${bal.qty.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${asset}` : "n/a for this asset"}
                {balOk && balOk.gas !== undefined ? ` · ${balOk.gas.toFixed(4)} ${wallet.chain === "solana" ? "SOL" : "ETH"} for fees` : ""}
              </span>
            </label>
            <input
              inputMode="decimal"
              value={human}
              onChange={(e) => { const h = e.target.value; setHuman(h); const n = parseFloat(h); setAmount(Number.isFinite(n) && n > 0 ? toRawUnits(n, DECIMALS[asset] ?? 6) : ""); }}
              placeholder="0.00"
            />
            <span className="text-xs text-secondary" style={{ display: "block", marginTop: 4 }}>
              Sent to Strike as <code>{amount || "…"}</code> ({DECIMALS[asset] ?? 6} decimals - {asset === "USDC" || asset === "USDT" ? "6 zeros per dollar" : "smallest on-chain unit"}). Minimum deposit is set by Strike per asset.
            </span>
          </div>
          {balOk?.note && <p className="error">{balOk.note}</p>}
          {overBalance && <p className="error">That's more {asset} than this wallet holds ({balOk!.qty.toLocaleString(undefined, { maximumFractionDigits: 6 })}).</p>}
          {noGas && !overBalance && wallet.chain === "ethereum" && <p className="error">This wallet has almost no ETH for gas - the deposit transaction will fail.</p>}
          {balOk && Number.isFinite(balOk.qty) && !overBalance && balOk.qty > 0 && (
            <button className="btn btn-secondary" style={{ marginBottom: 8 }} onClick={() => { const q = Math.floor(balOk.qty * 1e6) / 1e6; setHuman(String(q)); setAmount(toRawUnits(q, DECIMALS[asset] ?? 6)); }}>Use max ({balOk.qty.toLocaleString(undefined, { maximumFractionDigits: 2 })} {asset})</button>
          )}
          <button onClick={handleGetQuote} disabled={!amount || loading || overBalance} className="btn btn-primary">
            {loading ? "Getting quote..." : "Get Quote"}
          </button>
        </>
      )}

      {step === "sign" && (
        <>
          <p>USD Value: <strong>${usdValue}</strong></p>
          <p className="text-secondary text-xs">Strike vault: {depositAddress}</p>
          {(evmTx || chain === "solana" || chain === "cardano") ? (
            <>
              <button onClick={evmTx ? handleSignEvm : chain === "solana" ? handleSignSolana : handleSignCardano} disabled={loading} className="btn btn-primary btn-submit">
                {loading ? signStatus || "Waiting for wallet…" : evmTx ? (evmApproval ? "Approve & deposit with wallet (2 signatures)" : "Deposit with wallet (1 signature)") : "Deposit with wallet (1 signature)"}
              </button>
              <p className="text-xs text-secondary" style={{ margin: "6px 0 10px" }}>
                {evmTx ? `Your wallet will pop up${evmApproval ? " twice: an ERC-20 approval, then the deposit" : " once"}. Needs a little ETH for gas.` : chain === "solana" ? "Phantom/Solflare will ask once; the transaction expires in ~60 s, so sign promptly. Needs a little SOL for fees." : "Your Cardano wallet will ask once; Vektor adds the witness and submits it. Credit after confirmations."} Credit lands after confirmations.
              </p>
              <details>
                <summary className="text-xs text-secondary" style={{ cursor: "pointer" }}>Manual: raw transactions + paste hash</summary>
                {approvalTx && <div className="form-group"><label>ERC-20 approval (send first)</label><textarea readOnly value={approvalTx} rows={4} className="code-block" /></div>}
                <div className="form-group"><label>Unsigned transaction</label><textarea readOnly value={unsignedTx} rows={4} className="code-block" /></div>
                <div className="form-group"><label>TX hash</label><input value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="0x…" /></div>
                <button onClick={handleConfirm} disabled={txHash.trim().length < 10 || loading} className="btn btn-secondary">{loading ? "Confirming..." : "Confirm deposit by hash"}</button>
              </details>
            </>
          ) : (
            <>
              <div className="form-group">
                <label>Unsigned transaction (sign + submit with your wallet):</label>
                <textarea readOnly value={unsignedTx} rows={4} className="code-block" />
              </div>
              <div className="form-group">
                <label>Paste TX hash after submitting:</label>
                <input value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="tx hash" />
              </div>
              <button onClick={handleConfirm} disabled={txHash.trim().length < 10 || loading} className="btn btn-primary">
                {loading ? "Confirming..." : "Confirm Deposit"}
              </button>
            </>
          )}
        </>
      )}

      {step === "done" && (
        <>
          <p className="text-green">Deposit submitted and registered with Strike.</p>
          <div className="notice">
            <b>Usually takes 2–5 minutes to show up.</b> Strike waits for block confirmations (about 12 on Ethereum) before crediting your balance. You'll get a "Deposit credited" toast and the Account panel updates by itself - no need to reload.
            {txHash && <span className="text-xs text-secondary" style={{ display: "block", marginTop: 6 }}>Track it: <a href={`https://etherscan.io/tx/${txHash}`} target="_blank" rel="noopener" style={{ color: "var(--green)" }}>{txHash.slice(0, 12)}…{txHash.slice(-6)}</a></span>}
          </div>
          <button onClick={() => { setStep("amount"); setTxHash(""); }} className="btn btn-secondary">
            New Deposit
          </button>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
