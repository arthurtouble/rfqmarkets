// Take-profit / stop-loss for an open position, the TP/SL summary shown on
// positions, and the trigger price field of the ticket's stop order.
import { useEffect, useRef, useState } from "react";
import { useTrading } from "../data/actions.js";
import { useMarketFeed } from "../data/market-feed.js";
import { useOpenOrders, useOrders } from "../data/queries.js";
import { abs, baseAmount, microToInput, parseUsdcInput, signedUsdc, usdc } from "../lib/format.js";
import { coversLessThan, offsetPrice, pnlAtPrice, positionProtection, stopPastLiquidation, tpslProblem, triggerProblem } from "../lib/orders.js";
import { DEFAULT_TRIGGER_SLIPPAGE_BPS } from "../lib/slippage.js";
import type { AccountState, Market, RestingOrder, Side } from "../lib/types.js";
import { Banner, Change, Rows, Segmented, Sheet } from "../ui/primitives.js";
import { useAdvanced } from "../ui/prefs.js";
import { useToasts } from "../ui/toasts.js";
import { useTrader } from "../wallet/trader.js";

const DECIMAL_DRAFT = /^\d*\.?\d*$/;
const PRESETS = [1, 2, 5, 10] as const;
const SLIPPAGE_OPTIONS = ["50", "100", "200", "500"] as const;
type SlippageOption = (typeof SLIPPAGE_OPTIONS)[number];

/** The open TP/SL protecting `market` for the connected wallet. */
export function useProtection(market: Market) {
  const trader = useTrader();
  const orders = useOpenOrders(trader.address, market);
  return { orders: orders.data ?? [], ...positionProtection(orders.data ?? [], market) };
}

/** "TP $105,000 · SL $95,000", or `empty` when neither is set. */
export function ProtectionSummary({ market, size, empty = "—" }: { market: Market; size: bigint; empty?: string }) {
  const { takeProfit, stopLoss } = useProtection(market);
  if (!takeProfit && !stopLoss) return <span className="rfq-faint">{empty}</span>;
  const partial = [takeProfit, stopLoss].some(order => order && coversLessThan(order, size));
  return <span className="tpsl-summary">
    {takeProfit && <span><span className="rfq-faint">TP</span> {usdc(takeProfit.triggerPrice)}</span>}
    {stopLoss && <span><span className="rfq-faint">SL</span> {usdc(stopLoss.triggerPrice)}</span>}
    {partial && <span className="rfq-badge rfq-badge--warning" title="Signed for a smaller position. Replace it to cover the whole position.">Partial</span>}
  </span>;
}

function PriceField({ id, label, value, onChange, presets, hint, tone }: {
  id: string; label: string; value: string; onChange: (value: string) => void;
  presets: Array<{ label: string; value: bigint }>; hint: string; tone?: "up" | "down";
}) {
  return <div className="rfq-field">
    <label htmlFor={id}>{label}</label>
    <div className="rfq-field__box">
      <input id={id} inputMode="decimal" placeholder="Not set" autoComplete="off" value={value} onChange={event => DECIMAL_DRAFT.test(event.target.value) && onChange(event.target.value)} />
      <span>USD</span>
    </div>
    <div className="rfq-chips" aria-label={`${label} presets`}>
      {presets.map(preset => <button key={preset.label} type="button" className="rfq-chip" aria-pressed={parseUsdcInput(value) === preset.value} onClick={() => onChange(microToInput(preset.value))}>{preset.label}</button>)}
      {value && <button type="button" className="rfq-chip" onClick={() => onChange("")}>Clear</button>}
    </div>
    <span className={`rfq-field__hint${tone ? ` is-${tone}` : ""}`}>{hint}</span>
  </div>;
}

/**
 * Set, replace or remove the take-profit and stop-loss of one position. Both legs close the whole
 * position and share a nonce, so the first to fill cancels the other. Replacing places the new pair
 * first and then cancels the old one, so the position is never left unprotected.
 */
