import { useState } from "react";
import { useTrading } from "../data/actions.js";
import { useAccountActivity, useOrders, useProtocol } from "../data/queries.js";
import { hasPosition } from "../lib/account.js";
import { txUrl } from "../lib/explorer.js";
import { abs, baseAmount, bpsLeverage, bpsPercent, clockTime, parseUsdcInput, sentence, signedUsdc, usdc } from "../lib/format.js";
import { MARKETS, marketFromIndex, type AccountState, type Activity, type RestingOrder } from "../lib/types.js";
import { QUICK_LIMITS } from "../wallet/quick-session.js";
import { useTrader } from "../wallet/trader.js";
import { Empty, Stat, Tabs, toneOf } from "../ui/primitives.js";
import { FundsDialog, type FundsMode } from "./FundsDialog.js";

/** Equity, margin and the funds and quick-trading controls. */
export function AccountSummary({ account }: { account: AccountState | null }) {
  const trader = useTrader();
  const [funds, setFunds] = useState<FundsMode | null>(null);
  if (!trader.address || !account) return <article className="panel account-summary">
    <h2>Account</h2><Empty>Connect a wallet to see your collateral, margin and positions.</Empty>
  </article>;
  return <article className={`panel account-summary ${account.liquidatable ? "danger" : ""}`}>
    <header><h2>Account</h2>{account.liquidatable && <span className="pill negative">Liquidatable</span>}</header>
    <div className="equity"><small>Equity</small><strong className="mono">{usdc(account.equity)}</strong>
      <span><b className={toneOf(account.unrealizedPnl)}>{signedUsdc(account.unrealizedPnl)}</b> unrealized · <b className={toneOf(account.accruedFunding)}>{signedUsdc(account.accruedFunding)}</b> funding</span></div>
    <div className="stat-grid">
      <Stat label="Collateral">{usdc(account.collateral)}</Stat>
      <Stat label="Available margin" tone={BigInt(account.availableMargin) < 0n ? "negative" : ""}>{usdc(account.availableMargin)}</Stat>
      <Stat label="Margin usage">{bpsPercent(account.marginRatioBps)}</Stat>
      <Stat label="Leverage">{bpsLeverage(account.effectiveLeverageBps)}</Stat>
      <Stat label="Maintenance margin">{usdc(account.maintenanceMargin)}</Stat>
      <Stat label="Liquidation buffer" tone={BigInt(account.maintenanceBuffer) < 0n ? "negative" : ""}>{usdc(account.maintenanceBuffer)}</Stat>
    </div>
    <div className="button-row">
      <button type="button" className="secondary" onClick={() => setFunds("deposit")}>Deposit</button>
      <button type="button" className="secondary" onClick={() => setFunds("withdraw")}>Withdraw</button>
    </div>
    <QuickTradingRow />
    <FundsDialog mode={funds} onMode={setFunds} onClose={() => setFunds(null)} account={account} />
  </article>;
}

