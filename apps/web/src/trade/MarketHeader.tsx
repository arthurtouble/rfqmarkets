import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMarketFeed } from "../data/market-feed.js";
import { usdc } from "../lib/format.js";
import { MARKETS, type Market } from "../lib/types.js";
import { AssetIcon, Banner, Change, Chevron, MARKET_NAMES, Sheet, StreamBadge } from "../ui/primitives.js";

const pct = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" });

/** Price change across the chart's window, for the line under the price. */
export function recentChange(values: number[]) {
  if (values.length < 2 || !values[0]) return null;
  const delta = values.at(-1)! - values[0];
  return { delta, ratio: delta / values[0] };
}

export function MarketSwitcher({ market }: { market: Market }) {
  const [open, setOpen] = useState(false);
  const { snapshot, history } = useMarketFeed();
  return <>
    <button type="button" className="rfq-account-btn market-switcher" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <AssetIcon market={market} small />{MARKET_NAMES[market]}<Chevron />
    </button>
    <Sheet open={open} onClose={() => setOpen(false)} title="Markets" labelledBy="market-picker-title">
      <div className="rfq-list">
        {MARKETS.map(name => {
          const change = recentChange(history[name]);
          return <Link key={name} to="/trade/$market" params={{ market: name }} className="rfq-row" aria-current={name === market ? "true" : undefined} onClick={() => setOpen(false)}>
            <AssetIcon market={name} />
            <span><div className="rfq-row__title">{MARKET_NAMES[name]}</div><div className="rfq-row__sub">{name}</div></span>
            <span className="rfq-row__end"><span className="rfq-row__price">{usdc(snapshot?.markets[name].mid)}</span>
              {change && <Change value={change.ratio}>{pct.format(change.ratio)}</Change>}</span>
          </Link>;
        })}
      </div>
    </Sheet>
  </>;
}

/** Live price, recent change and anything wrong with the market. */
export function PriceHeader({ market }: { market: Market }) {
  const { snapshot, status, history } = useMarketFeed();
  const live = snapshot?.markets[market];
  const change = recentChange(history[market]);
  // While the stream reconnects, show the last price we saw, dimmed.
  const last = history[market].at(-1);
  return <div className="price-header">
    <div className={`price-hero tnum${live ? "" : " is-stale"}`} aria-live="off">{live ? usdc(live.mid) : last ? usd.format(last) : "—"}</div>
    <div className="price-sub">
      {status !== "live" ? <StreamBadge status={status} />
        : change ? <><Change value={change.delta}>{dollars.format(change.delta)} ({pct.format(change.ratio)})</Change><span className="footnote rfq-faint">Recent</span></>
        : <span className="footnote rfq-faint">Live</span>}
    </div>
    {live && !live.enabled && <Banner tone="warning"><b>{MARKET_NAMES[market]} is paused.</b> You can still close a position.</Banner>}
    {live && live.enabled && live.riskMode === "guarded" && <Banner tone="warning">Trade sizes are smaller than usual while our hedge catches up.</Banner>}
    {live && live.enabled && live.riskMode === "reduce_only" && <Banner tone="warning"><b>Only closing trades right now.</b> Opening new positions is paused while our hedge is unavailable.</Banner>}
  </div>;
}
