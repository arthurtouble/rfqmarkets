import { useEffect, useMemo, useState } from "react";
import { useTrading } from "../data/actions.js";
import { useMarketFeed, useNow } from "../data/market-feed.js";
import { useMarketLeverage } from "../data/markets.js";
import { emptyAccount, estimateLiquidationPrice, initialMarginAfter } from "../lib/account.js";
import { abs, baseAmount, microToInput, parseUsdcInput, usdc, usdcCompact } from "../lib/format.js";
import { DEFAULT_MARGIN_SCALE_BPS, leveragePresets } from "../lib/leverage.js";
import { STALE_AFTER_MS, indicativeQuote } from "../lib/quote.js";
import { SLIPPAGE_PRESETS_BPS, slippageToPercent } from "../lib/slippage.js";
import { isDecimalDraft, leverageCeiling, leverageLabel, limitMarketable, MARGIN_PROBLEM, maxPay, reducesPosition, positionNotional, presetPay, submitLabel, ticketProblem } from "../lib/ticket.js";
import type { AccountState, Market, Quote, Side } from "../lib/types.js";
import { Banner, Down, Rows, Segmented, Up } from "../ui/primitives.js";
import { useAdvanced } from "../ui/prefs.js";
import { useTrader } from "../wallet/trader.js";
import { WalletMenu } from "../wallet/WalletMenu.js";
import { useFunds } from "./FundsDialog.js";
import { ReviewSheet, type ReviewOrder } from "./ReviewSheet.js";
import { useSlippage, useTicketMemory } from "./ticket-memory.js";

type OrderType = "market" | "limit";
const PAY_PRESETS = [25, 50, 75, 100] as const;
const DEFAULT_LEVERAGE = 5;
const midDollars = (micro: string) => (Number(BigInt(micro)) / 1e6).toFixed(2);

