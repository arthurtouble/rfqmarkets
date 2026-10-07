// Trade, funding and account history from the indexer: a table on desktop and
// a compact list on phones. Trades and funding page with "Show more".
import type { ReactNode } from "react";
import { useMarketList } from "../data/markets.js";
import { useAccountActivity, useFundingHistory, usePortfolioTrades } from "../data/queries.js";
import { txUrl } from "../lib/explorer.js";
import { abs, baseAmount, dateTime, sentence, signedUsdc, usdc } from "../lib/format.js";
import { fillAction, fillRealizes } from "../lib/positions.js";
import type { Activity, Fill, FundingPayment } from "../lib/types.js";
import { Change, EmptyState, NavIcons } from "../ui/primitives.js";
import { useDesktop } from "../ui/prefs.js";
import { useTrader } from "../wallet/trader.js";

function TimeLink({ ms, hash }: { ms: number; hash: string }) {
  const { chain } = useTrader();
  const link = txUrl(chain.id, hash);
  return link ? <a href={link} target="_blank" rel="noreferrer">{dateTime(ms)}</a> : <>{dateTime(ms)}</>;
}

type Paged = { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown };
function More({ query }: { query: Paged }) {
  if (!query.hasNextPage) return null;
  return <div className="history-more">
    <button type="button" className="rfq-btn rfq-btn--sm rfq-btn--ghost" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
      {query.isFetchingNextPage ? <><span className="rfq-spinner" />Loading</> : "Show more"}
    </button>
  </div>;
}

/** One history entry on phones: what happened and when, with the amounts on the right. */
function Row({ title, time, end, sub }: { title: ReactNode; time: ReactNode; end: ReactNode; sub?: ReactNode }) {
  return <li className="history-row">
    <div><div className="history-row__title">{title}</div><div className="caption rfq-faint">{time}</div></div>
    <div className="history-row__end"><div>{end}</div>{sub && <div className="caption rfq-faint">{sub}</div>}</div>
  </li>;
}

const actionTone = (fill: Fill) => (fill.kind === "liquidation" ? "rfq-down" : BigInt(fill.baseDelta) > 0n ? "rfq-up" : "rfq-down");

/** Fills with the realized PnL of each, newest first. */
export function TradeHistory({ address }: { address: string }) {
  const desktop = useDesktop();
  const trades = usePortfolioTrades(address);
  const items = trades.data?.pages.flatMap(page => page.items) ?? [];
  if (trades.isPending) return <EmptyState icon={NavIcons.markets}>Loading trades…</EmptyState>;
  if (trades.isError) return <EmptyState icon={NavIcons.markets}>Trade history is unavailable right now.</EmptyState>;
  if (!items.length) return <EmptyState icon={NavIcons.markets}>Your trades show up here.</EmptyState>;
  const pnl = (fill: Fill) => (fillRealizes(fill) ? <Change value={BigInt(fill.realizedPnl)}>{signedUsdc(fill.realizedPnl)}</Change> : <span className="rfq-faint">—</span>);
  return <>
    {desktop ? <div className="rfq-table-wrap"><table className="rfq-table history-table">
      <thead><tr><th>Time</th><th>Trade</th><th>Size</th><th>Price</th><th>Fee</th><th>Realized PnL</th></tr></thead>
      <tbody>{items.map(fill => <tr key={`${fill.txHash}:${fill.logIndex}`}>
        <td><TimeLink ms={fill.timeMs} hash={fill.txHash} /></td>
        <td><span className={actionTone(fill)}>{fillAction(fill)}</span> {fill.market}</td>
        <td>{baseAmount(abs(BigInt(fill.baseDelta)))} {fill.market}<div className="caption rfq-faint">{usdc(fill.notional)}</div></td>
        <td>{usdc(fill.price)}</td>
        <td>{usdc(fill.fee)}</td>
        <td>{pnl(fill)}</td>
      </tr>)}</tbody>
    </table></div>
      : <ul className="history-list">{items.map(fill => <Row key={`${fill.txHash}:${fill.logIndex}`}
          title={<><span className={actionTone(fill)}>{fillAction(fill)}</span> {fill.market}</>}
          time={<TimeLink ms={fill.timeMs} hash={fill.txHash} />}
          end={fillRealizes(fill) ? pnl(fill) : usdc(fill.notional)}
          sub={`${baseAmount(abs(BigInt(fill.baseDelta)))} ${fill.market} at ${usdc(fill.price)}`} />)}</ul>}
    <More query={trades} />
  </>;
}

