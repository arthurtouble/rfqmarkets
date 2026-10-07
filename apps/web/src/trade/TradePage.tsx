import { useMarketFeed } from "../data/market-feed.js";
import { useAccountState } from "../data/queries.js";
import { emptyAccount, markAccount } from "../lib/account.js";
import type { Market } from "../lib/types.js";
import { useTrader } from "../wallet/trader.js";
import { AccountSummary, AccountTabs } from "./AccountPanel.js";
import { MarketHeader } from "./MarketHeader.js";
import { OrderTicket } from "./OrderTicket.js";

export function TradePage({ market }: { market: Market }) {
  const { snapshot } = useMarketFeed();
  const { address } = useTrader();
  const state = useAccountState(address);
  const account = address ? markAccount(state.data ?? emptyAccount(address, snapshot), snapshot) : null;
  return <div className="trade-layout">
    <div className="trade-main">
      <MarketHeader market={market} />
      {state.isError && <p className="notice warn">Account data is unavailable right now: {state.error.message}</p>}
      <AccountTabs account={account} />
    </div>
    <aside className="trade-side">
      <OrderTicket market={market} account={account} />
      <AccountSummary account={account} />
    </aside>
  </div>;
}
