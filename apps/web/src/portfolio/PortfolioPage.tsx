import { useState } from "react";
import { useAccount, useAccountValue, useIsolatedAccounts } from "../account/useAccount.js";
import { usePortfolio, usePortfolioHistory } from "../data/queries.js";
import { bpsLeverage, signedUsdc, usdc } from "../lib/format.js";
import { homeTotals } from "../lib/isolated.js";
import { PNL_RANGES, RANGE_INTERVAL, pnlSeries, seriesChange, type PnlRange } from "../lib/portfolio.js";
import type { AccountState } from "../lib/types.js";
import { IdleMargin } from "../positions/Positions.js";
import { ActivityTabs } from "../trade/AccountPanel.js";
import { useFunds } from "../trade/FundsDialog.js";
import { Banner, Change, EmptyState, NavIcons, Rows, Segmented } from "../ui/primitives.js";
import { useTrader } from "../wallet/trader.js";
import { WalletMenu } from "../wallet/WalletMenu.js";
import { PnlChart } from "./PnlChart.js";

type Home = ReturnType<typeof homeTotals>;

/** Account value and PnL; dashes until the account (and its Home trades) have been read. */
function ValueCard({ account, home }: { account: AccountState | null; home: Home }) {
  const funds = useFunds();
  const { value } = useAccountValue();
  const pnl = account && value !== null ? BigInt(account.unrealizedPnl) + home.unrealizedPnl : null;
  return (
    <section className="rfq-card rfq-card--pad stack" aria-label="Account value">
      <div>
        <div className="footnote rfq-muted">Account value</div>
        <div className="balance" aria-busy={value === null}>
          {usdc(value)}
        </div>
        {pnl === null ? (
          <span className="rfq-faint">—</span>
        ) : (
          <Change value={pnl}>
            {signedUsdc(pnl)} <span className="rfq-faint">unrealized</span>
          </Change>
        )}
        {home.equity > 0n && (
          <div className="caption rfq-faint">Includes {usdc(home.equity)} in Home trades</div>
        )}
      </div>
      {account?.liquidatable && (
        <Banner tone="danger">
          <b>Your account can be liquidated.</b> Add funds or close a position now.
        </Banner>
      )}
      <div className="two-buttons">
        <button type="button" className="rfq-btn rfq-btn--primary" onClick={() => funds.open("deposit")}>
          Deposit
        </button>
        <button type="button" className="rfq-btn rfq-btn--secondary" onClick={() => funds.open("withdraw")}>
          Withdraw
        </button>
      </div>
    </section>
  );
}

function MarginCard({ account }: { account: AccountState | null }) {
  return (
    <section className="rfq-card rfq-card--pad" aria-label="Margin">
      <Rows
        rows={[
          ["Cash balance", usdc(account?.collateral)],
          ["Available to trade", usdc(account?.availableMargin)],
          ["Margin in use", usdc(account?.initialMargin)],
          ["Maintenance margin", usdc(account?.maintenanceMargin)],
          ["Leverage", account ? bpsLeverage(account.effectiveLeverageBps) : "—"],
        ]}
      />
    </section>
  );
}

function PerformanceCard({
  address,
  account,
  home,
}: {
  address: string;
  account: AccountState | null;
  home: Home;
}) {
  const [range, setRange] = useState<PnlRange>("all");
  const summary = usePortfolio(address);
  const history = usePortfolioHistory(address, RANGE_INTERVAL[range]);
  const series = pnlSeries(
    history.data?.points ?? [],
    range,
    Date.now(),
    BigInt(account?.unrealizedPnl ?? 0) + home.unrealizedPnl,
  );
  const change = seriesChange(series);
  const data = summary.data;
  return (
    <section className="rfq-card rfq-card--pad stack performance" aria-label="Performance">
      <div className="performance__head">
        <div>
          <div className="footnote rfq-muted">PnL</div>
          <div className="title-2 num">
            <Change value={change}>{signedUsdc(change)}</Change>
          </div>
        </div>
        <Segmented
          label="Period"
          value={range}
          onChange={setRange}
          options={PNL_RANGES}
          className="performance__range"
        />
      </div>
      {history.isError ? (
        <EmptyState mood="loss">PnL history is unavailable right now.</EmptyState>
      ) : (
        <PnlChart series={series} />
      )}
      <p className="caption rfq-faint">
        Closed trades including funding, plus open positions at live prices.
      </p>
      <dl className="stat-grid">
        <div>
          <dt>Realized PnL</dt>
          <dd>
            {data ? <Change value={BigInt(data.realizedPnl)}>{signedUsdc(data.realizedPnl)}</Change> : "—"}
          </dd>
        </div>
        {data && BigInt(data.fees) > 0n && (
          // Trades carry no fee now; this only shows for accounts that paid one before.
          <div>
            <dt>Fees paid</dt>
            <dd>{usdc(data.fees)}</dd>
          </div>
        )}
        <div>
          <dt>Funding</dt>
          <dd>{data ? signedUsdc(data.funding) : "—"}</dd>
        </div>
        <div>
          <dt>Volume</dt>
          <dd>{usdc(data?.volume)}</dd>
        </div>
        <div>
          <dt>Net deposits</dt>
          <dd>{usdc(data?.netDeposits)}</dd>
        </div>
        <div>
          <dt>Trades</dt>
          <dd>{data?.tradeCount ?? "—"}</dd>
        </div>
      </dl>
    </section>
  );
}

export function PortfolioPage() {
  const { address } = useTrader();
  const { account, error } = useAccount();
  const home = homeTotals(useIsolatedAccounts());
  if (!address)
    return (
      <div className="page narrow">
        <h1 className="title-1 page-title">Portfolio</h1>
        <section className="rfq-card">
          <EmptyState mood="idle" action={<WalletMenu />}>
            Connect to see your balance, positions and history.
          </EmptyState>
        </section>
      </div>
    );
  return (
    <div className="page portfolio">
      <h1 className="title-1 page-title">Portfolio</h1>
      {error && <Banner tone="warning">We can't load your account right now. {error.message}</Banner>}
      <div className="portfolio-summary">
        <ValueCard account={account} home={home} />
        <MarginCard account={account} />
      </div>
      <IdleMargin />
      <PerformanceCard address={address} account={account} home={home} />
      <ActivityTabs account={account} full />
    </div>
  );
}
