import { useState } from "react";
import { getWithdrawQuote, confirmWithdraw, type WithdrawQuoteResponse } from "../api/withdraw";
import { signMessage, signCardanoTx, type ConnectedWallet } from "../api/wallets";

interface Props {
  wallet: ConnectedWallet;
  withdrawableBalance: number;
}

const DEFAULT_ASSET: Record<string, string> = {
  cardano: "USDM",
  solana: "USDC",
  ethereum: "USDC",
};

/**
 * Withdrawal flow UI.
 *
 * 1. Enter USD amount + asset -> POST /v2/withdraw/quote
 *    (wallet_address = the connected wallet, which signs and receives)
 * 2. Sign message_to_sign with the connected wallet (Cardano: the message is
 *    already hex - passed to signData as-is) and, when the quote has tx_cbor,
 *    sign the Cardano funding tx (CIP-30 signTx)
 * 3. POST /v2/withdraw with wallet_signature (+ signed_tx_cbor)
 */
export function WithdrawPanel({ wallet, withdrawableBalance }: Props) {
  const chain = wallet.chain;
  const [step, setStep] = useState<"amount" | "sign" | "done">("amount");
  const [usdAmount, setUsdAmount] = useState("");
  const [asset, setAsset] = useState(DEFAULT_ASSET[chain] ?? "USDC");
  const [quote, setQuote] = useState<WithdrawQuoteResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleGetQuote = async () => {
    setError("");
    setLoading(true);
    try {
      const q = await getWithdrawQuote({
        usd_value: usdAmount,
        blockchain: chain,
        asset,
        wallet_address: wallet.address, // the wallet that signs message_to_sign
      });
      setQuote(q);
      setStep("sign");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSignAndConfirm = async () => {
    if (!quote) return;
    setError("");
    setLoading(true);
    try {
      const walletSignature = await signMessage(wallet, quote.message_to_sign, /* cardanoPayloadIsHex */ true);
      const signedTxCbor =
        quote.tx_cbor && chain === "cardano" ? await signCardanoTx(wallet.api, quote.tx_cbor) : undefined;

      await confirmWithdraw({
        withdraw_id: quote.withdraw_id,
        wallet_signature: walletSignature,
        ...(signedTxCbor && { signed_tx_cbor: signedTxCbor }),
      });
      setStep("done");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="panel">
      <h3>Withdraw</h3>

      {step === "amount" && (
        <>
          <p className="text-secondary text-xs">
            Withdrawable: ${withdrawableBalance.toFixed(2)}
          </p>
          <div className="form-group">
            <label>Asset on {chain}</label>
            <input value={asset} onChange={(e) => setAsset(e.target.value)} placeholder="USDC" />
          </div>
          <div className="form-group">
            <label>USD Amount (fee included)</label>
            <input
              type="number"
              value={usdAmount}
              onChange={(e) => setUsdAmount(e.target.value)}
              placeholder="500.00"
            />
          </div>
          <button
            onClick={handleGetQuote}
            disabled={!usdAmount || !asset || loading}
            className="btn btn-primary"
          >
            {loading ? "Getting quote..." : "Get Quote"}
          </button>
        </>
      )}

      {step === "sign" && quote && (
        <>
          <p>Fee: <strong>${quote.fee}</strong></p>
          <div className="form-group">
            <label>Message to sign{chain === "cardano" ? " (hex)" : ""}:</label>
            <textarea readOnly value={quote.message_to_sign} rows={6} className="code-block" />
          </div>
          {quote.tx_cbor && (
            <p className="text-secondary text-xs">
              A Cardano funding transaction (min-ADA for the payout) will also be signed.
              It is submitted by Strike, not by your wallet.
            </p>
          )}
          <button onClick={handleSignAndConfirm} disabled={loading} className="btn btn-primary">
            {loading ? "Processing..." : "Sign & Confirm Withdrawal"}
          </button>
        </>
      )}

      {step === "done" && (
        <>
          <p className="text-green">Withdrawal submitted! Settlement is asynchronous.</p>
          <button onClick={() => { setStep("amount"); setQuote(null); }} className="btn btn-secondary">
            New Withdrawal
          </button>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