/** Funding settlements, newest first. Positive amounts were received. */
export function FundingHistory({ address }: { address: string }) {
  const desktop = useDesktop();
  const funding = useFundingHistory(address);
  const items = funding.data?.pages.flatMap(page => page.items) ?? [];
  if (funding.isPending) return <EmptyState icon={NavIcons.markets}>Loading funding…</EmptyState>;
  if (funding.isError) return <EmptyState icon={NavIcons.markets}>Funding history is unavailable right now.</EmptyState>;
  if (!items.length) return <EmptyState icon={NavIcons.markets}>Funding you pay or receive on open positions shows up here.</EmptyState>;
  const amount = (item: FundingPayment) => <Change value={BigInt(item.amount)}>{signedUsdc(item.amount)}</Change>;
  const what = (item: FundingPayment) => (BigInt(item.amount) >= 0n ? "Received" : "Paid");
  return <>
    {desktop ? <div className="rfq-table-wrap"><table className="rfq-table history-table">
      <thead><tr><th>Time</th><th>Market</th><th>Funding</th><th>Total so far</th></tr></thead>
      <tbody>{items.map(item => <tr key={`${item.txHash}:${item.logIndex}`}>
        <td><TimeLink ms={item.timeMs} hash={item.txHash} /></td>
        <td>{item.market} <span className="rfq-faint">· {what(item)}</span></td>
        <td>{amount(item)}</td>
        <td>{signedUsdc(item.cumulativeFunding)}</td>
      </tr>)}</tbody>
    </table></div>
      : <ul className="history-list">{items.map(item => <Row key={`${item.txHash}:${item.logIndex}`}
          title={`${what(item)} on ${item.market}`} time={<TimeLink ms={item.timeMs} hash={item.txHash} />} end={amount(item)} />)}</ul>}
    <More query={funding} />
  </>;
}

const EVENT_NAMES: Record<string, string> = {
  Deposited: "Deposit", Withdrawn: "Withdrawal", SessionGranted: "One-click trading on",
  SessionRevoked: "One-click trading off", Liquidated: "Liquidation", NonceCancelled: "Order cancelled", PositionClosed: "Closed at oracle price",
};
/** Trades and funding have their own tabs. */
const SEPARATE = new Set(["TradeExecuted", "FundingSettled"]);

/** Deposits, withdrawals, one-click trading and other account events. */
export function AccountHistory({ address }: { address: string }) {
  const desktop = useDesktop();
  const { marketFromIndex } = useMarketList();
  const activity = useAccountActivity(address);
  const items = (activity.data ?? []).filter(item => !SEPARATE.has(item.kind));
  if (activity.isPending) return <EmptyState icon={NavIcons.markets}>Loading activity…</EmptyState>;
  if (activity.isError) return <EmptyState icon={NavIcons.markets}>Account activity is unavailable right now.</EmptyState>;
  if (!items.length) return <EmptyState icon={NavIcons.markets}>Deposits, withdrawals and other account activity show up here.</EmptyState>;
  const name = (item: Activity) => {
    const market = marketFromIndex(item.market);
    return `${EVENT_NAMES[item.kind] ?? sentence(item.kind)}${market ? ` · ${market}` : ""}`;
  };
  const amount = (item: Activity) => (item.payload.amount ? usdc(item.payload.amount) : "—");
  return desktop ? <div className="rfq-table-wrap"><table className="rfq-table history-table">
    <thead><tr><th>Time</th><th>Activity</th><th>Amount</th></tr></thead>
    <tbody>{items.map(item => <tr key={`${item.tx_hash}:${item.log_index}`}>
      <td><TimeLink ms={item.timestamp * 1_000} hash={item.tx_hash} /></td>
      <td>{name(item)}</td>
      <td>{amount(item)}</td>
    </tr>)}</tbody>
  </table></div>
    : <ul className="history-list">{items.map(item => <Row key={`${item.tx_hash}:${item.log_index}`}
        title={name(item)} time={<TimeLink ms={item.timestamp * 1_000} hash={item.tx_hash} />} end={amount(item)} />)}</ul>;
}
