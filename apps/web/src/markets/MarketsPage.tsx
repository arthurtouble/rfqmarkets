import { Fragment } from "react";
import { Link } from "@tanstack/react-router";
import { useMarketFeed } from "../data/market-feed.js";
import { useIndexerHealth, usePublicPositions, useRecentTrades, useRisk } from "../data/queries.js";
import { abs, baseAmount, clockTime, fundingApr, shortAddress, signedBase, usdc } from "../lib/format.js";
import { useMarketList } from "../data/markets.js";
import type { Market, RiskMarket } from "../lib/types.js";
import { AssetIcon, Banner, Change, EmptyState, NavIcons, Rows, marketName } from "../ui/primitives.js";
import { useAdvanced } from "../ui/prefs.js";
import { recentChange, useSymbols } from "../trade/MarketHeader.js";

const pct = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" });
const traders = (count = 0) => `${count} ${count === 1 ? "trader" : "traders"}`;
const tone = (value: string) => BigInt(value) > 0n ? "rfq-up" : BigInt(value) < 0n ? "rfq-down" : "";

function MarketRow({ market }: { market: Market }) {
  const { snapshot, history } = useMarketFeed();
  const live = snapshot?.markets[market];
  const change = recentChange(history[market] ?? []);
  return <Link to="/trade/$market" params={{ market }} className="rfq-row">
    <AssetIcon market={market} />
    <span><div className="rfq-row__title">{marketName(market)}</div><div className="rfq-row__sub">{market} · funding {fundingApr(live?.fundingApr)}</div></span>
    <span className="rfq-row__end"><span className="rfq-row__price">{usdc(live?.mid)}</span>
      {change ? <Change value={change.ratio}>{pct.format(change.ratio)}</Change> : <span className="footnote rfq-faint">{live?.enabled === false ? "Paused" : "Live"}</span>}</span>
  </Link>;
}

/** How traders are leaning in one market: long vs short open interest. */
function Sentiment({ market, risk }: { market: Market; risk?: RiskMarket }) {
  const long = risk ? Number(BigInt(risk.longBase)) : 0, short = risk ? Number(BigInt(risk.shortBase)) : 0;
  const longShare = long + short ? long / (long + short) * 100 : 50;
  return <div className="sentiment">
    <div className="sentiment__head"><AssetIcon market={market} small /><b>{marketName(market)}</b>
      <span className="footnote rfq-faint">{long + short ? `${longShare.toFixed(0)}% long` : "No open positions"}</span></div>
    <div className={`sentiment__bar${long + short ? "" : " is-empty"}`} role="img" aria-label={long + short ? `${longShare.toFixed(0)}% long, ${(100 - longShare).toFixed(0)}% short` : "No open positions"}><span style={{ width: `${longShare}%` }} /></div>
    <div className="sentiment__sides footnote">
      <span><span className="rfq-up">Long</span> {risk ? `${baseAmount(risk.longBase)} ${market}` : "—"} · {traders(risk?.longAccounts)}</span>
      <span><span className="rfq-down">Short</span> {risk ? `${baseAmount(risk.shortBase)} ${market}` : "—"} · {traders(risk?.shortAccounts)}</span>
    </div>
  </div>;
}

export function MarketsPage() {
  const advanced = useAdvanced();
  const risk = useRisk(), positions = usePublicPositions(), trades = useRecentTrades(), health = useIndexerHealth();
  const failed = [risk, positions, trades, health].find(query => query.isError);
  const MARKETS = useSymbols(), { marketFromIndex } = useMarketList();
  return <div className="page markets-page">
    <h1 className="title-1 page-title">Markets</h1>
    <section className="rfq-card"><div className="rfq-list">{MARKETS.map(market => <MarketRow key={market} market={market} />)}</div></section>

    {failed && <Banner tone="warning">Market stats are unavailable right now. {risk.data ? "Showing the last update." : ""}</Banner>}

    <section className="rfq-card rfq-card--pad stack">
      <h2 className="headline">Open interest</h2>
      {MARKETS.map(market => <Sentiment key={market} market={market} risk={risk.data?.markets[market]} />)}
      <Rows rows={[
        ["Total deposited", usdc(risk.data?.totalCollateral)],
        ["Traders", String(risk.data?.accountCount ?? "—")],
        ["Open positions", String(positions.data?.total ?? "—")],
        ...(advanced ? [
          ["Finalized block", risk.data?.indexedBlock.toLocaleString() ?? "—"],
          ["Indexer", health.data ? health.data.lag === 0 ? "Caught up" : `${health.data.lag} blocks behind` : "Unknown"],
          ["Updated", risk.dataUpdatedAt ? clockTime(risk.dataUpdatedAt) : "—"],
        ] as Array<[string, string]> : []),
      ]} />
    </section>

    <section className="rfq-card">
      <h2 className="headline card-title">Recent trades</h2>
      {trades.data?.length ? <div className="rfq-table-wrap"><table className="rfq-table">
        <thead><tr><th>Market</th><th>Side</th><th>Size</th><th>Price</th>{advanced && <><th>Fee</th><th>Wallet</th></>}<th>Time</th></tr></thead>
        <tbody>{trades.data.map(trade => {
          const market = marketFromIndex(trade.market), delta = BigInt(trade.payload.baseDelta ?? "0"), long = delta > 0n;
          return <tr key={`${trade.tx_hash}:${trade.log_index}`}>
            <td><span className="cell-market">{market && <AssetIcon market={market} small />}{market ?? "—"}</span></td>
            <td><span className={`rfq-badge rfq-badge--${long ? "long" : "short"}`}>{long ? "Long" : "Short"}</span></td>
            <td>{baseAmount(abs(delta))} {market ?? ""}</td>
            <td>{usdc(trade.payload.price)}</td>
            {advanced && <><td>{usdc(trade.payload.fee)}</td><td className="mono" title={trade.account}>{shortAddress(trade.account)}</td></>}
            <td className="rfq-faint">{clockTime(trade.timestamp * 1_000)}</td>
          </tr>;
        })}</tbody>
      </table></div> : <EmptyState icon={NavIcons.markets}>{trades.isPending ? "Loading trades…" : "No trades yet."}</EmptyState>}
    </section>

    {advanced && <section className="rfq-card">
      <h2 className="headline card-title">Open positions</h2>
      {positions.data?.items.length ? <div className="rfq-table-wrap"><table className="rfq-table">
        <thead><tr><th>Wallet</th><th>Collateral</th>{MARKETS.map(market => <Fragment key={market}><th>{market} size</th><th>{market} entry</th></Fragment>)}</tr></thead>
        <tbody>{positions.data.items.map(row => <tr key={row.account}>
          <td className="mono" title={row.account}>{shortAddress(row.account)}</td>
          <td>{usdc(row.collateral)}</td>
          {MARKETS.map(market => {
            const { size, entryPrice } = row.positions[market], open = BigInt(size) !== 0n;
            return <Fragment key={market}>
              <td className={tone(size)}>{open ? signedBase(size, market) : "—"}</td>
              <td>{open ? usdc(entryPrice) : "—"}</td>
            </Fragment>;
          })}
        </tr>)}</tbody>
      </table></div> : <EmptyState icon={NavIcons.portfolio}>{positions.isPending ? "Loading positions…" : "No open positions."}</EmptyState>}
    </section>}
  </div>;
}
