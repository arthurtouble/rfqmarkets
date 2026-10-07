import { Fragment, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMarketFeed, useMarketPrice } from "../data/market-feed.js";
import { useMarketStats } from "../data/market-stats.js";
import { useIndexerHealth, usePublicPositions, useRecentTrades, useRisk } from "../data/queries.js";
import { abs, baseAmount, clockTime, fundingApr, shortAddress, signedBase, usdc } from "../lib/format.js";
import { useMarketList } from "../data/markets.js";
import { dayChange, dayRange, searchMarkets, type DayStats } from "../lib/market-stats.js";
import type { Market, RiskMarket } from "../lib/types.js";
import { AssetIcon, Banner, Change, EmptyState, NavIcons, Rows, marketName } from "../ui/primitives.js";
import { useAdvanced } from "../ui/prefs.js";
import { SearchField } from "../ui/SearchField.js";
import { Sparkline } from "../ui/Sparkline.js";
import { PriceStatusBadge, pct } from "../trade/MarketHeader.js";

const traders = (count = 0) => `${count} ${count === 1 ? "trader" : "traders"}`;
const tone = (value: string) => BigInt(value) > 0n ? "rfq-up" : BigInt(value) < 0n ? "rfq-down" : "";

function MarketRow({ market, stats, maxLeverage, advanced }: { market: Market; stats?: DayStats; maxLeverage?: number; advanced: boolean }) {
  const { status: stream } = useMarketFeed();
  const { live, last, status } = useMarketPrice(market);
  const change = dayChange(stats, live?.mid), day = dayRange(stats, live?.mid);
  // Hourly closes plus the live mid; a market younger than two hours has no trend to show yet.
  const spark = stats && stats.spark.length > 1 ? [...stats.spark.map(value => Number(value) / 1e6), ...(live ? [Number(live.mid) / 1e6] : [])] : [];
  const price = live?.mid ?? last?.mid;
  return <Link to="/trade/$market" params={{ market }} className="market-row" data-market={market} data-status={status}>
    <span className="market-row__name">
      <AssetIcon market={market} />
      <span><span className="rfq-row__title">{marketName(market)}</span>
        <span className="rfq-row__sub">{market}{maxLeverage ? <span className="lev-tag">{maxLeverage}×</span> : null}</span></span>
    </span>
    <span className="market-row__spark">{spark.length > 1 && <Sparkline values={spark} />}</span>
    <span className="market-row__price">
      <span className={`rfq-row__price tnum${status === "delayed" || (!live && price) ? " is-stale" : ""}`}>{price ? usdc(price) : "—"}</span>
      {status !== "live" ? <PriceStatusBadge status={status} connecting={stream === "connecting" && !live} />
        : change && <span className="market-row__inline-change"><Change value={change.ratio}>{pct.format(change.ratio)}</Change></span>}
    </span>
    <span className="market-row__change tnum">{change ? <Change value={change.ratio}>{pct.format(change.ratio)}</Change> : "—"}</span>
    <span className="market-row__stat tnum">{fundingApr(live?.fundingApr)}</span>
    {advanced && <><span className="market-row__stat tnum">{usdc(day?.high)}</span><span className="market-row__stat tnum">{usdc(day?.low)}</span></>}
  </Link>;
}

function MarketList() {
  const advanced = useAdvanced();
  const [query, setQuery] = useState("");
  const { markets, symbols, get } = useMarketList();
  const stats = useMarketStats();
  const shown = searchMarkets(symbols, query, marketName);
  return <section className={`rfq-card market-list${advanced ? " is-advanced" : ""}`} aria-label="Markets">
    <div className="market-list__tools">
      <SearchField value={query} onChange={setQuery} label="Search markets" placeholder="Search by name or symbol" />
      <span className="footnote rfq-faint">{markets.length} {markets.length === 1 ? "market" : "markets"} · open 24/7</span>
    </div>
    <div className="market-row market-row--head" aria-hidden="true">
      <span>Market</span><span className="market-row__spark">24h</span><span className="market-row__price">Price</span>
      <span className="market-row__change">24h change</span><span className="market-row__stat">Funding (yearly)</span>
      {advanced && <><span className="market-row__stat">24h high</span><span className="market-row__stat">24h low</span></>}
    </div>
    <div className="market-list__rows">
      {shown.map(market => <MarketRow key={market} market={market} stats={stats.data?.markets[market]} maxLeverage={get(market)?.maxLeverage} advanced={advanced} />)}
      {!shown.length && <EmptyState icon={NavIcons.markets}>No markets match “{query.trim()}”.</EmptyState>}
    </div>
    {stats.isError && !stats.data && <p className="footnote rfq-faint market-list__note">24h stats are unavailable right now.</p>}
  </section>;
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
  const { symbols: MARKETS, marketFromIndex } = useMarketList();
  return <div className="page markets-page">
    <h1 className="title-1 page-title">Markets</h1>
    <MarketList />

    {failed && <Banner tone="warning">Market stats are unavailable right now. {risk.data ? "Showing the last update." : ""}</Banner>}

    <section className="rfq-card rfq-card--pad stack" aria-labelledby="open-interest-title">
      <h2 className="headline" id="open-interest-title">Open interest</h2>
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

    <section className="rfq-card" aria-labelledby="recent-trades-title">
      <h2 className="headline card-title" id="recent-trades-title">Recent trades</h2>
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

    {advanced && <section className="rfq-card" aria-labelledby="open-positions-title">
      <h2 className="headline card-title" id="open-positions-title">Open positions</h2>
      {positions.data?.items.length ? <div className="rfq-table-wrap"><table className="rfq-table">
        <thead><tr><th>Wallet</th><th>Collateral</th>{MARKETS.map(market => <Fragment key={market}><th>{market} size</th><th>{market} entry</th></Fragment>)}</tr></thead>
        <tbody>{positions.data.items.map(row => <tr key={row.account}>
          <td className="mono" title={row.account}>{shortAddress(row.account)}</td>
          <td>{usdc(row.collateral)}</td>
          {MARKETS.map(market => {
            const { size, entryPrice } = row.positions[market] ?? { size: "0", entryPrice: "0" }, open = BigInt(size) !== 0n;
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