export function TpslSheet({ account, market, onClose }: { account: AccountState; market: Market; onClose: () => void }) {
  const trading = useTrading(), advanced = useAdvanced(), { snapshot } = useMarketFeed();
  const { takeProfit: currentTp, stopLoss: currentSl, orders } = useProtection(market);
  const position = account.positions[market], size = BigInt(position.size), long = size > 0n;
  const entry = BigInt(position.entryPrice);
  const mid = snapshot?.markets[market] ? BigInt(snapshot.markets[market].mid) : BigInt(position.markPrice);
  const liquidation = position.estimatedLiquidationPrice ? BigInt(position.estimatedLiquidationPrice) : null;
  const [tp, setTp] = useState(currentTp?.triggerPrice ? microToInput(BigInt(currentTp.triggerPrice)) : "");
  const [sl, setSl] = useState(currentSl?.triggerPrice ? microToInput(BigInt(currentSl.triggerPrice)) : "");
  const [slippage, setSlippage] = useState<SlippageOption>(String(DEFAULT_TRIGGER_SLIPPAGE_BPS) as SlippageOption);
  const tpMicro = tp ? parseUsdcInput(tp) : undefined, slMicro = sl ? parseUsdcInput(sl) : undefined;
  const existing = [...new Map([currentTp, currentSl].filter((order): order is RestingOrder => !!order).map(order => [order.pairId ?? order.orderId, order])).values()];
  const partial = existing.some(order => coversLessThan(order, size));
  const unchanged = existing.length > 0 && !partial && (currentTp?.triggerPrice ?? null) === (tpMicro?.toString() ?? null) && (currentSl?.triggerPrice ?? null) === (slMicro?.toString() ?? null);
  const busy = trading.busy !== null;

  const problem = tpMicro === null ? "Enter a valid take-profit price"
    : slMicro === null ? "Enter a valid stop-loss price"
    : tpMicro === undefined && slMicro === undefined ? (existing.length ? null : "Set a take-profit or a stop-loss price")
    : unchanged ? "No changes"
    : tpslProblem(size, mid, tpMicro, slMicro);
  const removing = tpMicro === undefined && slMicro === undefined && existing.length > 0;
  const pastLiquidation = slMicro ? stopPastLiquidation(size, slMicro, liquidation) : false;

  const pnlHint = (price: bigint | null | undefined, fallback: string) =>
    price ? `Estimated PnL ${signedUsdc(pnlAtPrice(size, entry, price))}` : fallback;
  const presets = (up: boolean) => PRESETS.map(percent => ({ label: `${up ? "+" : "−"}${percent}%`, value: offsetPrice(mid, percent, up) }));

  const cancelExisting = async () => { for (const order of existing) await trading.cancelOrder(order); };
  const submit = async () => {
    if (removing) { await cancelExisting(); onClose(); return; }
    const placed = await trading.placeTpsl({
      market, takeProfitMicro: tpMicro ?? undefined, stopLossMicro: slMicro ?? undefined,
      slippageBps: Number(slippage),
    });
    if (!placed) return;
    await cancelExisting();
    onClose();
  };

  const word = long ? "long" : "short";
  const action = removing ? "Remove TP/SL" : existing.length ? "Replace TP/SL" : "Set TP/SL";
  return <Sheet open onClose={onClose} title={`TP/SL for ${market} ${word}`} labelledBy="tpsl-title">
    <div className="sheet-body">
      <Rows rows={[
        ["Position", `${baseAmount(abs(size))} ${market} · ${usdc(abs(BigInt(position.notional)))}`],
        ["Entry price", usdc(entry)],
        ["Current price", usdc(mid)],
        ["Liq. price", usdc(liquidation)],
      ]} />
      <PriceField id="tpsl-tp" label="Take-profit price" value={tp} onChange={setTp} presets={presets(long)}
        hint={pnlHint(tpMicro, `Closes the position when the price ${long ? "rises" : "falls"} to this level`)} tone={tpMicro ? "up" : undefined} />
      <PriceField id="tpsl-sl" label="Stop-loss price" value={sl} onChange={setSl} presets={presets(!long)}
        hint={pnlHint(slMicro, `Closes the position when the price ${long ? "falls" : "rises"} to this level`)} tone={slMicro ? "down" : undefined} />
      {advanced && <div className="rfq-field">
        <span className="rfq-field__label" id="tpsl-slippage">Max slippage past the trigger</span>
        <Segmented label="Max slippage past the trigger" value={slippage} onChange={setSlippage}
          options={SLIPPAGE_OPTIONS.map(id => ({ id, label: `${Number(id) / 100}%` }))} />
      </div>}
      <p className="footnote rfq-faint">
        Triggers on the oracle mid price and fills within {Number(slippage) / 100}% of your trigger. If the price jumps past that, the order waits for it to come back. Whichever fills first cancels the other.
      </p>
      {pastLiquidation && <Banner tone="warning">This stop-loss is past your estimated liquidation price, so the position would be liquidated first.</Banner>}
      {partial && !removing && <Banner tone="warning">Your current TP/SL was set for a smaller position. Replace it to cover all {baseAmount(abs(size))} {market}.</Banner>}
      {existing.length > 0 && <p className="footnote rfq-faint">Replacing places the new orders first, then cancels the old ones. Each step asks for a wallet signature.</p>}
      <button type="button" className="rfq-btn rfq-btn--lg rfq-btn--primary rfq-btn--block" disabled={!!problem || busy} aria-busy={busy} onClick={submit}>
        {busy ? <><span className="rfq-spinner" />Confirm in your wallet</> : problem ?? action}
      </button>
      {orders.some(order => order !== currentTp && order !== currentSl && !existing.some(leg => leg.pairId && leg.pairId === order.pairId)) && <p className="footnote rfq-faint">Other open orders on {market} are in the Orders tab.</p>}
    </div>
  </Sheet>;
}

