import { useState } from "react";
import { useTrading } from "../data/actions.js";
import { useMarketFeed } from "../data/market-feed.js";
import { useAccountActivity, useOrders, useProtocol } from "../data/queries.js";
import { hasPosition } from "../lib/account.js";
import { pairedOrder } from "../lib/orders.js";
import { txUrl } from "../lib/explorer.js";
import { abs, baseAmount, clockTime, parseUsdcInput, sentence, signedUsdc, usdc } from "../lib/format.js";
import { useMarketList } from "../data/markets.js";
import { type AccountState, type Activity, type Market, type RestingOrder } from "../lib/types.js";
import { AssetIcon, Banner, Change, EmptyState, NavIcons, Rows, Segmented, Sheet, Tabs } from "../ui/primitives.js";
import { useAdvanced, useDesktop } from "../ui/prefs.js";
import { useTrader } from "../wallet/trader.js";
import { WalletMenu } from "../wallet/WalletMenu.js";
import { useFunds } from "./FundsDialog.js";
import { ORDER_TYPE_LABELS, ProtectionSummary, TpslSheet, TriggerPnl } from "./TriggerOrders.js";

const pct = (numerator: bigint, denominator: bigint) => denominator ? `${(Number(numerator * 10_000n / denominator) / 100).toFixed(2)}%` : "";

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

/** Distance from the mark price to the estimated liquidation price, as a fraction. */
function liquidationDistance(account: AccountState, market: Market) {
  const position = account.positions[market];
  if (!position.estimatedLiquidationPrice) return null;
  const mark = Number(position.markPrice), liq = Number(position.estimatedLiquidationPrice);
  return mark ? Math.abs(mark - liq) / mark : null;
}

type PositionActions = { onClose: (market: Market) => void; onTpsl: (market: Market) => void };

export function PositionCard({ account, market, onClose, onTpsl }: { account: AccountState; market: Market } & PositionActions) {
  const position = account.positions[market], size = BigInt(position.size), pnl = BigInt(position.unrealizedPnl);
  const margin = abs(BigInt(position.notional));
  const distance = liquidationDistance(account, market);
  return <article className="rfq-pos">
    <div className="rfq-pos__head">
      <AssetIcon market={market} small /><span className="headline">{market}</span>
      <span className={`rfq-badge rfq-badge--${size > 0n ? "long" : "short"}`}>{size > 0n ? "Long" : "Short"}</span>
      <span className="rfq-pos__pnl"><div className="num"><Change value={pnl}>{signedUsdc(pnl)}</Change></div><div className={`caption ${pnl > 0n ? "rfq-up" : pnl < 0n ? "rfq-down" : "rfq-faint"}`}>{pct(pnl, margin)}</div></span>
    </div>
    <div className="rfq-pos__grid">
      <div><span>Size</span><b>{usdc(margin)}</b></div>
      <div><span>Entry</span><b>{usdc(position.entryPrice)}</b></div>
      <div><span>Liq. price</span><b>{usdc(position.estimatedLiquidationPrice)}</b></div>
    </div>
    <div className="rfq-pos__tpsl"><span>TP/SL</span><ProtectionSummary market={market} size={size} /></div>
    {distance !== null && distance < 0.1 && <Banner tone="danger"><b>Close to liquidation.</b> {market} is {(distance * 100).toFixed(1)}% away. Add funds or reduce the position.</Banner>}
    <div className="rfq-pos__actions">
      <button type="button" className="rfq-btn rfq-btn--secondary" onClick={() => onTpsl(market)}>TP/SL</button>
      <button type="button" className="rfq-btn rfq-btn--secondary" onClick={() => onClose(market)}>Close</button>
    </div>
  </article>;
}

