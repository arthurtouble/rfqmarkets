import { useAccount } from "../account/useAccount.js";
import { bpsLeverage, signedUsdc, usdc } from "../lib/format.js";
import { ActivityTabs } from "../trade/AccountPanel.js";
import { useFunds } from "../trade/FundsDialog.js";
import { Banner, Change, EmptyState, NavIcons, Rows } from "../ui/primitives.js";
import { WalletMenu } from "../wallet/WalletMenu.js";

export function PortfolioPage() {
  const { account, error } = useAccount();
  const funds = useFunds();
  if (!account) return <div className="page narrow">
    <h1 className="title-1 page-title">Portfolio</h1>
    <section className="rfq-card"><EmptyState icon={NavIcons.portfolio} action={<WalletMenu />}>Connect to see your balance, positions and history.</EmptyState></section>
  </div>;
  const pnl = BigInt(account.unrealizedPnl);
  return <div className="page portfolio">
    <h1 className="title-1 page-title">Portfolio</h1>
    {error && <Banner tone="warning">We can't load your account right now. {error.message}</Banner>}
    <section className="portfolio-summary">
      <div className="rfq-card rfq-card--pad stack">
        <div>
          <div className="footnote rfq-muted">Account value</div>
          <div className="balance">{usdc(account.equity)}</div>
          <Change value={pnl}>{signedUsdc(pnl)} <span className="rfq-faint">unrealized</span></Change>
        </div>
        {account.liquidatable && <Banner tone="danger"><b>Your account can be liquidated.</b> Add funds or close a position now.</Banner>}
        <div className="two-buttons">
          <button type="button" className="rfq-btn rfq-btn--primary" onClick={() => funds.open("deposit")}>Deposit</button>
          <button type="button" className="rfq-btn rfq-btn--secondary" onClick={() => funds.open("withdraw")}>Withdraw</button>
        </div>
      </div>
      <div className="rfq-card rfq-card--pad">
        <Rows rows={[
          ["Deposited", usdc(account.collateral)],
          ["Available to trade", usdc(account.availableMargin)],
          ["Margin in use", usdc(account.initialMargin)],
          ["Leverage", bpsLeverage(account.effectiveLeverageBps)],
          ["Funding paid or received", signedUsdc(account.accruedFunding)],
        ]} />
      </div>
    </section>
    <ActivityTabs account={account} />
  </div>;
}