/** The ticket's stop trigger: buy stops fire on a rise to the price, sell stops on a fall. */
export function StopTriggerField({ market, side, value, onChange, reduceOnly }: { market: Market; side: Side; value: string; onChange: (value: string) => void; reduceOnly: boolean }) {
  const { snapshot } = useMarketFeed();
  const live = snapshot?.markets[market];
  const trigger = parseUsdcInput(value);
  const problem = live && trigger ? triggerProblem("stop-entry", side, trigger, BigInt(live.mid)) : null;
  const verb = side === "buy" ? (reduceOnly ? "Buys back" : "Buys") : reduceOnly ? "Sells" : "Sells short";
  return <div className="rfq-field">
    <label htmlFor="stop-price">Trigger price <span className="rfq-faint">· good for 30 days</span></label>
    <div className="rfq-field__box"><input id="stop-price" inputMode="decimal" placeholder="0.00" autoComplete="off" value={value} onChange={event => DECIMAL_DRAFT.test(event.target.value) && onChange(event.target.value)} /><span>USD</span></div>
    <span className={`rfq-field__hint${problem ? " is-down" : ""}`}>
      {problem ?? `${verb} at market when the price ${side === "buy" ? "rises" : "falls"} to ${trigger ? usdc(trigger) : "this level"}`}
    </span>
  </div>;
}

/** Order type label, e.g. "Take-profit". */
export const ORDER_TYPE_LABELS: Record<string, string> = { limit: "Limit", "take-profit": "Take-profit", "stop-loss": "Stop-loss", "stop-entry": "Stop" };

/** PnL at a trigger, for the Orders table. */
export const TriggerPnl = ({ order, account }: { order: RestingOrder; account: AccountState | null }) => {
  const position = account?.positions[order.market];
  if (!position || !order.triggerPrice || !order.reduceOnly) return null;
  const size = BigInt(position.size), pnl = pnlAtPrice(size, BigInt(position.entryPrice), BigInt(order.triggerPrice));
  return size === 0n ? null : <div className="caption"><span className="rfq-faint">Est. PnL </span><Change value={pnl}>{signedUsdc(pnl)}</Change></div>;
};

/**
 * Toasts when a resting order fills in the background (a TP/SL or stop firing, a limit crossing),
 * which otherwise happens with no prompt. Orders already filled when the page loads stay quiet.
 */
export function useOrderFillAlerts() {
  const trader = useTrader(), { notify } = useToasts();
  const orders = useOrders(trader.address);
  const seen = useRef<Map<string, string> | null>(null);
  useEffect(() => { seen.current = null; }, [trader.address]);
  useEffect(() => {
    if (!orders.data) return;
    const previous = seen.current;
    seen.current = new Map(orders.data.map(order => [order.orderId, order.status]));
    if (!previous) return;
    for (const order of orders.data) {
      const before = previous.get(order.orderId);
      if (order.status !== "filled" || (before !== "open" && before !== "executing")) continue;
      const label = ORDER_TYPE_LABELS[order.type ?? "limit"] ?? "Order";
      notify({
        kind: "success",
        title: `${order.market} ${label.toLowerCase()} filled`,
        detail: `${order.side === "buy" ? "Bought" : "Sold"} ${baseAmount(abs(BigInt(order.baseDelta)))} ${order.market}${order.triggerPrice ? ` · triggered at ${usdc(order.triggerPrice)}` : ""}`,
        txHash: order.transactionHash,
      });
    }
  }, [orders.data, notify]);
}
