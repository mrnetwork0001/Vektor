import { connectWallet as _reconnectWallet } from "../api/wallets";
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
export function DepositPanel({ wallet }: Props) {
  const chain = wallet.chain;
  const [step, setStep] = useState<"amount" | "sign" | "done">("amount");
  const [amount, setAmount] = useState("");
  const [asset, setAsset] = useState("USDC");
  const [requestId, setRequestId] = useState("");
  const [unsignedTx, setUnsignedTx] = useState("");
  const [approvalTx, setApprovalTx] = useState("");
  const [txHash, setTxHash] = useState("");
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
      setStep("sign");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
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
            <label>Amount (smallest unit: lamports/lovelace/wei, USDC = 1e-6)</label>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 1000000000"
            />
          </div>
          <button onClick={handleGetQuote} disabled={!amount || loading} className="btn btn-primary">
            {loading ? "Getting quote..." : "Get Quote"}
          </button>
        </>
      )}

      {step === "sign" && (
        <>
          <p>USD Value: <strong>${usdValue}</strong></p>
          <p className="text-secondary text-xs">Strike vault: {depositAddress}</p>
          {approvalTx && (
            <div className="form-group">
              <label>ERC-20 approval (send first):</label>
              <textarea readOnly value={approvalTx} rows={4} className="code-block" />
            </div>
          )}
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

      {step === "done" && (
        <>
          <p className="text-green">Deposit submitted! Awaiting blockchain confirmation.</p>
          <button onClick={() => { setStep("amount"); setTxHash(""); }} className="btn btn-secondary">
            New Deposit
          </button>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