function QuickTradingRow() {
  const trading = useTrading(), session = trading.quickSession, busy = trading.busy !== null;
  const until = session && new Date(session.validUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const detail = !session ? `Sign trades up to ${QUICK_LIMITS.maxTradeAmount} USDC without a wallet prompt`
    : session.privateKey ? `On until ${until} · up to ${QUICK_LIMITS.maxTradeAmount} USDC per trade`
    : `Reloading cleared this tab's session key. The grant stays valid until ${until}; revoke it or enable a new one.`;
  return <div className="quick-row">
    <span><b>Quick trading</b><small>{detail}</small></span>
    <span className="quick-actions">
      {session && <button type="button" className="link" disabled={busy} onClick={trading.revokeQuickTrading}>Revoke</button>}
      {!session?.privateKey && <button type="button" className="link" disabled={busy} onClick={trading.enableQuickTrading}>Enable</button>}
    </span>
  </div>;
}

type Tab = "positions" | "orders" | "trades" | "history";

export function AccountTabs({ account }: { account: AccountState | null }) {
  const trader = useTrader();
  const orders = useOrders(trader.address), activity = useAccountActivity(trader.address);
  const [tab, setTab] = useState<Tab>("positions");
  const openOrders = orders.data?.filter(order => order.status === "open" || order.status === "executing") ?? [];
  const trades = activity.data?.filter(item => item.kind === "TradeExecuted") ?? [];
  const positionCount = account ? MARKETS.filter(market => hasPosition(account, market)).length : 0;
  return <section className="panel account-tabs">
    <Tabs label="Account data" value={tab} onChange={setTab} tabs={[
      { id: "positions", label: <>Positions <em>{positionCount}</em></> },
      { id: "orders", label: <>Orders <em>{openOrders.length}</em></> },
      { id: "trades", label: "Trades" },
      { id: "history", label: "History" },
    ]} />
    {!trader.address ? <Empty>Connect a wallet to see positions, orders and history.</Empty>
      : tab === "positions" ? <Positions account={account} />
      : tab === "orders" ? <Orders orders={orders.data ?? []} />
      : tab === "trades" ? <Trades items={trades} />
      : <History items={activity.data ?? []} />}
  </section>;
}

function Positions({ account }: { account: AccountState | null }) {
  const trading = useTrading(), protocol = useProtocol();
  const paused = protocol.data?.paused ?? false;
  const open = account ? MARKETS.filter(market => hasPosition(account, market)) : [];
  if (!account || !open.length) return <Empty>No open positions.</Empty>;
  return <>
    {paused && <p className="notice warn">Trading is paused. You can still close at the verified directional oracle price.</p>}
    <div className="table-wrap"><table>
      <thead><tr><th>Market</th><th>Size</th><th>Entry</th><th>Mark</th><th>Notional</th><th>uPnL</th><th>Funding</th><th>Est. liq.</th><th /></tr></thead>
      <tbody>{open.map(market => {
        const position = account.positions[market], size = BigInt(position.size);
        return <tr key={market}>
          <td><b>{market}-PERP</b></td>
          <td className={size > 0n ? "positive" : "negative"}>{size > 0n ? "Long" : "Short"} {baseAmount(abs(size))}</td>
          <td className="mono">{usdc(position.entryPrice)}</td>
          <td className="mono">{usdc(position.markPrice)}</td>
          <td className="mono">{usdc(position.notional)}</td>
          <td className={`mono ${toneOf(position.unrealizedPnl)}`}>{signedUsdc(position.unrealizedPnl)}</td>
          <td className={`mono ${toneOf(position.accruedFunding)}`}>{signedUsdc(position.accruedFunding)}</td>
          <td className="mono">{usdc(position.estimatedLiquidationPrice)}</td>
          <td className="actions">{paused
            ? <button type="button" className="small" disabled={trading.busy !== null} onClick={() => trading.emergencyClose(market)}>Close at oracle</button>
            : <button type="button" className="small" disabled={trading.busy !== null} onClick={() => trading.closePosition(market)}>Close</button>}</td>
        </tr>;
      })}</tbody>
    </table></div>
  </>;
}

function Orders({ orders }: { orders: RestingOrder[] }) {
  const trading = useTrading(), trader = useTrader();
  if (!orders.length) return <Empty>No orders for this account.</Empty>;
  return <div className="table-wrap"><table>
    <thead><tr><th>Order</th><th>Size</th><th>Limit</th><th>Max fee</th><th>Expires</th><th>Status</th><th /></tr></thead>
    <tbody>{orders.slice(0, 20).map(order => {
      const link = order.transactionHash ? txUrl(trader.chain.id, order.transactionHash) : undefined;
      return <tr key={order.orderId}>
        <td className={order.side === "buy" ? "positive" : "negative"}>{order.side === "buy" ? "Buy" : "Sell"} {order.market}</td>
        <td className="mono">{usdc(parseUsdcInput(order.amount))}</td>
        <td className="mono">{usdc(order.limitPrice)}</td>
        <td className="mono">{usdc(order.maxFee)}</td>
        <td>{new Date(order.expiresAtMs).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
        <td><span className={`pill ${order.status}`} title={order.lastError}>{order.status}</span>{link && <a className="tx" href={link} target="_blank" rel="noreferrer">tx</a>}</td>
        <td className="actions">{(order.status === "open" || order.status === "executing") && <button type="button" className="small" disabled={trading.busy !== null} onClick={() => trading.cancelOrder(order)}>Cancel</button>}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}

function Trades({ items }: { items: Activity[] }) {
  const { chain } = useTrader();
  if (!items.length) return <Empty>No trades for this account.</Empty>;
  return <div className="table-wrap"><table>
    <thead><tr><th>Time</th><th>Trade</th><th>Size</th><th>Price</th><th>Fee</th><th>Status</th></tr></thead>
    <tbody>{items.map(item => {
      const delta = BigInt(item.payload.baseDelta ?? "0"), market = marketFromIndex(item.market), link = txUrl(chain.id, item.tx_hash);
      return <tr key={`${item.tx_hash}:${item.log_index}`}>
        <td>{clockTime(item.timestamp * 1_000)}</td>
        <td className={delta > 0n ? "positive" : "negative"}>{delta > 0n ? "Buy" : "Sell"} {market}</td>
        <td className="mono">{baseAmount(abs(delta))} {market}</td>
        <td className="mono">{usdc(item.payload.price)}</td>
        <td className="mono">{usdc(item.payload.fee)}</td>
        <td>{link ? <a href={link} target="_blank" rel="noreferrer">{item.finality}</a> : item.finality}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}

function History({ items }: { items: Activity[] }) {
  const { chain } = useTrader();
  if (!items.length) return <Empty>No account activity yet.</Empty>;
  return <div className="table-wrap"><table>
    <thead><tr><th>Time</th><th>Event</th><th>Market</th><th>Block</th></tr></thead>
    <tbody>{items.map(item => {
      const link = txUrl(chain.id, item.tx_hash);
      return <tr key={`${item.tx_hash}:${item.log_index}`}>
        <td>{clockTime(item.timestamp * 1_000)}</td>
        <td>{sentence(item.kind)}</td>
        <td>{marketFromIndex(item.market) ?? "—"}</td>
        <td className="mono">{link ? <a href={link} target="_blank" rel="noreferrer">{item.block_number}</a> : item.block_number}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}
