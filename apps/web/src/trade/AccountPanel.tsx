import { useState } from "react";
import { useTrading } from "../data/actions.js";
import { useOrders } from "../data/queries.js";
import { openMarkets } from "../lib/account.js";
import { txUrl } from "../lib/explorer.js";
import { parseUsdcInput, sentence, signedUsdc, usdc } from "../lib/format.js";
import type { AccountState, RestingOrder } from "../lib/types.js";
import { AccountHistory, FundingHistory, TradeHistory } from "../portfolio/History.js";
import { Positions } from "../positions/Positions.js";
import { Banner, Change, EmptyState, NavIcons, Rows, Tabs } from "../ui/primitives.js";
import { useTrader } from "../wallet/trader.js";
import { WalletMenu } from "../wallet/WalletMenu.js";
import { useFunds } from "./FundsDialog.js";

/** Account value and the two funds actions. */
export function AccountCard({ account }: { account: AccountState | null }) {
  const funds = useFunds();
  if (!account) return null;
  return <section className="rfq-card rfq-card--pad stack account-card" aria-label="Account">
    <div><div className="footnote rfq-muted">Account value</div><div className="balance">{usdc(account.equity)}</div></div>
    <Rows rows={[
      ["Available to trade", usdc(account.availableMargin)],
      ["Unrealized PnL", <Change key="pnl" value={BigInt(account.unrealizedPnl)}>{signedUsdc(account.unrealizedPnl)}</Change>],
    ]} />
    {account.liquidatable && <Banner tone="danger"><b>Your account can be liquidated.</b> Add funds or close a position now.</Banner>}
    <div className="two-buttons">
      <button type="button" className="rfq-btn rfq-btn--secondary" onClick={() => funds.open("deposit")}>Deposit</button>
      <button type="button" className="rfq-btn rfq-btn--secondary" onClick={() => funds.open("withdraw")}>Withdraw</button>
    </div>
  </section>;
}

type Tab = "positions" | "orders" | "trades" | "funding" | "activity";

/**
 * Positions, orders and trades under the chart (desktop). Portfolio passes
 * `full` to add funding and account activity (deposits, withdrawals).
 */
export function ActivityTabs({ account, full = false }: { account: AccountState | null; full?: boolean }) {
  const trader = useTrader();
  const orders = useOrders(trader.address);
  const [tab, setTab] = useState<Tab>("positions");
  const openOrders = orders.data?.filter(order => order.status === "open" || order.status === "executing") ?? [];
  const positionCount = openMarkets(account).length;
  return <section className="rfq-card activity">
    <div className="activity-tabs"><Tabs label="Account activity" value={tab} onChange={setTab} tabs={[
      { id: "positions", label: "Positions", count: positionCount },
      { id: "orders", label: "Orders", count: openOrders.length },
      { id: "trades", label: "Trades" },
      ...(full ? [{ id: "funding" as const, label: "Funding" }, { id: "activity" as const, label: "Transfers" }] : []),
    ]} /></div>
    <div className="activity-body">
      {!trader.address ? <EmptyState icon={NavIcons.portfolio} action={<WalletMenu />}>Connect to see your positions, orders and history.</EmptyState>
        : tab === "positions" ? (positionCount ? <Positions account={account} /> : <EmptyState>Your open trades show up here.</EmptyState>)
        : tab === "orders" ? <Orders orders={orders.data ?? []} />
        : tab === "trades" ? <TradeHistory address={trader.address} />
        : tab === "funding" ? <FundingHistory address={trader.address} />
        : <AccountHistory address={trader.address} />}
    </div>
  </section>;
}

function Orders({ orders }: { orders: RestingOrder[] }) {
  const trading = useTrading(), trader = useTrader();
  if (!orders.length) return <EmptyState icon={NavIcons.markets}>Limit orders you place show up here. Switch to Advanced to place one.</EmptyState>;
  return <div className="rfq-table-wrap"><table className="rfq-table">
    <thead><tr><th>Order</th><th>Size</th><th>Limit</th><th>Expires</th><th>Status</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
    <tbody>{orders.slice(0, 20).map(order => {
      const link = order.transactionHash ? txUrl(trader.chain.id, order.transactionHash) : undefined;
      return <tr key={order.orderId}>
        <td><span className={order.side === "buy" ? "rfq-up" : "rfq-down"}>{order.side === "buy" ? "Long" : "Short"}</span> {order.market}</td>
        <td>{usdc(parseUsdcInput(order.amount))}</td>
        <td>{usdc(order.limitPrice)}</td>
        <td>{new Date(order.expiresAtMs).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
        <td><span className={`rfq-badge${order.status === "filled" ? " rfq-badge--long" : order.status === "open" ? " rfq-badge--brand" : ""}`} title={order.lastError}>{sentence(order.status).replace(/^./, letter => letter.toUpperCase())}</span>{link && <> <a href={link} target="_blank" rel="noreferrer">View</a></>}</td>
        <td>{(order.status === "open" || order.status === "executing") && <button type="button" className="rfq-btn rfq-btn--sm rfq-btn--secondary" disabled={trading.busy !== null} onClick={() => trading.cancelOrder(order)}>Cancel</button>}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}
