import { useState } from "react";
import { useTrading } from "../data/actions.js";
import { useOrders } from "../data/queries.js";
import { openMarkets } from "../lib/account.js";
import { txUrl } from "../lib/explorer.js";
import { abs, baseAmount, parseUsdcInput, sentence, signedUsdc, usdc } from "../lib/format.js";
import { pairedOrder } from "../lib/orders.js";
import type { AccountState, RestingOrder } from "../lib/types.js";
import { AccountHistory, FundingHistory, TradeHistory } from "../portfolio/History.js";
import { Positions } from "../positions/Positions.js";
import { AssetIcon, Banner, Change, EmptyState, NavIcons, Rows, Tabs } from "../ui/primitives.js";
import { useDesktop } from "../ui/prefs.js";
import { useTrader } from "../wallet/trader.js";
import { WalletMenu } from "../wallet/WalletMenu.js";
import { useFunds } from "./FundsDialog.js";
import { ORDER_TYPE_LABELS, TriggerPnl } from "./TriggerOrders.js";

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
        : tab === "orders" ? (orders.isError && !orders.data ? <EmptyState icon={NavIcons.markets}>We can't load your orders right now. They are still active and will show here once the connection is back.</EmptyState>
          : <Orders orders={orders.data ?? []} account={account} />)
        : tab === "trades" ? <TradeHistory address={trader.address} />
        : tab === "funding" ? <FundingHistory address={trader.address} />
        : <AccountHistory address={trader.address} />}
    </div>
  </section>;
}

const STATUS_BADGE: Record<string, string> = { filled: " rfq-badge--long", open: " rfq-badge--brand", executing: " rfq-badge--brand" };
const capitalized = (text: string) => text.replace(/^./, letter => letter.toUpperCase());
const expiry = (ms: number) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const liveOrder = (order: RestingOrder) => order.status === "open" || order.status === "executing";
const orderKind = (order: RestingOrder) => {
  const type = order.type ?? "limit";
  return [ORDER_TYPE_LABELS[type] ?? capitalized(type), order.pairId ? "TP/SL pair" : order.reduceOnly ? "Reduce only" : null].filter(Boolean).join(" · ");
};

/** One order on phones: what it does, its prices, its state and a cancel button. */
function OrderCard({ order, account, paired }: { order: RestingOrder; account: AccountState | null; paired: boolean }) {
  const trading = useTrading(), trader = useTrader();
  const link = order.transactionHash ? txUrl(trader.chain.id, order.transactionHash) : undefined;
  const trigger = order.triggerPrice ? BigInt(order.triggerPrice) : null;
  return <article className="rfq-pos">
    <div className="rfq-pos__head">
      <AssetIcon market={order.market} small />
      <span><span className="headline">{order.side === "buy" ? "Buy" : "Sell"} {order.market}</span><div className="caption rfq-faint">{orderKind(order)}</div></span>
      <span className="rfq-pos__pnl"><span className={`rfq-badge${STATUS_BADGE[order.status] ?? ""}`}>{capitalized(sentence(order.status))}</span></span>
    </div>
    <div className="rfq-pos__grid">
      <div><span>Size</span><b>{order.sizing === "position" ? "Position" : usdc(parseUsdcInput(order.amount))}</b></div>
      <div><span>{trigger === null ? "Limit" : "Trigger"}</span><b>{trigger === null ? usdc(order.limitPrice) : `${order.triggerAbove ? "≥" : "≤"} ${usdc(trigger)}`}</b></div>
      <div><span>{trigger === null ? "Expires" : "Fills"}</span><b>{trigger === null ? expiry(order.expiresAtMs) : `${order.side === "buy" ? "≤" : "≥"} ${usdc(order.limitPrice)}`}</b></div>
    </div>
    {liveOrder(order) && trigger !== null && <TriggerPnl order={order} account={account} />}
    {order.lastError && order.status !== "filled" && <p className="caption rfq-faint">{capitalized(order.lastError)}</p>}
    {link && <a className="caption" href={link} target="_blank" rel="noreferrer">View transaction</a>}
    {liveOrder(order) && <button type="button" className="rfq-btn rfq-btn--secondary" disabled={trading.busy !== null} onClick={() => trading.cancelOrder(order)}>{paired ? "Cancel TP and SL" : "Cancel order"}</button>}
  </article>;
}

/** Open orders first, then the rest, newest first: limit, stop and TP/SL orders. */
function Orders({ orders, account }: { orders: RestingOrder[]; account: AccountState | null }) {
  const trading = useTrading(), trader = useTrader(), desktop = useDesktop();
  if (!orders.length) return <EmptyState icon={NavIcons.markets}>Limit, stop and TP/SL orders you place show up here.</EmptyState>;
  const sorted = [...orders].sort((a, b) => Number(liveOrder(b)) - Number(liveOrder(a)));
  if (!desktop) return <div className="positions__cards">{sorted.slice(0, 20).map(order => <OrderCard key={order.orderId} order={order} account={account} paired={!!pairedOrder(order, orders)} />)}</div>;
  const live = liveOrder;
  return <div className="rfq-table-wrap"><table className="rfq-table">
    <thead><tr><th>Order</th><th>Size</th><th>Price</th><th>Expires</th><th>Status</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
    <tbody>{sorted.slice(0, 20).map(order => {
      const link = order.transactionHash ? txUrl(trader.chain.id, order.transactionHash) : undefined;
      const type = order.type ?? "limit", trigger = order.triggerPrice ? BigInt(order.triggerPrice) : null;
      return <tr key={order.orderId}>
        <td><span className={order.side === "buy" ? "rfq-up" : "rfq-down"}>{order.side === "buy" ? "Buy" : "Sell"}</span> {order.market}
          <div className="caption rfq-faint">{orderKind(order)}</div></td>
        <td>{order.sizing === "position" ? "Whole position" : usdc(parseUsdcInput(order.amount))}<div className="caption rfq-faint">{baseAmount(abs(BigInt(order.baseDelta)))} {order.market}</div></td>
        <td>{trigger === null ? usdc(order.limitPrice) : <>{order.triggerAbove ? "≥" : "≤"} {usdc(trigger)}
          <div className="caption rfq-faint">Fills {order.side === "buy" ? "≤" : "≥"} {usdc(order.limitPrice)}</div>{live(order) && <TriggerPnl order={order} account={account} />}</>}</td>
        <td>{expiry(order.expiresAtMs)}</td>
        <td><span className={`rfq-badge${STATUS_BADGE[order.status] ?? ""}`}>{capitalized(sentence(order.status))}</span>{link && <> <a href={link} target="_blank" rel="noreferrer">View</a></>}
          {order.lastError && order.status !== "filled" && <div className="caption rfq-faint order-note">{capitalized(order.lastError)}</div>}</td>
        <td>{live(order) && <button type="button" className="rfq-btn rfq-btn--sm rfq-btn--secondary" disabled={trading.busy !== null} title={pairedOrder(order, orders) ? "Cancels both the take-profit and the stop-loss" : undefined} onClick={() => trading.cancelOrder(order)}>Cancel</button>}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}
