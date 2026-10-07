import { Fragment } from "react";
import { Link } from "@tanstack/react-router";
import { useMarketFeed } from "../data/market-feed.js";
import { useIndexerHealth, usePublicPositions, useRecentTrades, useRisk } from "../data/queries.js";
import { abs, baseAmount, clockTime, fundingApr, shortAddress, signedBase, usdc } from "../lib/format.js";
import { MARKETS, marketFromIndex, type Market, type RiskMarket } from "../lib/types.js";
import { AssetIcon, Empty, Stat, toneOf } from "../ui/primitives.js";

const accounts = (count = 0) => `${count} ${count === 1 ? "account" : "accounts"}`;

function ExposureCard({ market, risk }: { market: Market; risk?: RiskMarket }) {
  const live = useMarketFeed().snapshot?.markets[market];
  const long = risk ? Number(BigInt(risk.longBase)) : 0, short = risk ? Number(BigInt(risk.shortBase)) : 0;
  const longShare = long + short ? long / (long + short) * 100 : 50;
  return <article className="panel exposure-card">
    <header><Link to="/trade/$market" params={{ market }}><AssetIcon market={market} /><b>{market}-PERP</b></Link>
      {risk && <span className={toneOf(risk.netBase)}>{signedBase(risk.netBase, market)} net</span>}</header>
    <div className="stat-grid three">
      <Stat label="Oracle mid">{usdc(live?.mid)}</Stat>
      <Stat label="Bid / ask">{live ? `${usdc(live.bid)} / ${usdc(live.ask)}` : "—"}</Stat>
      <Stat label="Funding APR">{fundingApr(live?.fundingApr)}</Stat>
    </div>
    <div className="exposure-bar" aria-label={`${longShare.toFixed(0)}% long`}><span style={{ width: `${longShare}%` }} /></div>
    <div className="exposure-sides">
      <div><small>Long</small><strong className="mono">{risk ? `${baseAmount(risk.longBase)} ${market}` : "—"}</strong><span>{accounts(risk?.longAccounts)}</span></div>
      <div><small>Short</small><strong className="mono">{risk ? `${baseAmount(risk.shortBase)} ${market}` : "—"}</strong><span>{accounts(risk?.shortAccounts)}</span></div>
    </div>
  </article>;
}

export function MarketsPage() {
  const risk = useRisk(), positions = usePublicPositions(), trades = useRecentTrades(), health = useIndexerHealth();
  const failed = [risk, positions, trades, health].find(query => query.isError);
  return <div className="markets-page">
    <header className="page-heading">
      <div><small className="eyebrow"><i className={health.data?.ok ? "online" : ""} />Chain-derived · finalized</small>
        <h1>Market activity</h1><p>Open interest, positions and executions indexed from the public settlement contract.</p></div>
      <div className="block-state"><small>Finalized block</small><strong className="mono">{risk.data?.indexedBlock.toLocaleString() ?? "—"}</strong>
        <span>{health.data ? health.data.lag === 0 ? "Indexer caught up" : `${health.data.lag} blocks behind` : "Indexer status unknown"}{risk.dataUpdatedAt ? ` · ${clockTime(risk.dataUpdatedAt)}` : ""}</span></div>
    </header>
    {failed && <p className="notice warn">The indexer is unavailable: {failed.error?.message}. {risk.data ? "Showing the last complete snapshot." : ""}</p>}
    <div className="stat-grid three summary-cards">
      <article className="panel"><Stat label="Deposited collateral">{usdc(risk.data?.totalCollateral)}</Stat></article>
      <article className="panel"><Stat label="Indexed accounts">{risk.data?.accountCount ?? "—"}</Stat></article>
      <article className="panel"><Stat label="Open positions">{positions.data?.total ?? "—"}</Stat></article>
    </div>
    <div className="exposure-grid">{MARKETS.map(market => <ExposureCard key={market} market={market} risk={risk.data?.markets[market]} />)}</div>

    <section className="panel">
      <header className="panel-heading"><div><h2>Open positions</h2><p>Pseudonymous wallet state at the finalized block.</p></div><span>{positions.data?.total ?? 0} total</span></header>
      {positions.data?.items.length ? <div className="table-wrap"><table>
        <thead><tr><th>Wallet</th><th>Collateral</th>{MARKETS.map(market => <Fragment key={market}><th>{market} position</th><th>{market} entry</th></Fragment>)}</tr></thead>
        <tbody>{positions.data.items.map(row => <tr key={row.account}>
          <td className="mono" title={row.account}>{shortAddress(row.account)}</td>
          <td className="mono">{usdc(row.collateral)}</td>
          {MARKETS.map(market => {
            const { size, entryPrice } = row.positions[market], open = BigInt(size) !== 0n;
            return <Fragment key={market}>
              <td className={`mono ${toneOf(size)}`}>{open ? signedBase(size, market) : "—"}</td>
              <td className="mono">{open ? usdc(entryPrice) : "—"}</td>
            </Fragment>;
          })}
        </tr>)}</tbody>
      </table></div> : <Empty>{positions.isPending ? "Loading…" : "No open positions."}</Empty>}
    </section>

    <section className="panel">
      <header className="panel-heading"><div><h2>Recent trades</h2><p>Finalized settlement events, newest first.</p></div><span>{trades.data?.length ?? 0} shown</span></header>
      {trades.data?.length ? <div className="table-wrap"><table>
        <thead><tr><th>Time</th><th>Wallet</th><th>Market</th><th>Side</th><th>Size</th><th>Price</th><th>Fee</th><th>Block</th></tr></thead>
        <tbody>{trades.data.map(trade => {
          const market = marketFromIndex(trade.market), delta = BigInt(trade.payload.baseDelta ?? "0"), buy = delta > 0n;
          return <tr key={`${trade.tx_hash}:${trade.log_index}`}>
            <td>{clockTime(trade.timestamp * 1_000)}</td>
            <td className="mono" title={trade.account}>{shortAddress(trade.account)}</td>
            <td>{market}-PERP</td>
            <td><span className={`pill ${buy ? "positive" : "negative"}`}>{buy ? "Buy" : "Sell"}</span></td>
            <td className="mono">{baseAmount(abs(delta))} {market}</td>
            <td className="mono">{usdc(trade.payload.price)}</td>
            <td className="mono">{usdc(trade.payload.fee)}</td>
            <td className="mono">{trade.block_number}</td>
          </tr>;
        })}</tbody>
      </table></div> : <Empty>{trades.isPending ? "Loading…" : "No trades indexed yet."}</Empty>}
    </section>
  </div>;
}