/** The trade form. `onTraded` runs after an order fills or opens (the mobile sheet closes on it). */
export function OrderTicket({ market, account, side, onSide, onTraded }: { market: Market; account: AccountState | null; side: Side; onSide: (side: Side) => void; onTraded?: () => void }) {
  const { snapshot, status } = useMarketFeed();
  const trader = useTrader(), trading = useTrading(), funds = useFunds(), advanced = useAdvanced();
  const now = useNow(500);
  const leverageInfo = useMarketLeverage(market);
  const memory = useTicketMemory(market);
  const [slippageBps, setSlippageBps] = useSlippage();
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [pay, setPay] = useState(memory.initial.pay ?? "");
  const [leverage, setLeverage] = useState(memory.initial.leverage ?? DEFAULT_LEVERAGE);
  const [limitPrice, setLimitPrice] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [review, setReview] = useState<ReviewOrder | null>(null);
  useEffect(() => { setPay(memory.initial.pay ?? ""); setLeverage(memory.initial.leverage ?? DEFAULT_LEVERAGE); setLimitPrice(""); }, [market]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!advanced) { setOrderType("market"); setReduceOnly(false); setOptionsOpen(false); } }, [advanced]);

  const live = snapshot?.markets[market];
  const marketMax = leverageInfo?.maxLeverage ?? live?.maxLeverage ?? 20;
  const scaleBps = leverageInfo?.marginScaleBps ?? live?.marginScaleBps ?? DEFAULT_MARGIN_SCALE_BPS;
  const presets = leverageInfo?.presets ?? leveragePresets(marketMax);
  const lev = Math.min(leverage, marketMax);
  const isLimit = orderType === "limit";
  const effectiveSlippage = advanced ? slippageBps : undefined;

  const payMicro = parseUsdcInput(pay);
  const notional = payMicro ? positionNotional(payMicro, lev) : 0n;
  const signedNotional = side === "buy" ? notional : -notional;
  const limitMicro = parseUsdcInput(limitPrice);
  const result = useMemo(() => snapshot && notional > 0n ? indicativeQuote(snapshot, market, side, notional, now, effectiveSlippage) : null, [snapshot, market, side, notional, now, effectiveSlippage]);
  const quote = result && "quote" in result ? result.quote : null;

  const tradeCap = live ? BigInt(live.operatingMaxTradeNotional) : 0n;
  const feeBps = snapshot?.pricing.feeBps ?? 2;
  const available = account ? BigInt(account.availableMargin) : null;
  const payCeiling = available === null ? null : maxPay({ availableMicro: available, leverage: lev, feeBps, tradeCapMicro: tradeCap, scaleBps });
  const overCap = tradeCap > 0n && notional > tradeCap;
  const ceiling = payMicro ? leverageCeiling(payMicro, marketMax, scaleBps) : marketMax;

  const marginAfter = account && snapshot && notional > 0n ? initialMarginAfter(account, snapshot, market, signedNotional) : null;
  const fee = quote ? BigInt(quote.fee) : 0n;
  const marginShort = !!account && marginAfter !== null && !reduceOnly && marginAfter + fee > BigInt(account.openingEquity);
  const noFunds = !!account && BigInt(account.collateral) === 0n;
  const liquidation = useMemo(() => {
    if (!snapshot || notional === 0n || !payMicro) return null;
    const base = account ?? { ...emptyAccount(trader.address ?? "", snapshot), collateral: payMicro.toString() };
    return estimateLiquidationPrice(base, snapshot, market, signedNotional);
  }, [account, snapshot, market, signedNotional, notional, payMicro, trader.address]);

  const fresh = status === "live" && !!live && now - live.observedAtMs <= STALE_AFTER_MS;
  const position = account?.positions[market];
  const reduces = reduceOnly || (!!position && reducesPosition(BigInt(position.size), BigInt(position.notional), signedNotional));
  const problem = ticketProblem({
    side, priceLive: fresh, enabled: live?.enabled ?? true, reduces, sideOpen: !live || (side === "buy" ? live.canBuy : live.canSell),
    amountText: pay, payMicro, notionalMicro: notional, tradeCapMicro: tradeCap, leverage: lev, leverageCeiling: ceiling,
    isLimit, limitMicro, quoteError: result && "error" in result ? result.error : null, hasQuote: !!quote, marginShort,
  });
  const marketable = isLimit && quote && limitMicro !== null && limitMarketable(side, BigInt(quote.expectedPrice), limitMicro);
  const oneClick = !isLimit && notional > 0n && trading.quickCovers(market, notional);
  const busy = trading.busy !== null;

  const choosePay = (text: string) => { if (isDecimalDraft(text)) { setPay(text); memory.save({ pay: text }); } };
  const chooseLeverage = (next: number) => { setLeverage(next); memory.save({ leverage: next }); };

  const order = (): ReviewOrder => ({ market, side, amountMicro: notional, payMicro: payMicro!, leverage: lev, reduceOnly, slippageBps: effectiveSlippage });
  const traded = () => { choosePay(""); onTraded?.(); };
  const submit = async () => {
    if (!payMicro || problem) return;
    if (isLimit) {
      if (await trading.limitOrder({ market, side, amountMicro: notional, reduceOnly, limitPrice: microToInput(limitMicro!) })) traded();
      return;
    }
    if (oneClick) {
      if (await trading.marketOrder(order())) traded();
      return;
    }
    setReview(order());
  };

  const sideClass = side === "buy" ? "long" : "short";
  const meta = overCap
    ? <span>Up to {usdc(tradeCap * 100n / BigInt(Math.round(lev * 100)))} at {leverageLabel(lev)} per trade</span>
    : account ? <span>Available {usdc(account.availableMargin)}</span>
    : <span>{live ? `Positions up to ${usdc(tradeCap)} per trade` : ""}</span>;

  return <div className="ticket">
    <div className="rfq-side" role="group" aria-label="Direction">
      <button type="button" className="is-long" aria-pressed={side === "buy"} onClick={() => onSide("buy")}><Up /> Long</button>
      <button type="button" className="is-short" aria-pressed={side === "sell"} onClick={() => onSide("sell")}><Down /> Short</button>
    </div>

    {advanced && <Segmented label="Order type" value={orderType} onChange={next => { setOrderType(next); if (next === "limit" && !limitPrice && live) setLimitPrice(midDollars(live.mid)); }}
      options={[{ id: "market", label: "Market" }, { id: "limit", label: "Limit" }]} />}

    <div className="rfq-amount">
      <label className={`rfq-amount__field${overCap ? " is-error" : ""}`}>
        <span className="rfq-amount__prefix">$</span>
        <input id={`ticket-amount-${market}`} inputMode="decimal" placeholder="0" autoComplete="off" aria-label="Amount to pay in USDC" value={pay}
          onChange={event => choosePay(event.target.value)} />
        <span className="rfq-amount__unit">USDC</span>
      </label>
      {account && <div className="rfq-chips" aria-label="Amount presets">
        {PAY_PRESETS.map(step => {
          const value = payCeiling === null ? 0n : presetPay(payCeiling, step);
          return <button key={step} type="button" className="rfq-chip" aria-pressed={payMicro !== null && value > 0n && payMicro === value} disabled={value <= 0n}
            onClick={() => choosePay(microToInput(value))}>{step === 100 ? "Max" : `${step}%`}</button>;
        })}
      </div>}
      <div className={`rfq-amount__meta${overCap ? " is-error" : ""}`}>{meta}</div>
    </div>

    <div className="ticket-leverage">
      <div className="ticket-leverage__head">
        <span className="callout rfq-muted">Leverage</span>
        <span className="footnote rfq-faint tnum" aria-live="polite">{notional > 0n ? <>Position {usdcCompact(notional)}{quote?.baseDelta ? ` · ${baseAmount(abs(BigInt(quote.baseDelta)))} ${market}` : ""}</> : `Up to ${leverageLabel(marketMax)}`}</span>
      </div>
      <Segmented label="Leverage" value={String(lev)} onChange={next => chooseLeverage(Number(next))}
        options={presets.map(step => ({ id: String(step), label: leverageLabel(step) }))} />
    </div>

    {isLimit && <div className="rfq-field">
      <label htmlFor={`limit-price-${market}`}>Limit price <span className="rfq-faint">· good for 24 hours</span></label>
      <div className="rfq-field__box"><input id={`limit-price-${market}`} inputMode="decimal" placeholder="0.00" autoComplete="off" value={limitPrice} onChange={event => isDecimalDraft(event.target.value) && setLimitPrice(event.target.value)} /><span>USD</span></div>
      <span className="rfq-field__hint">{marketable ? "Fills now at the current price" : "Fills when the price reaches your limit"}</span>
    </div>}

    {advanced && <div className="ticket-options">
      <button type="button" className="rfq-linkrow" aria-expanded={optionsOpen} onClick={() => setOptionsOpen(open => !open)}>
        Options <span>{[reduceOnly ? "Reduce only" : null, isLimit ? null : `Slippage ${slippageToPercent(slippageBps)}%`].filter(Boolean).join(" · ") || "None"}</span>
      </button>
      {optionsOpen && <div className="ticket-options__body">
        <label className="check-row"><input type="checkbox" checked={reduceOnly} onChange={event => setReduceOnly(event.target.checked)} /><span>Reduce only<span className="footnote rfq-faint"> · never opens or grows a position</span></span></label>
        {!isLimit && <div className="ticket-options__slippage">
          <span className="callout rfq-muted">Max slippage</span>
          <Segmented label="Max slippage" value={String(slippageBps)} onChange={next => setSlippageBps(Number(next))}
            options={SLIPPAGE_PRESETS_BPS.map(bps => ({ id: String(bps), label: `${slippageToPercent(bps)}%` }))} />
        </div>}
      </div>}
    </div>}

    <Rows rows={[
      [isLimit ? "Current price" : "Entry price", usdc(quote?.expectedPrice)],
      ["Liquidation price", liquidation === null ? "—" : usdc(liquidation)],
      ["Fee", usdc(quote?.fee)],
      ...(advanced && !isLimit ? [[side === "buy" ? "Price protection (max)" : "Price protection (min)", usdc(quote?.worstPrice)]] as Array<[string, string]> : []),
    ]} />

    {marginShort && <Banner tone="warning">This trade needs more margin than you have. Add funds, lower the amount or the leverage.</Banner>}

    {!trader.address ? <WalletMenu className="rfq-btn--lg rfq-btn--block" connectLabel="Connect to trade" />
      : noFunds ? <button type="button" className="rfq-btn rfq-btn--lg rfq-btn--primary rfq-btn--block" onClick={() => funds.open("deposit")}>Add funds to trade</button>
      : problem === MARGIN_PROBLEM ? <button type="button" className="rfq-btn rfq-btn--lg rfq-btn--primary rfq-btn--block" onClick={() => funds.open("deposit")}>Add funds</button>
      : <button type="button" className={`rfq-btn rfq-btn--lg rfq-btn--block rfq-btn--${problem ? "" : sideClass}`} disabled={!!problem || busy} aria-busy={busy} onClick={() => void submit()}>
          {busy ? <><span className="rfq-spinner" />{oneClick ? "Placing trade" : "Confirm in your wallet"}</> : problem ?? submitLabel({ side, market, pay: usdcCompact(payMicro), leverage: lev, isLimit })}
        </button>}
    {oneClick && !problem && <p className="footnote rfq-faint ticket-note">One-click trading is on. No wallet prompt.</p>}

    {review && <ReviewSheet order={review} onClose={() => setReview(null)} onDone={() => { setReview(null); traded(); }} />}
  </div>;
}
