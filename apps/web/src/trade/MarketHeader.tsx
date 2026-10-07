import { Link } from "@tanstack/react-router";
import { useMarketFeed } from "../data/market-feed.js";
import { fundingApr, usdc } from "../lib/format.js";
import { MARKETS, type Market } from "../lib/types.js";
import { AssetIcon, LiveBadge } from "../ui/primitives.js";
import { PriceChart } from "./PriceChart.js";

export function MarketHeader({ market }: { market: Market }) {
  const { snapshot, status, history } = useMarketFeed();
  const live = snapshot?.markets[market];
  return <section className="panel market-stage">
    <header>
      <nav className="market-switch" aria-label="Markets">
        {MARKETS.map(name => <Link key={name} to="/trade/$market" params={{ market: name }} className={name === market ? "active" : ""}>
          <AssetIcon market={name} /><span><b>{name}-PERP</b><small>{usdc(snapshot?.markets[name].mid)}</small></span>
        </Link>)}
      </nav>
      <div className="market-last"><strong className="mono">{usdc(live?.mid)}</strong><LiveBadge status={status} /></div>
      <dl className="market-stats">
        <div><dt>Bid</dt><dd className="mono">{usdc(live?.bid)}</dd></div>
        <div><dt>Ask</dt><dd className="mono">{usdc(live?.ask)}</dd></div>
        <div><dt>Funding APR</dt><dd className="mono">{fundingApr(live?.fundingApr)}</dd></div>
        <div><dt>Quote spread</dt><dd className="mono">{live ? `${live.spread?.totalBps ?? live.baseSpreadBps} bps` : "—"}</dd></div>
        <div><dt>Max trade</dt><dd className="mono">{usdc(live?.operatingMaxTradeNotional)}</dd></div>
      </dl>
    </header>
    {live && live.riskMode !== "normal" && <p className="notice warn">{live.riskMode === "guarded"
      ? "Hedging is catching up, so trade sizes are temporarily reduced."
      : "Hedging is unavailable. Only trades that reduce market exposure can execute."}</p>}
    <PriceChart values={history[market]} />
  </section>;
}