function PositionsTable({ account, markets, onClose, onTpsl }: { account: AccountState; markets: Market[] } & PositionActions) {
  const advanced = useAdvanced();
  return <div className="rfq-table-wrap"><table className="rfq-table">
    <thead><tr><th>Market</th><th>Size</th><th>Entry / mark</th><th>Liq. price</th>{advanced && <th>Funding</th>}<th>PnL</th><th>TP/SL</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
    <tbody>{markets.map(market => {
      const position = account.positions[market], size = BigInt(position.size), pnl = BigInt(position.unrealizedPnl);
      return <tr key={market}>
        <td><span className="cell-market"><AssetIcon market={market} small />{market}<span className={`rfq-badge rfq-badge--${size > 0n ? "long" : "short"}`}>{size > 0n ? "Long" : "Short"}</span></span></td>
        <td>{usdc(abs(BigInt(position.notional)))}<div className="caption rfq-faint">{baseAmount(abs(size))} {market}</div></td>
        <td>{usdc(position.entryPrice)}<div className="caption rfq-faint">{usdc(position.markPrice)}</div></td>
        <td>{usdc(position.estimatedLiquidationPrice)}</td>
        {advanced && <td>{signedUsdc(position.accruedFunding)}</td>}
        <td><Change value={pnl}>{signedUsdc(pnl)}</Change></td>
        <td><button type="button" className="tpsl-cell" aria-label={`Edit ${market} take-profit and stop-loss`} onClick={() => onTpsl(market)}><ProtectionSummary market={market} size={size} empty="Add" /></button></td>
        <td><button type="button" className="rfq-btn rfq-btn--sm rfq-btn--secondary" onClick={() => onClose(market)}>Close</button></td>
      </tr>;
    })}</tbody>
  </table></div>;
}

/** Open positions as cards on phones and a table on desktop, plus the close sheet. */
export function Positions({ account, only }: { account: AccountState | null; only?: Market }) {
  const desktop = useDesktop();
  const [closing, setClosing] = useState<Market | null>(null);
  const [protecting, setProtecting] = useState<Market | null>(null);
  const open = account ? Object.keys(account.positions).filter(market => hasPosition(account, market) && (!only || market === only)) : [];
  if (!account || !open.length) return null;
  return <>
    {desktop && !only ? <PositionsTable account={account} markets={open} onClose={setClosing} onTpsl={setProtecting} />
      : <div className="stack">{open.map(market => <PositionCard key={market} account={account} market={market} onClose={setClosing} onTpsl={setProtecting} />)}</div>}
    {closing && <ClosePositionSheet account={account} market={closing} onClose={() => setClosing(null)} />}
    {protecting && hasPosition(account, protecting) && <TpslSheet account={account} market={protecting} onClose={() => setProtecting(null)} />}
  </>;
}

const CLOSE_STEPS = [25, 50, 75, 100] as const;

export function ClosePositionSheet({ account, market, onClose }: { account: AccountState; market: Market; onClose: () => void }) {
  const trading = useTrading(), protocol = useProtocol(), { snapshot } = useMarketFeed();
  const paused = protocol.data?.paused ?? false;
  const [step, setStep] = useState<(typeof CLOSE_STEPS)[number]>(100);
  const position = account.positions[market], size = BigInt(position.size), long = size > 0n;
  const share = paused ? 100n : BigInt(step);
  const notional = abs(BigInt(position.notional)) * share / 100n;
  const pnl = BigInt(position.unrealizedPnl) * share / 100n;
  const live = snapshot?.markets[market];
  const busy = trading.busy !== null;
  const word = long ? "long" : "short";
  const close = async () => {
    if (paused) await trading.emergencyClose(market);
    else if (step === 100) await trading.closePosition(market);
    else await trading.closePosition(market, step * 100);
    onClose();
  };
  return <Sheet open onClose={onClose} title={`Close ${market} ${word}`} labelledBy="close-title">
    <div className="sheet-body">
      {paused ? <Banner tone="warning"><b>Trading is paused.</b> You can still close the whole position at the oracle price.</Banner>
        : <Segmented label="Amount to close" value={String(step) as `${(typeof CLOSE_STEPS)[number]}`} onChange={value => setStep(Number(value) as (typeof CLOSE_STEPS)[number])}
            options={CLOSE_STEPS.map(value => ({ id: String(value) as `${(typeof CLOSE_STEPS)[number]}`, label: `${value}%` }))} />}
      <Rows rows={[
        ["Closing", `${baseAmount(abs(size) * share / 100n)} ${market} · ${usdc(notional)}`],
        ["Estimated price", usdc(paused ? live?.mid : long ? live?.bid : live?.ask)],
        ["Estimated PnL", <Change key="pnl" value={pnl}>{signedUsdc(pnl)}</Change>, "is-total"],
      ]} />
      <button type="button" className="rfq-btn rfq-btn--lg rfq-btn--primary rfq-btn--block" disabled={busy} onClick={close}>
        {busy ? <><span className="rfq-spinner" />Confirm in your wallet</> : paused ? `Close ${market} at oracle price` : step === 100 ? `Close ${market} ${word}` : `Close ${step}% of ${market} ${word}`}
      </button>
    </div>
  </Sheet>;
}

