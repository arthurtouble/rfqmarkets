import { useState } from "react";
import { useTrading } from "../data/actions.js";
import { useMarketFeed } from "../data/market-feed.js";
import { useAccountActivity, useOrders, useProtocol } from "../data/queries.js";
import { hasPosition } from "../lib/account.js";
import { txUrl } from "../lib/explorer.js";
import { abs, baseAmount, clockTime, parseUsdcInput, sentence, signedUsdc, usdc } from "../lib/format.js";
import { useMarketList } from "../data/markets.js";
import { type AccountState, type Activity, type Market, type RestingOrder } from "../lib/types.js";
import { AssetIcon, Banner, Change, EmptyState, NavIcons, Rows, Segmented, Sheet, Tabs } from "../ui/primitives.js";
import { useAdvanced, useDesktop } from "../ui/prefs.js";
import { useTrader } from "../wallet/trader.js";
import { WalletMenu } from "../wallet/WalletMenu.js";
import { useFunds } from "./FundsDialog.js";

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

export function PositionCard({ account, market, onClose }: { account: AccountState; market: Market; onClose: (market: Market) => void }) {
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
    {distance !== null && distance < 0.1 && <Banner tone="danger"><b>Close to liquidation.</b> {market} is {(distance * 100).toFixed(1)}% away. Add funds or reduce the position.</Banner>}
    <div className="rfq-pos__actions single"><button type="button" className="rfq-btn rfq-btn--secondary" onClick={() => onClose(market)}>Close</button></div>
  </article>;
}

function PositionsTable({ account, markets, onClose }: { account: AccountState; markets: Market[]; onClose: (market: Market) => void }) {
  const advanced = useAdvanced();
  return <div className="rfq-table-wrap"><table className="rfq-table">
    <thead><tr><th>Market</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th><th>Liq. price</th>{advanced && <th>Funding</th>}<th>PnL</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
    <tbody>{markets.map(market => {
      const position = account.positions[market], size = BigInt(position.size), pnl = BigInt(position.unrealizedPnl);
      return <tr key={market}>
        <td><span className="cell-market"><AssetIcon market={market} small />{market}</span></td>
        <td><span className={`rfq-badge rfq-badge--${size > 0n ? "long" : "short"}`}>{size > 0n ? "Long" : "Short"}</span></td>
        <td>{usdc(abs(BigInt(position.notional)))}<div className="caption rfq-faint">{baseAmount(abs(size))} {market}</div></td>
        <td>{usdc(position.entryPrice)}</td>
        <td>{usdc(position.markPrice)}</td>
        <td>{usdc(position.estimatedLiquidationPrice)}</td>
        {advanced && <td>{signedUsdc(position.accruedFunding)}</td>}
        <td><Change value={pnl}>{signedUsdc(pnl)}</Change></td>
        <td><button type="button" className="rfq-btn rfq-btn--sm rfq-btn--secondary" onClick={() => onClose(market)}>Close</button></td>
      </tr>;
    })}</tbody>
  </table></div>;
}

/** Open positions as cards on phones and a table on desktop, plus the close sheet. */
export function Positions({ account, only }: { account: AccountState | null; only?: Market }) {
  const desktop = useDesktop();
  const [closing, setClosing] = useState<Market | null>(null);
  const open = account ? Object.keys(account.positions).filter(market => hasPosition(account, market) && (!only || market === only)) : [];
  if (!account || !open.length) return null;
  return <>
    {desktop && !only ? <PositionsTable account={account} markets={open} onClose={setClosing} />
      : <div className="stack">{open.map(market => <PositionCard key={market} account={account} market={market} onClose={setClosing} />)}</div>}
    {closing && <ClosePositionSheet account={account} market={closing} onClose={() => setClosing(null)} />}
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
        : tab === "orders" ? <Orders orders={orders.data ?? []} />
        : <History items={activity.data ?? []} />}
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

