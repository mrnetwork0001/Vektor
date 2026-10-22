import type { DocContent } from "../DocsFrame";
import { P, Code, Callout, DocTable, Tag, CopyValue } from "../primitives";
import { PROOF, API_HOST } from "../facts";

const ok = <Tag tone="accent">mainnet</Tag>;
const sim = <Tag tone="warning">simulator</Tag>;

export const realVsSimulated: DocContent = {
  sections: [
    { id: "table", title: "What has run where", body: (
      <DocTable head={["Feature", "Status", "Evidence"]} rows={[
        ["Grid deploy, fills, counter orders", ok, "Fills on the accounts below"],
        ["Builder fee on a fill", ok, "$0.01 on a $13.80 fill at 10 bps (user-stream event)"],
        ["Deposits: Ethereum, Solana, Cardano", ok, "Each completed in Strike's ledger"],
        ["Hedge launch and unwind", ok, "50 ADA, Cardano account"],
        ["Reconcile after reload", ok, "Grid adopted from open orders"],
        ["Shield gauge and Rule A cancel path", ok, "Live positions"],
        ["Shield Rule B trim", sim, "Needs a position near liquidation"],
        ["Auto-shift, per-rung brackets", sim, "Unit and simulator tests"],
        ["Vault execution", sim, "Prototype; vault fill stream not wired"],
        ["Demo mode", sim, "By design"],
      ]} />
    ) },
    { id: "accounts", title: "Accounts used in testing", body: (
      <>
        <P>Paste any of these into <Code>{API_HOST}/v2/history/fill?account_id=…</Code> or the proof page.</P>
        <P lead="Builder-attributed account:"><CopyValue value={PROOF.builderAccount} label="account id" /></P>
        <P lead="Owner account:"><CopyValue value={PROOF.ownerAccount} label="account id" /></P>
        <P lead="Cardano account:"><CopyValue value={PROOF.cardanoAccount} label="account id" /></P>
        <P lead="Ethereum deposit:"><CopyValue value={PROOF.ethDepositTx} href={`https://etherscan.io/tx/${PROOF.ethDepositTx}`} label="transaction hash" /></P>
        <P lead="Solana deposit:"><CopyValue value={PROOF.solDepositTx} href={`https://solscan.io/tx/${PROOF.solDepositTx}`} label="transaction signature" /></P>
      </>
    ) },
  ],
};

export const security: DocContent = {
  sections: [
    { id: "keys", title: "Where keys live", body: (
      <DocTable head={["Key", "Where", "Can it"]} rows={[
        ["Wallet (Rabby, Phantom, Lace…)", "Your browser extension; Vektor never sees it", "Sign deposits, withdrawals, the connect challenge"],
        ["API wallet (Ed25519)", "Browser memory; local storage only if you tick Remember", "Trade and cancel. Cannot deposit or withdraw"],
        ["Worker keys", "Environment variables on your server", "Trade and cancel"],
      ]} />
    ) },
    { id: "stored", title: "What is stored", body: (
      <P>Local storage holds grid state (no secrets), whether you finished the walkthrough, and - only if you opt in - the API wallet key pair. Disconnect removes the keys. Nothing is sent to any server of ours; the only server code is a relay that forwards balance queries to public RPC nodes.</P>
    ) },
    { id: "limits", title: "Known limits", body: (
      <>
        <Callout tone="warning">"Remember on this device" stores the trading key unencrypted. Anyone with access to this browser profile could trade (not withdraw) on the account. Use it only on your own machine.</Callout>
        <P>The browser terminal acts only while the tab is open; use the worker for unattended operation. Backtests are optimistic on thin books. L3 radar thresholds are hand-tuned.</P>
      </>
    ) },
  ],
};