type Tab = "positions" | "orders" | "history";

/** Positions, orders and history under the chart (desktop) and on Portfolio. */
export function ActivityTabs({ account }: { account: AccountState | null }) {
  const trader = useTrader();
  const orders = useOrders(trader.address), activity = useAccountActivity(trader.address);
  const [tab, setTab] = useState<Tab>("positions");
  const openOrders = orders.data?.filter(order => order.status === "open" || order.status === "executing") ?? [];
  const positionCount = account ? Object.keys(account.positions).filter(market => hasPosition(account, market)).length : 0;
  return <section className="rfq-card activity">
    <div className="activity-tabs"><Tabs label="Account activity" value={tab} onChange={setTab} tabs={[
      { id: "positions", label: "Positions", count: positionCount },
      { id: "orders", label: "Orders", count: openOrders.length },
      { id: "history", label: "History" },
    ]} /></div>
    <div className="activity-body">
      {!trader.address ? <EmptyState icon={NavIcons.portfolio} action={<WalletMenu />}>Connect to see your positions, orders and history.</EmptyState>
        : tab === "positions" ? (positionCount ? <Positions account={account} /> : <EmptyState>Your open trades show up here.</EmptyState>)
        : tab === "orders" ? (orders.isError && !orders.data ? <EmptyState icon={NavIcons.markets}>We can't load your orders right now. They are still active and will show here once the connection is back.</EmptyState>
          : <Orders orders={orders.data ?? []} account={account} />)
        : <History items={activity.data ?? []} />}
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
  if (!desktop) return <div className="stack">{sorted.slice(0, 20).map(order => <OrderCard key={order.orderId} order={order} account={account} paired={!!pairedOrder(order, orders)} />)}</div>;
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

const EVENT_NAMES: Record<string, string> = {
  TradeExecuted: "Trade", Deposited: "Deposit", Withdrawn: "Withdrawal", SessionGranted: "One-click trading on",
  SessionRevoked: "One-click trading off", Liquidated: "Liquidation", NonceCancelled: "Order cancelled",
};

function History({ items }: { items: Activity[] }) {
  const { chain } = useTrader();
  const { marketFromIndex } = useMarketList();
  if (!items.length) return <EmptyState icon={NavIcons.markets}>Your trades, deposits and withdrawals show up here.</EmptyState>;
  return <div className="rfq-table-wrap"><table className="rfq-table">
    <thead><tr><th>Time</th><th>Activity</th><th>Size</th><th>Price</th><th>Fee</th></tr></thead>
    <tbody>{items.map(item => {
      const market = marketFromIndex(item.market), link = txUrl(chain.id, item.tx_hash);
      const delta = item.payload.baseDelta ? BigInt(item.payload.baseDelta) : null;
      const what = item.kind === "TradeExecuted" && delta !== null ? <><span className={delta > 0n ? "rfq-up" : "rfq-down"}>{delta > 0n ? "Long" : "Short"}</span> {market}</> : `${EVENT_NAMES[item.kind] ?? sentence(item.kind)}${market ? ` · ${market}` : ""}`;
      return <tr key={`${item.tx_hash}:${item.log_index}`}>
        <td>{link ? <a href={link} target="_blank" rel="noreferrer">{clockTime(item.timestamp * 1_000)}</a> : clockTime(item.timestamp * 1_000)}</td>
        <td>{what}</td>
        <td>{delta !== null ? `${baseAmount(abs(delta))} ${market}` : item.payload.amount ? usdc(item.payload.amount) : "—"}</td>
        <td>{item.payload.price ? usdc(item.payload.price) : "—"}</td>
        <td>{item.payload.fee ? usdc(item.payload.fee) : "—"}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}

