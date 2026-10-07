import { useState } from "react";
import { useAccount } from "../account/useAccount.js";
import { usePortfolio, usePortfolioHistory } from "../data/queries.js";
import { bpsLeverage, signedUsdc, usdc } from "../lib/format.js";
import { PNL_RANGES, RANGE_INTERVAL, pnlSeries, seriesChange, type PnlRange } from "../lib/portfolio.js";
import type { AccountState } from "../lib/types.js";
import { ActivityTabs } from "../trade/AccountPanel.js";
import { useFunds } from "../trade/FundsDialog.js";
import { Banner, Change, EmptyState, NavIcons, Rows, Segmented } from "../ui/primitives.js";
import { WalletMenu } from "../wallet/WalletMenu.js";
import { PnlChart } from "./PnlChart.js";

function ValueCard({ account }: { account: AccountState }) {
  const funds = useFunds();
  const pnl = BigInt(account.unrealizedPnl);
  return <section className="rfq-card rfq-card--pad stack" aria-label="Account value">
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
  </section>;
}

function MarginCard({ account }: { account: AccountState }) {
  return <section className="rfq-card rfq-card--pad" aria-label="Margin">
    <Rows rows={[
      ["Cash balance", usdc(account.collateral)],
      ["Available to trade", usdc(account.availableMargin)],
      ["Margin in use", usdc(account.initialMargin)],
      ["Maintenance margin", usdc(account.maintenanceMargin)],
      ["Leverage", bpsLeverage(account.effectiveLeverageBps)],
    ]} />
  </section>;
}

function PerformanceCard({ account }: { account: AccountState }) {
  const [range, setRange] = useState<PnlRange>("all");
  const summary = usePortfolio(account.account);
  const history = usePortfolioHistory(account.account, RANGE_INTERVAL[range]);
  const series = pnlSeries(history.data?.points ?? [], range, Date.now(), BigInt(account.unrealizedPnl));
  const change = seriesChange(series);
  const data = summary.data;
  return <section className="rfq-card rfq-card--pad stack performance" aria-label="Performance">
    <div className="performance__head">
      <div>
        <div className="footnote rfq-muted">PnL</div>
        <div className="title-2 num"><Change value={change}>{signedUsdc(change)}</Change></div>
      </div>
      <Segmented label="Period" value={range} onChange={setRange} options={PNL_RANGES} className="performance__range" />
    </div>
    {history.isError ? <EmptyState icon={NavIcons.trade}>PnL history is unavailable right now.</EmptyState> : <PnlChart series={series} />}
    <p className="caption rfq-faint">Realized PnL after fees and funding, plus open positions at live prices.</p>
    <dl className="stat-grid">
      <div><dt>Realized PnL</dt><dd>{data ? <Change value={BigInt(data.realizedPnl)}>{signedUsdc(data.realizedPnl)}</Change> : "—"}</dd></div>
      <div><dt>Fees paid</dt><dd>{usdc(data?.fees)}</dd></div>
      <div><dt>Funding</dt><dd>{data ? signedUsdc(data.funding) : "—"}</dd></div>
      <div><dt>Volume</dt><dd>{usdc(data?.volume)}</dd></div>
      <div><dt>Net deposits</dt><dd>{usdc(data?.netDeposits)}</dd></div>
      <div><dt>Trades</dt><dd>{data?.tradeCount ?? "—"}</dd></div>
    </dl>
  </section>;
}

export function PortfolioPage() {
  const { account, error } = useAccount();
  if (!account) return <div className="page narrow">
    <h1 className="title-1 page-title">Portfolio</h1>
    <section className="rfq-card"><EmptyState icon={NavIcons.portfolio} action={<WalletMenu />}>Connect to see your balance, positions and history.</EmptyState></section>
  </div>;
  return <div className="page portfolio">
    <h1 className="title-1 page-title">Portfolio</h1>
    {error && <Banner tone="warning">We can't load your account right now. {error.message}</Banner>}
    <div className="portfolio-summary">
      <ValueCard account={account} />
      <MarginCard account={account} />
    </div>
    <PerformanceCard account={account} />
    <ActivityTabs account={account} full />
  </div>;
}
