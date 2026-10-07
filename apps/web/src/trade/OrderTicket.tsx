import { useEffect, useMemo, useState } from "react";
import { useTrading } from "../data/actions.js";
import { useMarketFeed, useNow } from "../data/market-feed.js";
import { initialMarginAfter } from "../lib/account.js";
import { baseAmount, microToInput, parseUsdcInput, usdc } from "../lib/format.js";
import { indicativeQuote } from "../lib/quote.js";
import type { AccountState, Market, Side } from "../lib/types.js";
import { sessionCovers } from "../wallet/quick-session.js";
import { useTrader } from "../wallet/trader.js";
import { WalletMenu } from "../wallet/WalletMenu.js";
import { AssetIcon, Tabs } from "../ui/primitives.js";

type OrderType = "market" | "limit";
const SIZE_STEPS = [10, 25, 50, 100] as const;
/** Initial margin for the smallest tier; sizing chips assume it. */
const INITIAL_RATE_BPS = 2_000n;

const DECIMAL_DRAFT = /^\d*\.?\d*$/;
const midDollars = (micro: string) => (Number(BigInt(micro)) / 1e6).toFixed(2);

export function OrderTicket({ market, account }: { market: Market; account: AccountState | null }) {
  const { snapshot } = useMarketFeed();
  const trader = useTrader(), trading = useTrading();
  const now = useNow(500);
  const [side, setSide] = useState<Side>("buy");
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [amount, setAmount] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  useEffect(() => setLimitPrice(""), [market]);

  const live = snapshot?.markets[market];
  const amountMicro = parseUsdcInput(amount);
  const limitMicro = parseUsdcInput(limitPrice);
  const result = useMemo(() => snapshot && amountMicro ? indicativeQuote(snapshot, market, side, amountMicro, now) : null, [snapshot, market, side, amountMicro, now]);
  const quote = result && "quote" in result ? result.quote : null;

  const tradeCap = live ? BigInt(live.operatingMaxTradeNotional) : 0n;
  const buyingPower = account ? BigInt(account.availableMargin) * 10_000n / INITIAL_RATE_BPS : null;
  const maxSize = buyingPower === null ? tradeCap : buyingPower < tradeCap ? (buyingPower > 0n ? buyingPower : 0n) : tradeCap;

  const marginAfter = account && snapshot && amountMicro ? initialMarginAfter(account, snapshot, market, side === "buy" ? amountMicro : -amountMicro) : null;
  const marginShort = account && marginAfter !== null && !reduceOnly && marginAfter > BigInt(account.openingEquity);

  const expected = quote ? BigInt(quote.expectedPrice) : null;
  const limitMarketable = expected !== null && limitMicro !== null && (side === "buy" ? expected <= limitMicro : expected >= limitMicro);
  const limitDistanceBps = expected && limitMicro ? Math.abs(Number(limitMicro) / Number(expected) - 1) * 10_000 : null;
  const quick = orderType === "market" && amountMicro !== null && sessionCovers(trading.quickSession, amountMicro);

  const problem = !amount ? "Enter an amount"
    : amountMicro === null ? "Enter a valid USDC amount"
    : orderType === "limit" && limitMicro === null ? "Enter a limit price"
    : result && "error" in result ? result.error
    : !quote ? "Waiting for prices"
    : null;
  const busy = trading.busy !== null;
  const submit = () => {
    if (!amountMicro) return;
    if (orderType === "market") void trading.marketOrder({ market, side, amountMicro, reduceOnly });
    else void trading.limitOrder({ market, side, amountMicro, reduceOnly, limitPrice: microToInput(limitMicro!) });
  };

  return <article className="panel ticket">
    <header className="ticket-heading">
      <strong><AssetIcon market={market} />{market}-PERP</strong>
      {quick && <span className="quick-badge" title="Signed by your quick-trading session key">Quick</span>}
    </header>

    <div className="side-toggle" role="radiogroup" aria-label="Side">
      {(["buy", "sell"] as const).map(value => <button key={value} type="button" role="radio" aria-checked={side === value} className={`${value} ${side === value ? "active" : ""}`} onClick={() => setSide(value)}>
        {value === "buy" ? "Buy / Long" : "Sell / Short"}
      </button>)}
    </div>

    <Tabs label="Order type" value={orderType} onChange={next => { setOrderType(next); if (next === "limit" && !limitPrice && live) setLimitPrice(midDollars(live.mid)); }}
      tabs={[{ id: "market", label: "Market" }, { id: "limit", label: "Limit" }]} />

    <label className="field">
      <span>Size</span>
      <div className="input"><input inputMode="decimal" placeholder="0.00" value={amount} onChange={event => DECIMAL_DRAFT.test(event.target.value) && setAmount(event.target.value)} /><b>USDC</b></div>
    </label>
    <div className="size-steps" aria-label="Size presets">
      {SIZE_STEPS.map(step => <button key={step} type="button" disabled={maxSize <= 0n} onClick={() => setAmount(microToInput(maxSize * BigInt(step) / 100n / 10_000n * 10_000n))}>{step === 100 ? "Max" : `${step}%`}</button>)}
    </div>

    {orderType === "limit" && <label className="field">
      <span>Limit price <small>Good for 24 hours</small></span>
      <div className="input"><input inputMode="decimal" placeholder="0.00" value={limitPrice} onChange={event => DECIMAL_DRAFT.test(event.target.value) && setLimitPrice(event.target.value)} />
        <button type="button" className="inline" disabled={!live} onClick={() => live && setLimitPrice(midDollars(live.mid))}>Mid</button></div>
    </label>}

    <label className="checkbox"><input type="checkbox" checked={reduceOnly} onChange={event => setReduceOnly(event.target.checked)} /><span>Reduce only<small>Never increase or flip your position</small></span></label>

    <dl className="summary">
      {orderType === "market" ? <>
        <div><dt>Estimated price</dt><dd className="mono">{usdc(quote?.expectedPrice)}</dd></div>
        <div><dt>{side === "buy" ? "Maximum" : "Minimum"} accepted price</dt><dd className="mono">{usdc(quote?.worstPrice)}</dd></div>
      </> : <>
        <div><dt>Current {side === "buy" ? "ask" : "bid"}</dt><dd className="mono">{usdc(quote?.expectedPrice)}</dd></div>
        <div><dt>Trigger</dt><dd className={limitMarketable ? "positive" : ""}>{limitMarketable ? "Marketable now" : limitDistanceBps === null ? "—" : `${limitDistanceBps.toFixed(1)} bps away`}</dd></div>
      </>}
      <div><dt>Size</dt><dd className="mono">{quote?.baseDelta ? `${baseAmount(BigInt(quote.baseDelta) < 0n ? -BigInt(quote.baseDelta) : BigInt(quote.baseDelta))} ${market}` : "—"}</dd></div>
      <div><dt>Fee (max)</dt><dd className="mono">{usdc(quote?.fee)}</dd></div>
      {account && <div><dt>Initial margin after</dt><dd className={`mono ${marginShort ? "negative" : ""}`}>{marginAfter === null ? "—" : usdc(marginAfter)}</dd></div>}
    </dl>

    <details className="price-details">
      <summary>Price details</summary>
      <dl>
        <div><dt>Oracle {side === "buy" ? "ask" : "bid"}</dt><dd className="mono">{usdc(side === "buy" ? quote?.ask : quote?.bid)}</dd></div>
        <div><dt>Adaptive spread</dt><dd className="mono">{quote?.spread ? `${quote.spread.totalBps} bps` : "—"}</dd></div>
        <div><dt>Inventory adjustment</dt><dd className="mono">{usdc(quote?.impactCharge)}</dd></div>
        <div><dt>Price age</dt><dd className="mono">{quote ? `${Math.max(0, now - quote.observedAtMs)} ms` : "—"}</dd></div>
        <div><dt>Max per trade</dt><dd className="mono">{usdc(live?.operatingMaxTradeNotional)}</dd></div>
      </dl>
    </details>

    {marginShort && <p className="notice warn">This trade needs more margin than your account has. Deposit USDC or reduce the size.</p>}
    {trader.address
      ? <button type="button" className={`submit ${side}`} disabled={!!problem || busy} aria-busy={busy} onClick={submit}>
          {busy ? "Submitting…" : problem ?? `${orderType === "limit" ? "Place " : ""}${side === "buy" ? "Buy" : "Sell"} ${market}${orderType === "limit" ? " limit" : ""}`}
        </button>
      : <WalletMenu className="submit connect" />}
  </article>;
}
