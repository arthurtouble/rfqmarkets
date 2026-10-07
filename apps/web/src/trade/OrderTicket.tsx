import { useEffect, useMemo, useState } from "react";
import { useTrading } from "../data/actions.js";
import { useMarketFeed, useNow } from "../data/market-feed.js";
import { initialMarginAfter } from "../lib/account.js";
import { abs, baseAmount, microToInput, parseUsdcInput, usdc } from "../lib/format.js";
import { indicativeQuote } from "../lib/quote.js";
import type { AccountState, Market, Quote, Side } from "../lib/types.js";
import { Banner, Down, Rows, Segmented, Up } from "../ui/primitives.js";
import { useAdvanced } from "../ui/prefs.js";
import { sessionCovers } from "../wallet/quick-session.js";
import { useTrader } from "../wallet/trader.js";
import { WalletMenu } from "../wallet/WalletMenu.js";
import { useFunds } from "./FundsDialog.js";
import { ReviewSheet } from "./ReviewSheet.js";

type OrderType = "market" | "limit";
const PRESETS = [25, 50, 75, 100] as const;
/** Initial margin for the smallest tier; sizing presets assume it. */
const INITIAL_RATE_BPS = 2_000n;
const DECIMAL_DRAFT = /^\d*\.?\d*$/;
const midDollars = (micro: string) => (Number(BigInt(micro)) / 1e6).toFixed(2);
const SIDE_WORD: Record<Side, string> = { buy: "Long", sell: "Short" };

