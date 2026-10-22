import { formatCurrency, formatSignedCurrency } from "../math/formatUtils";

interface Props {
  walletBalance: number;
  availableBalance: number;
  marginBalance: number;
  totalInitialMargin: number;
  totalUnrealizedPnL: number;
}

/**
 * Account balance panel (live values computed client-side with the same
 * formulas as GET /v2/account):
 *
 *   Wallet Balance     = wallet_balance
 *   Margin Balance     = wallet − Σ(isolated) iso_balance + Σ(cross) uPnL   (margin_balance)
 *   Available Balance  = wallet − order costs − Σ iso_balance − Σ(cross) IM + Σ(cross) uPnL
 *   Position IM        = Σ notional / leverage   (position_initial_margin)
 *   Unrealized PnL     = Σ uPnL of all positions (unrealized_pnl)
 */
export function AccountPanel({
  walletBalance,
  availableBalance,
  marginBalance,
  totalInitialMargin,
  totalUnrealizedPnL,
}: Props) {
  return (
    <div className="panel account-panel">
      <h3>Account</h3>
      <div className="account-grid">
        <div className="account-item">
          <span className="label">Wallet Balance</span>
          <span className="value">{formatCurrency(walletBalance)}</span>
        </div>
        <div className="account-item">
          <span className="label">Margin Balance (cross)</span>
          <span className="value">{formatCurrency(marginBalance)}</span>
        </div>
        <div className="account-item">
          <span className="label">Available Balance</span>
          <span className="value">{formatSignedCurrency(availableBalance)}</span>
        </div>
        <div className="account-item">
          <span className="label">Position IM</span>
          <span className="value">{formatCurrency(totalInitialMargin)}</span>
        </div>
        <div className="account-item">
          <span className="label">Unrealized PnL</span>
          <span className={`value ${totalUnrealizedPnL >= 0 ? "text-green" : "text-red"}`}>
            {formatSignedCurrency(totalUnrealizedPnL)}
          </span>
        </div>
      </div>
    </div>
  );
}
