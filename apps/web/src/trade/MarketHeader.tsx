import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useMarketFeed, useMarketPrice } from "../data/market-feed.js";
import { useMarketList } from "../data/markets.js";
import { useMarketStats } from "../data/market-stats.js";
import { usdc } from "../lib/format.js";
import { dayChange, priceChange, searchMarkets, type PriceStatus } from "../lib/market-stats.js";
import type { Market } from "../lib/types.js";
import { AssetIcon, Banner, Change, Chevron, Sheet, marketName } from "../ui/primitives.js";
import { SearchField } from "../ui/SearchField.js";

export const pct = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" });

/** Show a search box in market pickers once the list is long enough to need one. */
export const SEARCH_FROM = 6;

/** A badge for any price state other than live; nothing while live. */
export function PriceStatusBadge({ status, connecting = false }: { status: PriceStatus; connecting?: boolean }) {
  if (status === "live") return null;
  const [tone, label] = connecting ? ["warning", "Connecting to prices"]
    : status === "delayed" ? ["warning", "Price delayed"]
    : status === "paused" ? ["warning", "Paused"]
    : ["neutral", "No price"];
  return <span className={`rfq-badge price-status price-status--${status}${tone === "warning" ? " rfq-badge--warning" : ""}`}><span className="rfq-dot" />{label}</span>;
}

export function MarketSwitcher({ market }: { market: Market }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { snapshot } = useMarketFeed();
  const { symbols } = useMarketList();
  const stats = useMarketStats().data?.markets;
  const shown = searchMarkets(symbols, query, marketName);
  const close = () => { setOpen(false); setQuery(""); };
  return <>
    <button type="button" className="rfq-account-btn market-switcher" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <AssetIcon market={market} small />{marketName(market)}<Chevron />
    </button>
    <Sheet open={open} onClose={close} title="Markets" labelledBy="market-picker-title">
      {symbols.length >= SEARCH_FROM && <SearchField value={query} onChange={setQuery} label="Search markets" autoFocus />}
      <div className="rfq-list market-picker">
        {shown.map(name => {
          const live = snapshot?.markets[name], change = dayChange(stats?.[name], live?.mid);
          return <Link key={name} to="/trade/$market" params={{ market: name }} className="rfq-row" onClick={close}>
            <AssetIcon market={name} />
            <span><div className="rfq-row__title">{marketName(name)}</div><div className="rfq-row__sub">{name}</div></span>
            <span className="rfq-row__end"><span className="rfq-row__price">{usdc(live?.mid)}</span>
              {change ? <Change value={change.ratio}>{pct.format(change.ratio)}</Change> : !live && <span className="footnote rfq-faint">No price</span>}</span>
          </Link>;
        })}
        {!shown.length && <p className="footnote rfq-faint picker-empty">No markets match “{query}”.</p>}
      </div>
    </Sheet>
  </>;
}

/**
 * Live price and its change against `reference` (USDC micro), or the scrubbed
 * point while the pointer is on the chart. `extra` sits under the change line.
 */
export function PriceHeader({ market, reference, period, scrub, extra }: {
  market: Market; reference?: string | null; period: string; scrub?: { value: number; label: string } | null; extra?: ReactNode;
}) {
  const { status: stream } = useMarketFeed();
  const { live, last, status } = useMarketPrice(market);
  const shownMicro = scrub ? BigInt(Math.round(scrub.value * 1e6)) : live ? BigInt(live.mid) : last ? BigInt(last.mid) : null;
  const change = priceChange(reference, shownMicro);
  const dim = !scrub && status !== "live" && status !== "paused";
  return <div className="price-header">
    <div className={`price-hero tnum${dim ? " is-stale" : ""}`} aria-live="off">{shownMicro === null ? "—" : usd.format(Number(shownMicro) / 1e6)}</div>
    <div className="price-sub">
      {change && <Change value={change.delta}>{dollars.format(change.delta)} ({pct.format(change.ratio)})</Change>}
      <span className="footnote rfq-faint">{scrub ? scrub.label : change ? period : ""}</span>
      {!scrub && <PriceStatusBadge status={status} connecting={stream === "connecting" && !live} />}
    </div>
    {extra}
    <MarketBanners market={market} />
  </div>;
}

/** Paused, guarded, reduce-only and missing-price notices for one market. */
export function MarketBanners({ market }: { market: Market }) {
  const { snapshot } = useMarketFeed();
  const { live, status } = useMarketPrice(market);
  if (!live) return snapshot ? <Banner tone="warning"><b>{marketName(market)} has no price right now.</b> Trading resumes when the oracle prices it again.</Banner> : null;
  if (status === "paused") return <Banner tone="warning"><b>{marketName(market)} is paused.</b> You can still close a position.</Banner>;
  if (live.riskMode === "guarded") return <Banner tone="warning">Trade sizes are smaller than usual while our hedge catches up.</Banner>;
  if (live.riskMode === "reduce_only") return <Banner tone="warning"><b>Only closing trades right now.</b> Opening new positions is paused while our hedge is unavailable.</Banner>;
  return null;
}