export function OrderTicket({ market, account, side, onSide }: { market: Market; account: AccountState | null; side: Side; onSide: (side: Side) => void }) {
  const { snapshot, status } = useMarketFeed();
  const trader = useTrader(), trading = useTrading(), funds = useFunds(), advanced = useAdvanced();
  const now = useNow(500);
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [amount, setAmount] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [review, setReview] = useState<Quote | null>(null);
  useEffect(() => setLimitPrice(""), [market]);
  useEffect(() => { if (!advanced) { setOrderType("market"); setReduceOnly(false); } }, [advanced]);

  const live = snapshot?.markets[market];
  const amountMicro = parseUsdcInput(amount);
  const limitMicro = parseUsdcInput(limitPrice);
  const result = useMemo(() => snapshot && amountMicro ? indicativeQuote(snapshot, market, side, amountMicro, now) : null, [snapshot, market, side, amountMicro, now]);
  const quote = result && "quote" in result ? result.quote : null;

  const tradeCap = live ? BigInt(live.operatingMaxTradeNotional) : 0n;
  const buyingPower = account ? BigInt(account.availableMargin) * 10_000n / INITIAL_RATE_BPS : null;
  const maxSize = buyingPower === null ? tradeCap : buyingPower < tradeCap ? (buyingPower > 0n ? buyingPower : 0n) : tradeCap;
  const nearCap = amountMicro !== null && tradeCap > 0n && amountMicro > tradeCap;

  const marginAfter = account && snapshot && amountMicro ? initialMarginAfter(account, snapshot, market, side === "buy" ? amountMicro : -amountMicro) : null;
  const marginShort = account && marginAfter !== null && !reduceOnly && marginAfter > BigInt(account.openingEquity);
  const equity = account ? BigInt(account.equity) : 0n;
  const leverageAfter = account && amountMicro && equity > 0n ? Number((BigInt(account.grossNotional) + amountMicro) * 100n / equity) / 100 : null;
  const noFunds = !!account && BigInt(account.collateral) === 0n;

  const expected = quote ? BigInt(quote.expectedPrice) : null;
  const limitMarketable = expected !== null && limitMicro !== null && (side === "buy" ? expected <= limitMicro : expected >= limitMicro);
  const oneClick = orderType === "market" && amountMicro !== null && sessionCovers(trading.quickSession, amountMicro);
  const busy = trading.busy !== null;

  const problem = status !== "live" ? "Waiting for a fresh price"
    : live && !live.enabled ? "Trading paused"
    : live && !reduceOnly && (side === "buy" ? !live.canBuy : !live.canSell) ? `${SIDE_WORD[side]} is closed right now`
    : !amount ? "Enter an amount"
    : amountMicro === null ? "Enter a valid amount"
    : nearCap ? `Up to ${usdc(tradeCap)} per trade`
    : orderType === "limit" && limitMicro === null ? "Enter a limit price"
    : result && "error" in result ? result.error
    : !quote ? "Waiting for a fresh price"
    : marginShort ? "Add funds for this size"
    : null;

  const submit = () => {
    if (!amountMicro || !quote) return;
    if (orderType === "limit") { void trading.limitOrder({ market, side, amountMicro, reduceOnly, limitPrice: microToInput(limitMicro!) }); return; }
    if (oneClick) { void trading.marketOrder({ market, side, amountMicro, reduceOnly }).then(() => setAmount("")); return; }
    setReview(quote);
  };

  const sideClass = side === "buy" ? "long" : "short";
  const label = `${orderType === "limit" ? "Place limit · " : ""}${SIDE_WORD[side]} ${market} · ${usdc(amountMicro)}`;

  return <div className="ticket">
    <div className="rfq-side" role="group" aria-label="Direction">
      <button type="button" className="is-long" aria-pressed={side === "buy"} onClick={() => onSide("buy")}><Up /> Long</button>
      <button type="button" className="is-short" aria-pressed={side === "sell"} onClick={() => onSide("sell")}><Down /> Short</button>
    </div>

    {advanced && <Segmented label="Order type" value={orderType} onChange={next => { setOrderType(next); if (next === "limit" && !limitPrice && live) setLimitPrice(midDollars(live.mid)); }}
      options={[{ id: "market", label: "Market" }, { id: "limit", label: "Limit" }]} />}

    <div className="rfq-amount">
      <label className={`rfq-amount__field${nearCap ? " is-error" : ""}`}>
        <span className="rfq-amount__prefix">$</span>
        <input id={`ticket-amount-${market}`} inputMode="decimal" placeholder="0" autoComplete="off" aria-label="Position size in USDC" value={amount}
          onChange={event => DECIMAL_DRAFT.test(event.target.value) && setAmount(event.target.value)} />
        <span className="rfq-amount__unit">USDC</span>
      </label>
      <div className="rfq-chips" aria-label="Size presets">
        {PRESETS.map(step => <button key={step} type="button" className="rfq-chip" aria-pressed={false} disabled={maxSize <= 0n}
          onClick={() => setAmount(microToInput(maxSize * BigInt(step) / 100n / 10_000n * 10_000n))}>{step === 100 ? "Max" : `${step}%`}</button>)}
      </div>
      <div className={`rfq-amount__meta${nearCap ? " is-error" : ""}`}>
        <span>{account ? <>Available {usdc(account.availableMargin)}</> : <>{live ? `Up to ${usdc(tradeCap)} per trade` : ""}</>}</span>
        <span className="tnum">{quote?.baseDelta ? `≈ ${baseAmount(abs(BigInt(quote.baseDelta)))} ${market}` : ""}</span>
      </div>
    </div>

    {orderType === "limit" && <div className="rfq-field">
      <label htmlFor="limit-price">Limit price <span className="rfq-faint">· good for 24 hours</span></label>
      <div className="rfq-field__box"><input id="limit-price" inputMode="decimal" placeholder="0.00" value={limitPrice} onChange={event => DECIMAL_DRAFT.test(event.target.value) && setLimitPrice(event.target.value)} /><span>USD</span></div>
      <span className="rfq-field__hint">{limitMarketable ? "Fills now at the current price" : "Fills when the price reaches your limit"}</span>
    </div>}

    {advanced && <label className="check-row"><input type="checkbox" checked={reduceOnly} onChange={event => setReduceOnly(event.target.checked)} /><span>Reduce only<span className="footnote rfq-faint"> · never open or grow a position</span></span></label>}

    <Rows rows={[
      [orderType === "limit" ? "Current price" : "Entry price", usdc(quote?.expectedPrice)],
      ["Fee", usdc(quote?.fee)],
      ["Leverage after", leverageAfter === null ? "—" : `${leverageAfter.toFixed(2)}×`],
      ...(advanced ? [
        [side === "buy" ? "Price protection (max)" : "Price protection (min)", usdc(quote?.worstPrice)],
        ["Spread", quote?.spread ? `${quote.spread.totalBps} bps` : "—"],
        ["Inventory adjustment", usdc(quote?.impactCharge)],
        ["Max per trade", usdc(live?.operatingMaxTradeNotional)],
      ] as Array<[string, string]> : []),
    ]} />

    {marginShort && <Banner tone="warning">This size needs more margin than you have. Add funds or lower the amount.</Banner>}

    {!trader.address ? <WalletMenu className="rfq-btn--lg rfq-btn--block" connectLabel="Connect to trade" />
      : noFunds ? <button type="button" className="rfq-btn rfq-btn--lg rfq-btn--primary rfq-btn--block" onClick={() => funds.open("deposit")}>Add funds to trade</button>
      : <button type="button" className={`rfq-btn rfq-btn--lg rfq-btn--block rfq-btn--${problem ? "" : sideClass}`} disabled={!!problem || busy} aria-busy={busy} onClick={submit}>
          {busy ? <><span className="rfq-spinner" />Confirm in your wallet</> : problem ?? label}
        </button>}
    {oneClick && !problem && <p className="footnote rfq-faint ticket-note">One-click trading is on. No wallet prompt.</p>}

    {review && amountMicro && <ReviewSheet market={market} side={side} amountMicro={amountMicro} quote={review} reduceOnly={reduceOnly}
      onClose={() => setReview(null)} onDone={() => { setReview(null); setAmount(""); }} />}
  </div>;
}
