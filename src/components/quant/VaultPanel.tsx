import { useCallback, useEffect, useState } from "react";
import { createVault, getVaultDepositors, getVaultPortfolio, listMyVaults, pauseVault, resumeVault, summarizeVault, type Vault, type VaultPortfolio } from "../../api/vaults";
import { formatCurrency, formatPrice } from "../../math/formatUtils";

interface Props {
  accountId: string | null; // connected Strike account (null in Demo / disconnected)
  vaultId: string | null; // execution account for NEW grids; null = own account
  setVaultId: (id: string | null) => void;
}

/**
 * "Run as vault": pick one of the vaults this account leads (or create one)
 * as the execution account for new grids, plus a public performance card.
 * Every grid order then carries `vault_id`; depositors share the PnL, the
 * leader earns the Leader Fee on withdrawals, and the builder fee is still
 * attributed to the leader's builder code (approval is checked on the leader).
 */
export function VaultPanel({ accountId, vaultId, setVaultId }: Props) {
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [portfolio, setPortfolio] = useState<VaultPortfolio | null>(null);
  const [depositors, setDepositors] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState<number>(0); // polls remaining after a create
  const [form, setForm] = useState({ name: "Vektor Grid Vault", description: "Builder-fee grid strategy run by Vektor", initial_deposit: "100", leader_commission_bps: 1000, lockup_days: 1, min_deposit: "50" });

  const refresh = useCallback(async () => {
    if (!accountId) { setVaults([]); return; }
    try { setVaults((await listMyVaults(accountId)).vaults); } catch (e: any) { setErr(e.message); }
  }, [accountId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // A create is async and returns no vault_id: poll the leader list for ~30 s.
  useEffect(() => {
    if (!pendingCreate) return;
    const t = setTimeout(async () => { await refresh(); setPendingCreate((n) => n - 1); }, 3000);
    return () => clearTimeout(t);
  }, [pendingCreate, refresh]);

  const selected = vaults.find((v) => v.vault_id === vaultId) ?? null;
  useEffect(() => {
    if (!vaultId) { setPortfolio(null); setDepositors(null); return; }
    let stop = false;
    const load = () => Promise.all([getVaultPortfolio(vaultId, "30d"), getVaultDepositors(vaultId, 1)])
      .then(([p, d]) => { if (!stop) { setPortfolio(p); setDepositors(d.count); } })
      .catch((e) => !stop && setErr(e.message));
    void load();
    const t = setInterval(load, 60_000);
    return () => { stop = true; clearInterval(t); };
  }, [vaultId]);

  const onCreate = async () => {
    setBusy(true); setErr(null);
    try {
      await createVault({ ...form, initial_deposit: String(form.initial_deposit), min_deposit: String(form.min_deposit), allow_proportional_close: true });
      setPendingCreate(10);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const toggle = async (v: Vault) => {
    setBusy(true); setErr(null);
    try { v.status === "active" ? await pauseVault(v.vault_id) : await resumeVault(v.vault_id); await refresh(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  if (!accountId) {
    return (
      <div className="panel">
        <h3>Run as vault</h3>
        <p className="text-secondary text-sm">Connect in Live mode to lead a Strike vault: depositors fund the grid, you earn the Leader Fee on their profits, and every fill still pays your builder code.</p>
      </div>
    );
  }

  const active = vaults.filter((v) => v.status !== "closed");
  const s = selected ? summarizeVault(selected, portfolio) : null;

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>Run as vault</h3>
        <span className="text-xs text-secondary">{vaultId ? "new grids trade the vault" : "new grids trade your account"}</span>
      </div>

      <div className="form-group">
        <label>Execution account</label>
        <select className="market-select" style={{ width: "100%" }} value={vaultId ?? ""} onChange={(e) => setVaultId(e.target.value || null)}>
          <option value="">My account (no vault)</option>
          {active.map((v) => <option key={v.vault_id} value={v.vault_id}>{v.name} · {v.status} · TVL {formatCurrency(parseFloat(v.equity))}</option>)}
        </select>
      </div>

      {selected && s && (
        <>
          <div className="kv">
            <Row k="Vault" val={`${s.name} (${selected.account_id})`} />
            <Row k="Status" val={s.status} cls={s.status === "active" ? "text-green" : "text-red"} />
            <Row k="TVL / share price" val={`${formatCurrency(s.tvlUsd)} · ${formatPrice(s.sharePrice)}`} />
            <Row k="APR (30d, EW)" val={`${s.aprPct.toFixed(2)}%`} cls={s.aprPct >= 0 ? "text-green" : "text-red"} />
            <Row k="All-time PnL / 24h" val={`${formatCurrency(s.allTimePnlUsd)} · ${s.return24hPct.toFixed(2)}%`} cls={s.allTimePnlUsd >= 0 ? "text-green" : "text-red"} />
            <Row k="Depositors" val={String(depositors ?? s.depositors)} />
            <Row k="Leader fee" val={`${s.leaderFeePct}% of depositor profit · earned ${formatCurrency(s.feeEarnedUsd)}`} />
            <Row k="Volume (30d) / max DD" val={`${formatCurrency(s.volumeUsd)} · ${s.maxDrawdownPct}%`} />
            <Row k="Lock-up / min deposit" val={`${s.lockupDays}d · ${formatCurrency(s.minDepositUsd)}`} />
          </div>
          <div className="side-toggle">
            <button className="btn btn-secondary" disabled={busy} onClick={() => toggle(selected)}>{selected.status === "active" ? "Pause vault" : "Resume vault"}</button>
            <a className="btn btn-secondary" href={`https://app.strikefinance.org/vaults/${selected.vault_id}`} target="_blank" rel="noopener">Public page ↗</a>
          </div>
          <p className="text-xs text-secondary" style={{ marginTop: 8 }}>
            Paused vaults reject new orders (batch items fail with <code>vault trading is paused</code>) but cancels and the Shield still work. Withdrawals execute after the lock-up at the share price then; a short vault may be auto-unwound to pay them.
          </p>
        </>
      )}

      {!active.length && (
        <>
          <p className="text-secondary text-sm" style={{ margin: "8px 0" }}>{pendingCreate ? `Waiting for the engine to create the vault… (${pendingCreate})` : "You lead no vault yet. One active user vault per account."}</p>
          <div className="form-row">
            <Field label="Name"><input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Initial deposit (USD, ≥100)"><input type="number" min={100} value={form.initial_deposit} onChange={(e) => setForm({ ...form, initial_deposit: e.target.value })} /></Field>
          </div>
          <div className="form-row">
            <Field label="Leader fee (bps of profit)"><input type="number" min={1} max={5000} value={form.leader_commission_bps} onChange={(e) => setForm({ ...form, leader_commission_bps: +e.target.value })} /></Field>
            <Field label="Lock-up days"><input type="number" min={1} max={30} value={form.lockup_days} onChange={(e) => setForm({ ...form, lockup_days: +e.target.value })} /></Field>
            <Field label="Min deposit (USD)"><input type="number" min={1} value={form.min_deposit} onChange={(e) => setForm({ ...form, min_deposit: e.target.value })} /></Field>
          </div>
          <button className="btn btn-primary btn-submit" disabled={busy || !!pendingCreate || !form.name.trim() || parseFloat(form.initial_deposit) < 100} onClick={onCreate}>
            {busy ? "Submitting…" : `Create vault (moves ${formatCurrency(parseFloat(form.initial_deposit) || 0)} from withdrawable balance)`}
          </button>
          <p className="text-xs text-secondary" style={{ marginTop: 6 }}>You must keep ≥ 5% of the shares. Fee is charged only on depositors' profit at withdrawal and paid to you as new shares.</p>
        </>
      )}
      {err && <div className="error">{err}</div>}
    </div>
  );
}

const Row = ({ k, val, cls = "" }: { k: string; val: string; cls?: string }) => (
  <div className="connected-row"><span className="text-secondary">{k}</span><span className={`text-sm ${cls}`}>{val}</span></div>
);
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="form-group"><label>{label}</label>{children}</div>
);
