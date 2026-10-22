import { useState, useEffect } from "react";
import {
  generateApiWalletKeys,
  storeApiWalletKeys,
  clearApiWalletKeys,
} from "../api/auth";
import { requestSignature, verifySignature } from "../api/builderConnect";
import {
  detectInstalledWallets,
  connectWallet,
  signMessage,
  type WalletInfo,
  type ConnectedWallet,
  type SupportedChain,
} from "../api/wallets";
import { BUILDER_CODE, BUILDER_FEE_BPS } from "../api/config";
import { getAccount } from "../api/account";

export interface ConnectedInfo {
  accountId: string;
  chain: SupportedChain;
  address: string;
  builderCode: string;
  feeShareBps: number; // user's approved builder fee cap
  wallet: ConnectedWallet; // kept in memory for deposit/withdraw signing
}

interface Props {
  onConnected: (info: ConnectedInfo) => void;
  onDisconnected: () => void;
  connectedInfo: ConnectedInfo | null;
}

/**
 * Builder Connect flow - all state in memory, no localStorage.
 */
export function ConnectPanel({ onConnected, onDisconnected, connectedInfo }: Props) {
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [chain, setChain] = useState<SupportedChain>("cardano");
  const [builderCode, setBuilderCode] = useState(BUILDER_CODE);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [keyMode, setKeyMode] = useState(false);
  const [pubKey, setPubKey] = useState("");
  const [privKey, setPrivKey] = useState("");

  /**
   * Sign in with an API wallet registered at app.strikefinance.org/api-keys.
   * No builder approval is involved (so no builder fee is charged) - this is the
   * path for the builder's own account, which Strike refuses to Builder-Connect
   * to its own code ("cannot connect an account to its own builder").
   */
  const handleKeyLogin = async () => {
    const pub = pubKey.trim().toLowerCase(), priv = privKey.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pub) || !/^[0-9a-f]{64}([0-9a-f]{64})?$/.test(priv)) { setError("Keys must be raw hex: public 64 chars, private 64 (or 128) chars"); return; }
    setError(""); setLoading("api-key"); setStatus("Checking the API wallet…");
    try {
      storeApiWalletKeys({ publicKey: pub, privateKey: priv.slice(0, 64) });
      const acc = await getAccount();
      setStatus("");
      onConnected({ accountId: acc.account_id, chain: "ethereum", address: acc.blockchain_address ?? "", builderCode: "", feeShareBps: 0, wallet: { chain: "ethereum", walletId: "api-key", address: acc.blockchain_address ?? "", api: null } });
    } catch (e: any) {
      clearApiWalletKeys();
      setError(e.message || "API wallet rejected");
      setStatus("");
    } finally { setLoading(null); }
  };

  useEffect(() => {
    const timer = setTimeout(() => setWallets(detectInstalledWallets()), 500);
    return () => clearTimeout(timer);
  }, []);

  const filteredWallets = wallets.filter((w) => w.chain === chain);

  const handleConnect = async (wallet: WalletInfo) => {
    if (!builderCode.trim()) {
      setError("Please enter your builder code first");
      return;
    }

    setError("");
    setLoading(wallet.id);

    try {
      setStatus("Connecting to wallet...");
      const connected: ConnectedWallet = await connectWallet(wallet.chain, wallet.id);

      // A FRESH key per connect: public keys are unique, and verify-signature
      // revokes this account's previous API wallets for the same builder code.
      setStatus("Generating API keys...");
      const keys = generateApiWalletKeys();

      setStatus("Requesting challenge...");
      const challenge = await requestSignature({
        address: connected.address,
        chain: connected.chain,
        publicKey: keys.publicKey,
        builderCode: builderCode.trim(),
        feeShareBps: BUILDER_FEE_BPS, // approval cap the user signs (0..100 bps)
      });

      // Plain-text challenge; Cardano signing hex-encodes it (backend does the same)
      setStatus("Sign the message in your wallet...");
      const walletSig = await signMessage(connected, challenge.message_to_sign);

      setStatus("Verifying...");
      const result = await verifySignature({
        nonce: challenge.nonce,
        walletSignature: walletSig,
      });

      console.log("[Connect] Builder connect OK:", {
        account_id: result.account_id,
        builder_code: result.builder_code,
        fee_share_bps: result.fee_share_bps,
        api_wallet_id: result.api_wallet_id,
        api_wallet_expired_at: result.api_wallet_expired_at,
        referral: result.referral,
      });
      storeApiWalletKeys(keys);

      setStatus("");
      onConnected({
        accountId: result.account_id,
        chain: connected.chain,
        address: connected.address,
        builderCode: result.builder_code,
        feeShareBps: result.fee_share_bps,
        wallet: connected,
      });
    } catch (e: any) {
      setError(e.message || "Connection failed");
      setStatus("");
    } finally {
      setLoading(null);
    }
  };

  const handleDisconnect = () => {
    clearApiWalletKeys();
    onDisconnected();
  };

  // ── Connected state ──
  if (connectedInfo) {
    const shortAddr = connectedInfo.address
      ? `${connectedInfo.address.slice(0, 8)}...${connectedInfo.address.slice(-6)}`
      : connectedInfo.accountId.slice(0, 12) + "...";

    return (
      <div className="panel">
        <h3>Connected</h3>
        <div className="connected-info">
          <div className="connected-row">
            <span className="text-secondary">Builder</span>
            <span className="chain-badge">{connectedInfo.builderCode || "none (API wallet)"}</span>
          </div>
          <div className="connected-row">
            <span className="text-secondary">Max builder fee</span>
            <span className="text-sm">{connectedInfo.feeShareBps} bps</span>
          </div>
          <div className="connected-row">
            <span className="text-secondary">Chain</span>
            <span className="chain-badge">{connectedInfo.chain}</span>
          </div>
          <div className="connected-row">
            <span className="text-secondary">Address</span>
            <span className="text-sm">{shortAddr}</span>
          </div>
          <div className="connected-row">
            <span className="text-secondary">Account</span>
            <span className="text-sm">{connectedInfo.accountId.slice(0, 12)}...</span>
          </div>
        </div>
        <button onClick={handleDisconnect} className="btn btn-danger" style={{ marginTop: 10 }}>
          Disconnect
        </button>
      </div>
    );
  }

  // ── Connect state ──
  if (keyMode) {
    return (
      <div className="panel">
        <div className="panel-header"><h3>API wallet sign-in</h3><button className="btn btn-secondary" onClick={() => setKeyMode(false)}>Back</button></div>
        <p className="text-xs text-secondary" style={{ marginBottom: 10 }}>
          For the builder's own account (Strike won't Builder-Connect an account to its own code). Register a key at <a href="https://app.strikefinance.org/api-keys" target="_blank" rel="noopener" style={{ color: "var(--green)" }}>app.strikefinance.org/api-keys</a>, paste both halves. Keys stay in memory only. Orders placed this way carry <b>no builder fee</b>.
        </p>
        <div className="form-group"><label>Public key (64 hex)</label><input value={pubKey} onChange={(e) => setPubKey(e.target.value)} placeholder="a1b2c3…" autoComplete="off" spellCheck={false} /></div>
        <div className="form-group"><label>Private key (64 or 128 hex)</label><input type="password" value={privKey} onChange={(e) => setPrivKey(e.target.value)} placeholder="…" autoComplete="off" /></div>
        {status && <p className="text-xs text-secondary">{status}</p>}
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary btn-submit" disabled={loading !== null || !pubKey || !privKey} onClick={handleKeyLogin}>Sign in with API wallet</button>
      </div>
    );
  }

  return (
    <div className="panel">
      <h3>Connect Wallet</h3>

      <div className="form-group">
        <label>Builder Code</label>
        <input
          value={builderCode}
          onChange={(e) => setBuilderCode(e.target.value)}
          placeholder="Enter your builder code (e.g. gero)"
          className={!builderCode.trim() ? "input-highlight" : ""}
        />
        <span className="text-xs text-secondary" style={{ marginTop: 2, display: "block" }}>
          Your unique builder code from Strike. Required to connect.
        </span>
      </div>

      <div className="chain-tabs">
        {(["cardano", "solana", "ethereum"] as SupportedChain[]).map((c) => (
          <button
            key={c}
            className={`chain-tab ${chain === c ? "active" : ""}`}
            onClick={() => setChain(c)}
          >
            {c.charAt(0).toUpperCase() + c.slice(1)}
          </button>
        ))}
      </div>

      <div className="wallet-list">
        {filteredWallets.length === 0 && (
          <p className="text-secondary text-sm" style={{ padding: "12px 0" }}>
            No {chain} wallets detected. Please install a wallet extension.
          </p>
        )}

        {filteredWallets.map((w) => (
          <button
            key={w.id}
            className="wallet-btn"
            onClick={() => handleConnect(w)}
            disabled={loading !== null}
          >
            {w.icon && <img src={w.icon} alt="" className="wallet-icon" />}
            <span className="wallet-name">{w.name}</span>
            {loading === w.id && <span className="wallet-status">Connecting...</span>}
          </button>
        ))}
      </div>

      {status && <p className="text-secondary text-sm" style={{ marginTop: 8 }}>{status}</p>}
      {error && <p className="error">{error}</p>}
      <button className="btn btn-secondary btn-submit" onClick={() => { setError(""); setKeyMode(true); }} style={{ marginTop: 10 }}>Sign in with API wallet keys instead</button>
      {error.includes("own builder") && <p className="text-xs text-secondary" style={{ marginTop: 6 }}>This wallet owns the builder code, so Strike won't approve it for itself. Use API wallet keys for this account, or connect a different wallet to trade through the builder.</p>}
    </div>
  );
}
