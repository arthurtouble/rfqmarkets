import { useState } from "react";
import { useAccount } from "../account/useAccount.js";
import { useMarketFeed } from "../data/market-feed.js";
import { fundingApr, usdc } from "../lib/format.js";
import type { Market, Side } from "../lib/types.js";
import { Banner, Down, Rows, Sheet, Up } from "../ui/primitives.js";
import { useAdvanced, useDesktop } from "../ui/prefs.js";
import { WalletMenu } from "../wallet/WalletMenu.js";
import { Positions } from "../positions/Positions.js";
import { AccountCard, ActivityTabs } from "./AccountPanel.js";
import { MarketSwitcher, PriceHeader } from "./MarketHeader.js";
import { OrderTicket } from "./OrderTicket.js";
import { PriceChart } from "./PriceChart.js";

function MarketDetails({ market }: { market: Market }) {
  const { snapshot } = useMarketFeed();
  const advanced = useAdvanced();
  const live = snapshot?.markets[market];
  return <Rows className="market-details" rows={[
    ["Funding (yearly)", fundingApr(live?.fundingApr)],
    ["Max per trade", usdc(live?.operatingMaxTradeNotional)],
    ...(advanced ? [
      ["Bid", usdc(live?.bid)], ["Ask", usdc(live?.ask)],
      ["Spread", live ? `${live.spread?.totalBps ?? live.baseSpreadBps} bps` : "—"],
      ["Max open per market", usdc(live?.maxMarketNotional)],
    ] as Array<[string, string]> : []),
  ]} />;
}

export function TradePage({ market }: { market: Market }) {
  const desktop = useDesktop();
  const { history } = useMarketFeed();
  const { account, error } = useAccount();
  const [side, setSide] = useState<Side>("buy");
  const [ticketOpen, setTicketOpen] = useState(false);
  const accountError = error && <Banner tone="warning">We can't load your account right now. {error.message}</Banner>;

  if (desktop) return <div className="page trade-desktop">
    <div className="trade-main">
      <section className="rfq-card rfq-card--pad chart-card">
        <div className="chart-card__head"><MarketSwitcher market={market} /></div>
        <PriceHeader market={market} />
        <PriceChart values={history[market] ?? []} height={300} />
        <MarketDetails market={market} />
      </section>
      {accountError}
      <ActivityTabs account={account} />
    </div>
    <aside className="trade-side">
      <section className="rfq-card rfq-card--pad" aria-label="Order ticket"><OrderTicket market={market} account={account} side={side} onSide={setSide} /></section>
      <AccountCard account={account} />
    </aside>
  </div>;

  const openTicket = (next: Side) => { setSide(next); setTicketOpen(true); };
  return <div className="trade-mobile">
    <div className="trade-mobile__top">
      <MarketSwitcher market={market} />
      <WalletMenu />
    </div>
    <div className="trade-mobile__price"><PriceHeader market={market} /></div>
    <PriceChart values={history[market] ?? []} height={200} />
    <div className="trade-mobile__body">
      {accountError}
      {account && <Positions account={account} only={market} />}
      <MarketDetails market={market} />
    </div>
    <div className="trade-mobile__actions">
      <button type="button" className="rfq-btn rfq-btn--lg rfq-btn--long" onClick={() => openTicket("buy")}><Up /> Long</button>
      <button type="button" className="rfq-btn rfq-btn--lg rfq-btn--short" onClick={() => openTicket("sell")}><Down /> Short</button>
    </div>
    <Sheet open={ticketOpen} onClose={() => setTicketOpen(false)} title={`Trade ${market}`} labelledBy="ticket-title">
      <OrderTicket market={market} account={account} side={side} onSide={setSide} onTraded={() => setTicketOpen(false)} />
    </Sheet>
  </div>;
}
